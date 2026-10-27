//! The streaming query path — the core data flow of the app.
//!
//! [`query_run`] enforces the SQL guard, then spawns a detached task that
//! streams result-set events to the frontend over a `tauri::ipc::Channel`. The
//! command returns a [`QueryHandle`] immediately (it does **not** await the
//! task), so the UI gets the cancellation handle before the first row arrives.
//!
//! ## Cancellation
//! [`query_cancel`] flips the [`CancelToken`]; the core races every blocking
//! await against it ([`CancelToken::bound`]), so the run stops promptly even
//! while the server has not produced a row yet (long aggregate, blocked on a
//! lock). A cancel abandons the wire conversation mid-stream, so afterwards the
//! session's connection is **replaced** ([`refresh_session_connection`]):
//! dropping the old socket is what makes the server abort the in-flight query,
//! and the fresh connection (with the session's database context restored)
//! keeps the session usable without the UI noticing. If the reconnect fails the
//! session is closed and `session:lost` is emitted — the same recovery flow the
//! health heartbeat uses.

use std::time::Instant;

use async_trait::async_trait;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State};

use selene_core::{
    classify, classify_for, CancelToken, CellValue, Column, DriverId, ExecOptions, Flow,
    GuardLevel, GuardVerdict, RowSink,
};

use crate::commands::QueryEvent;
use crate::error::IpcError;
use crate::state::{new_id, AppState, SessionEntry, SessionHandle};

/// Default cap on rows streamed when the caller does not specify `maxRows`.
/// Mirrors [`ExecOptions::default`]'s cap so behaviour is consistent whether or
/// not the frontend passes a limit.
const DEFAULT_MAX_ROWS: u64 = 50_000;

/// Rows buffered per batch before flushing to the channel. A batch is also the
/// granularity at which cooperative cancellation is observed.
const BATCH_SIZE: usize = 500;

/// Returned by [`query_run`]: the id used to [`query_cancel`] this run. Result
/// data arrives asynchronously on the `Channel`, not in this return value.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryHandle {
    /// Opaque id for the in-flight query; pass to `query_cancel`.
    pub query_id: String,
}

/// A [`RowSink`] that forwards driver events to the frontend as [`QueryEvent`]s
/// over a `tauri::ipc::Channel`.
///
/// If a `channel.send` fails — which happens when the webview/listener has gone
/// away (window closed, listener dropped) — there is no point producing more
/// rows, so the sink returns [`Flow::Stop`] to wind the query down promptly.
///
/// The `Channel` is a concrete type, so the sink needs no runtime generic and
/// stays trivially `Send` (which `RowSink` requires).
struct ChannelSink {
    channel: Channel<QueryEvent>,
}

impl ChannelSink {
    fn new(channel: Channel<QueryEvent>) -> Self {
        Self { channel }
    }

    /// Send one event; map a transport failure (listener gone) to `Flow::Stop`.
    fn forward(&self, event: QueryEvent) -> Flow {
        match self.channel.send(event) {
            Ok(()) => Flow::Continue,
            Err(_) => Flow::Stop,
        }
    }
}

#[async_trait]
impl RowSink for ChannelSink {
    async fn on_meta(&mut self, set_index: usize, columns: Vec<Column>) -> Flow {
        self.forward(QueryEvent::Meta { set_index, columns })
    }

    async fn on_rows(&mut self, set_index: usize, rows: Vec<Vec<CellValue>>) -> Flow {
        self.forward(QueryEvent::Rows { set_index, rows })
    }

    async fn on_set_end(&mut self, set_index: usize, affected: Option<u64>) -> Flow {
        self.forward(QueryEvent::SetEnd {
            set_index,
            affected,
        })
    }
}

/// Classify a query for safety. A thin wrapper over the core guard;
/// `read_only` reflects the connection's safety toggle. Pure and synchronous,
/// but exposed as a command so the editor can show a warning before the user
/// runs anything.
///
/// `driver` makes the advisory pre-check driver-aware: a MongoDB tab passes its
/// driver so mongosh method calls pre-flight through the Mongo classifier
/// ([`classify_for`]) rather than the SQL one. When it is omitted (e.g. the
/// SQL-only multi-target caller), the check falls back to [`classify`]. The
/// **authoritative** guard is still enforced server-side in [`query_run`],
/// which is likewise driver-aware.
#[tauri::command]
pub async fn guard_check(
    sql: String,
    read_only: bool,
    driver: Option<DriverId>,
) -> Result<GuardVerdict, IpcError> {
    Ok(match driver {
        Some(d) => classify_for(d, &sql, read_only),
        None => classify(&sql, read_only),
    })
}

/// Run a SQL batch, streaming results to the frontend over `on_event`.
///
/// Flow:
/// 1. Look up the session; enforce the SQL guard using the session's cached
///    `read_only` flag. A [`GuardLevel::Block`] verdict returns an error and
///    the query never runs.
/// 2. Mint a `query_id` + [`CancelToken`], register the token, and emit
///    `Started`.
/// 3. Spawn a detached task that locks the session, runs
///    [`Connection::execute`](selene_core::Connection::execute) into a
///    [`ChannelSink`], and emits `Finished` / `Cancelled` / `Failed`, then
///    deregisters the token.
/// 4. Return the [`QueryHandle`] immediately.
#[tauri::command]
pub async fn query_run<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    max_rows: Option<u64>,
    on_event: Channel<QueryEvent>,
) -> Result<QueryHandle, IpcError> {
    // (1) Resolve the session's driver + read-only flag (cheaply, without holding
    //     the lock for the whole query) and enforce the guard up front. The
    //     driver selects the classifier: MongoDB queries are mongosh method calls,
    //     not SQL, so `classify_for` routes them through the Mongo guard.
    let (driver, read_only) = {
        let session = state.sessions.get(&session_id)?;
        let session = session.lock().await;
        (session.driver, session.read_only)
    };

    let verdict = classify_for(driver, &sql, read_only);
    if verdict.level == GuardLevel::Block {
        tracing::warn!(%session_id, "query blocked by SQL guard");
        return Err(IpcError::blocked(&verdict.reasons));
    }

    // (2) Register a cancellation token and announce the query.
    let query_id = new_id();
    let cancel = CancelToken::new();
    state
        .running
        .lock()
        .expect("running-queries mutex poisoned")
        .insert(query_id.clone(), cancel.clone());

    if on_event
        .send(QueryEvent::Started {
            query_id: query_id.clone(),
        })
        .is_err()
    {
        // The listener is already gone; nothing to run. Clean up the token.
        state
            .running
            .lock()
            .expect("running-queries mutex poisoned")
            .remove(&query_id);
        tracing::info!(%query_id, "query listener gone before start; aborting");
        return Ok(QueryHandle { query_id });
    }

    tracing::info!(%session_id, %query_id, "query started");

    // (3) Spawn the streaming task. It owns a clone of the `AppHandle` and
    //     re-acquires `AppState` inside, so nothing borrows the command's
    //     short-lived `State`.
    let task_query_id = query_id.clone();
    tauri::async_runtime::spawn(async move {
        run_query_task::<R>(
            app,
            session_id,
            sql,
            max_rows,
            on_event,
            cancel,
            task_query_id,
        )
        .await;
    });

    // (4) Hand the cancellation id back without awaiting the task.
    Ok(QueryHandle { query_id })
}

/// The detached body of a `query_run`: execute, stream, and emit a terminal
/// event. Always deregisters the cancellation token before returning.
#[allow(clippy::too_many_arguments)]
async fn run_query_task<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    sql: String,
    max_rows: Option<u64>,
    on_event: Channel<QueryEvent>,
    cancel: CancelToken,
    query_id: String,
) {
    use tauri::Manager;
    let state = app.state::<AppState>();

    let opts = ExecOptions {
        max_rows: max_rows.or(Some(DEFAULT_MAX_ROWS)),
        batch_size: BATCH_SIZE,
    };

    let started = Instant::now();
    let mut sink = ChannelSink::new(on_event.clone());

    // Lock only *this* session for the duration of the query. Concurrent
    // queries on the same session serialize here; other sessions (and new
    // connects) are unaffected.
    let result = match state.sessions.get(&session_id) {
        Ok(handle) => {
            let mut session = handle.lock().await;
            let result = session.conn.execute(&sql, &opts, &mut sink, &cancel).await;
            if matches!(result, Err(selene_core::CoreError::Cancelled)) {
                // The cancel abandoned the wire conversation mid-stream: the
                // server may still be executing and the connection's protocol
                // state is undefined. Replace it (still under the session lock,
                // so nothing can touch the dead connection first).
                refresh_session_connection(&app, &handle, &mut session, &session_id).await;
            }
            result
        }
        Err(_) => Err(selene_core::CoreError::Config(format!(
            "session '{session_id}' disconnected before the query ran"
        ))),
    };

    let elapsed_ms = started.elapsed().as_millis() as u64;

    // Emit the terminal event. A cancelled run is reported as `Cancelled` even
    // though the core surfaces it as `CoreError::Cancelled`, so the UI can
    // distinguish a user cancel from a real failure.
    let terminal = match result {
        Ok(outcome) => {
            tracing::info!(
                %query_id,
                result_sets = outcome.result_sets,
                total_rows = outcome.total_rows,
                truncated = outcome.truncated,
                elapsed_ms,
                "query finished"
            );
            QueryEvent::Finished {
                outcome,
                elapsed_ms,
            }
        }
        Err(selene_core::CoreError::Cancelled) => {
            tracing::info!(%query_id, elapsed_ms, "query cancelled");
            QueryEvent::Cancelled
        }
        Err(err) => {
            let ipc: IpcError = err.into();
            tracing::warn!(%query_id, kind = %ipc.kind, "query failed");
            QueryEvent::Failed {
                message: ipc.message,
            }
        }
    };
    // Ignore a send error here: if the listener is gone there is nothing to do.
    let _ = on_event.send(terminal);

    // Always deregister the token so `running` does not leak entries.
    state
        .running
        .lock()
        .expect("running-queries mutex poisoned")
        .remove(&query_id);
}

/// Rebuild a session's connection after a cancelled query.
///
/// Reconnects from the originating spec (password via the in-process secret
/// cache — no keychain prompt) and restores the session's last known database.
/// Replacing `conn` drops the old connection, whose closing socket makes the
/// server abort the still-running query. If the reconnect fails the session is
/// removed and `session:lost` is emitted, reusing the health heartbeat's
/// recovery flow (the UI offers a reconnect).
///
/// `entry` is the locked session behind `handle`. If the session was
/// disconnected while the query ran, there is nothing to repair: the orphaned
/// connection is closed when the last handle drops.
async fn refresh_session_connection<R: Runtime>(
    app: &AppHandle<R>,
    handle: &SessionHandle,
    entry: &mut SessionEntry,
    session_id: &str,
) {
    use tauri::{Emitter, Manager};
    let state = app.state::<AppState>();

    if !state.sessions.is_current(session_id, handle) {
        return;
    }
    let connection_id = entry.connection_id.clone();
    let current_database = entry.current_database.clone();

    let fresh = async {
        let spec = state.store.get(&connection_id)?.ok_or_else(|| {
            selene_core::CoreError::Config(format!("connection '{connection_id}' no longer exists"))
        })?;
        let secret = state.cached_secret(&connection_id)?.ok_or_else(|| {
            selene_core::CoreError::Config(format!(
                "no cached password for connection '{connection_id}'"
            ))
        })?;
        let mut conn = selene_core::driver_for(spec.driver)?
            .connect(&spec, &secret)
            .await?;
        // Best-effort: restore the database the session was using (a fresh
        // connection starts at the spec's default). A failure here (e.g. the
        // database was dropped meanwhile) still leaves a usable connection.
        if let Some(db) = current_database.as_deref() {
            if let Err(err) = conn.use_database(db).await {
                tracing::warn!(%session_id, "could not restore database after cancel: {err}");
            }
        }
        Ok::<_, selene_core::CoreError>(conn)
    }
    .await;

    match fresh {
        Ok(conn) => {
            entry.conn = conn;
            tracing::info!(%session_id, "connection replaced after cancelled query");
        }
        Err(err) => {
            tracing::warn!(%session_id, "reconnect after cancelled query failed: {err}; closing session");
            // Only report the loss if the session was still registered (a
            // disconnect meanwhile already tore it down on the frontend).
            if !state.sessions.remove_if_current(session_id, handle) {
                return;
            }
            let _ = app.emit(
                "session:lost",
                super::health::SessionLost {
                    session_id: session_id.to_string(),
                    connection_id,
                },
            );
        }
    }
}

/// Request cancellation of an in-flight query.
///
/// Looks up the query's [`CancelToken`] and flips it; the core observes it
/// immediately (its blocking awaits race against the token) and the task ends
/// with a `Cancelled` event, after which the session's connection is replaced
/// so the server-side query is really aborted. Cancelling an unknown or
/// already-finished `query_id` is a no-op.
#[tauri::command]
pub async fn query_cancel(state: State<'_, AppState>, query_id: String) -> Result<(), IpcError> {
    let token = state
        .running
        .lock()
        .expect("running-queries mutex poisoned")
        .get(&query_id)
        .cloned();
    match token {
        Some(token) => {
            token.cancel();
            tracing::info!(%query_id, "query cancel requested");
        }
        None => {
            tracing::info!(%query_id, "query cancel for unknown/finished query (no-op)");
        }
    }
    Ok(())
}
