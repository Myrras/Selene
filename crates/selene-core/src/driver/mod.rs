//! The driver abstraction — the contract every backend implements and the rest
//! of Selene depends on.
//!
//! Design notes:
//! - Row *production* (the driver) is decoupled from row *transport* (the Tauri
//!   `Channel`) via [`RowSink`], so the core stays UI-agnostic and unit-testable
//!   with an in-memory sink.
//! - Dispatch is dynamic (`Box<dyn Connection>`): the connection registry holds
//!   heterogeneous live connections uniformly. Cargo *features* gate which
//!   drivers are *compiled*; `dyn` decides which is *selected* at runtime.
//! - Cancellation is a [`CancelToken`]: drivers check it between row batches
//!   *and* race their blocking awaits against it via [`CancelToken::bound`], so
//!   a cancel interrupts even a query the server has not answered yet. The
//!   Tauri layer then replaces the abandoned connection (closing the socket is
//!   what makes the server abort the in-flight query).

use std::future::Future;
use std::pin::pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Poll, Waker};

use serde::{Deserialize, Serialize};

use crate::backup::{
    BackupFile, BackupOptions, DbFile, DefaultDirs, FileMove, RestoreOptions, ServerDirEntry,
};
use crate::capabilities::DriverCapabilities;
use crate::connection_spec::{ConnectionSpec, DriverId};
use crate::error::CoreError;
use crate::introspect::{ColumnInfo, DatabaseInfo, SchemaInfo, TableInfo};
use crate::secret::Secret;
use crate::value::{CellValue, Column};

#[cfg(feature = "mssql")]
pub mod mssql;

// Shared sqlx helpers (streaming pump, param sub-batching, value formatting)
// reused by every sqlx-backed driver. Compiled whenever at least one of them is.
#[cfg(any(feature = "postgres", feature = "mysql", feature = "sqlite"))]
mod shared;

#[cfg(feature = "mysql")]
pub mod mysql;

#[cfg(feature = "postgres")]
pub mod postgres;

#[cfg(feature = "sqlite")]
pub mod sqlite;

#[cfg(feature = "mongodb")]
pub mod mongodb;

/// Whether a [`RowSink`] wants more data or has seen enough (cancel / row cap).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flow {
    /// Keep streaming.
    Continue,
    /// Stop producing rows; the driver should end the stream promptly.
    Stop,
}

/// A cheap, cloneable cooperative-cancellation flag.
///
/// The driver checks [`is_cancelled`](Self::is_cancelled) between row batches
/// and races its blocking awaits against the token via [`bound`](Self::bound),
/// so a cancel also interrupts a query that is parked waiting on the server
/// (no rows flowing yet — the case a flag-only token could never observe).
///
/// Implemented with a plain waker list instead of `tokio::sync::Notify` so the
/// token stays dependency-free in every feature combination.
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<CancelInner>);

/// Shared state behind a [`CancelToken`]: the flag plus the wakers of tasks
/// currently parked in [`CancelToken::cancelled`].
#[derive(Debug, Default)]
struct CancelInner {
    cancelled: AtomicBool,
    wakers: Mutex<Vec<Waker>>,
}

impl CancelToken {
    /// Create a fresh, un-cancelled token.
    pub fn new() -> Self {
        Self::default()
    }

    /// Request cancellation. Idempotent. Wakes every task parked in
    /// [`cancelled`](Self::cancelled) / [`bound`](Self::bound).
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
        let wakers = std::mem::take(
            &mut *self
                .0
                .wakers
                .lock()
                .expect("cancel waker list mutex poisoned"),
        );
        for waker in wakers {
            waker.wake();
        }
    }

    /// Whether cancellation has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    /// Resolve once cancellation is requested (immediately if it already was).
    pub fn cancelled(&self) -> impl Future<Output = ()> + '_ {
        std::future::poll_fn(move |cx| {
            if self.is_cancelled() {
                return Poll::Ready(());
            }
            {
                let mut wakers = self
                    .0
                    .wakers
                    .lock()
                    .expect("cancel waker list mutex poisoned");
                // A long-lived await polls this many times; don't grow the list
                // with clones of the same task's waker.
                if !wakers.iter().any(|w| w.will_wake(cx.waker())) {
                    wakers.push(cx.waker().clone());
                }
            }
            // Re-check after registering: a `cancel()` racing in between has
            // already drained the list and would otherwise never wake us.
            if self.is_cancelled() {
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        })
    }

    /// Await `fut`, aborting with [`CoreError::Cancelled`] the moment this
    /// token fires (checked first, so a pre-cancelled token never polls `fut`).
    ///
    /// On cancellation `fut` is dropped mid-flight, which abandons whatever
    /// wire conversation it was in — the caller owns cleaning up the underlying
    /// connection (drop it, or reconnect) before reusing it.
    pub async fn bound<F: Future>(&self, fut: F) -> Result<F::Output, CoreError> {
        let mut fut = pin!(fut);
        let mut cancelled = pin!(self.cancelled());
        std::future::poll_fn(move |cx| {
            if cancelled.as_mut().poll(cx).is_ready() {
                return Poll::Ready(Err(CoreError::Cancelled));
            }
            fut.as_mut().poll(cx).map(Ok)
        })
        .await
    }
}

/// Options controlling a single query execution.
#[derive(Clone, Debug)]
pub struct ExecOptions {
    /// Hard cap on rows returned across all result sets; protects against an
    /// accidental unbounded `SELECT *`. `None` means unlimited.
    pub max_rows: Option<u64>,
    /// How many rows to buffer before flushing a batch to the sink.
    pub batch_size: usize,
}

impl Default for ExecOptions {
    fn default() -> Self {
        Self {
            max_rows: Some(50_000),
            batch_size: 500,
        }
    }
}

/// Summary of a completed execution.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecOutcome {
    /// Number of result sets produced.
    pub result_sets: usize,
    /// Total rows delivered to the sink.
    pub total_rows: u64,
    /// True if `max_rows` was hit and rows were dropped.
    pub truncated: bool,
    /// True if the batch was a rollback-wrapped dry-run
    /// (`BEGIN TRAN; <DML …>; ROLLBACK`). The reported affected-row counts
    /// reflect what *would* have changed; nothing was committed. Lets the UI
    /// label the result as rolled back rather than applied.
    pub rolled_back: bool,
}

/// Result of a connectivity test.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TestReport {
    /// Server version string, if obtained.
    pub server_version: Option<String>,
    /// Round-trip time of the test, in milliseconds.
    pub elapsed_ms: u64,
}

/// Receives streamed result-set events from a driver. The Tauri layer
/// implements this over a `Channel`; tests implement it over a `Vec`.
#[async_trait::async_trait]
pub trait RowSink: Send {
    /// Column metadata for result set `set_index` (a new index ⇒ a new set).
    async fn on_meta(&mut self, set_index: usize, columns: Vec<Column>) -> Flow;
    /// A batch of rows for result set `set_index`.
    async fn on_rows(&mut self, set_index: usize, rows: Vec<Vec<CellValue>>) -> Flow;
    /// Result set `set_index` finished; `affected` is the row count for DML.
    async fn on_set_end(&mut self, set_index: usize, affected: Option<u64>) -> Flow;
}

/// Supplies typed rows to an import — the mirror of [`RowSink`].
///
/// A driver's import path *pulls* batches of rows (already coerced to the
/// destination columns' types and in destination-column order) and inserts them.
/// An empty batch signals the source is exhausted. A returned error aborts the
/// import (and, in a transactional import, triggers a rollback). The CSV
/// implementation lives in [`crate::import::CsvRowSource`].
#[async_trait::async_trait]
pub trait RowSource: Send {
    /// The next batch of rows in destination-column order. An empty `Vec` means
    /// the source is exhausted.
    async fn next_batch(&mut self) -> Result<Vec<Vec<CellValue>>, CoreError>;
}

/// Identifies an existing table to import rows into.
#[derive(Clone, Debug)]
pub struct ImportTarget {
    /// Target database (the connection's current database when `None`).
    pub database: Option<String>,
    /// Target schema (e.g. `dbo`).
    pub schema: String,
    /// Target table name.
    pub table: String,
    /// Destination column names, ordered to match each source row's cells.
    pub columns: Vec<String>,
}

/// One column of a table to be created by [`Connection::create_table`].
#[derive(Clone, Debug)]
pub struct NewColumn {
    /// Column name.
    pub name: String,
    /// A backend DDL type fragment, e.g. `"INT"`, `"NVARCHAR(255)"`,
    /// `"DECIMAL(38,10)"`. Drivers validate this before splicing it into DDL.
    pub sql_type: String,
    /// Whether the column permits `NULL`.
    pub nullable: bool,
}

/// A live connection to a database. Not `Sync`: a connection is driven from one
/// task at a time (the pool hands out exclusive access).
#[async_trait::async_trait]
pub trait Connection: Send {
    /// Execute `sql`, streaming rows to `sink`. Honours `cancel` cooperatively.
    async fn execute(
        &mut self,
        sql: &str,
        opts: &ExecOptions,
        sink: &mut dyn RowSink,
        cancel: &CancelToken,
    ) -> Result<ExecOutcome, CoreError>;

    /// List databases on the server.
    async fn list_databases(&mut self) -> Result<Vec<DatabaseInfo>, CoreError>;

    /// List schemas in `database`.
    async fn list_schemas(&mut self, database: &str) -> Result<Vec<SchemaInfo>, CoreError>;

    /// List tables and views in `database`.`schema`.
    async fn list_tables(
        &mut self,
        database: &str,
        schema: &str,
    ) -> Result<Vec<TableInfo>, CoreError>;

    /// List columns of `database`.`schema`.`table`.
    async fn list_columns(
        &mut self,
        database: &str,
        schema: &str,
        table: &str,
    ) -> Result<Vec<ColumnInfo>, CoreError>;

    /// Lightweight liveness check; drives reconnect UX.
    async fn ping(&mut self) -> Result<(), CoreError>;

    /// Return the name of the currently active database for this connection.
    /// Returns an empty string if the driver does not support this concept.
    async fn current_database(&mut self) -> Result<String, CoreError> {
        Ok(String::new())
    }

    /// Switch to `database` as the active database for this connection.
    async fn use_database(&mut self, _database: &str) -> Result<(), CoreError> {
        Err(CoreError::Unsupported(
            "use_database is not supported by this driver".into(),
        ))
    }

    /// Create a new database named `database`. Drivers must bracket/quote the
    /// identifier (the name comes from user input).
    async fn create_database(&mut self, _database: &str) -> Result<(), CoreError> {
        Err(CoreError::Unsupported(
            "create_database is not supported by this driver".into(),
        ))
    }

    /// Drop the database named `database`. Drivers must bracket/quote the
    /// identifier (the name comes from user input). Fails if the database is in
    /// use by other connections.
    async fn drop_database(&mut self, _database: &str) -> Result<(), CoreError> {
        Err(CoreError::Unsupported(
            "drop_database is not supported by this driver".into(),
        ))
    }

    /// Rename a database from `from` to `to`. Drivers must bracket/quote both
    /// identifiers (the names come from user input).
    ///
    /// With `force == false` the rename must **fail fast** rather than block
    /// indefinitely when the database is in use, returning
    /// [`CoreError::DatabaseInUse`] so the caller can offer a forced retry.
    /// With `force == true` the driver forcibly disconnects other sessions to
    /// complete the rename (rolling back their in-flight transactions).
    async fn rename_database(
        &mut self,
        _from: &str,
        _to: &str,
        _force: bool,
    ) -> Result<(), CoreError> {
        Err(CoreError::Unsupported(
            "rename_database is not supported by this driver".into(),
        ))
    }

    /// Bring `database` online (`online = true`) or take it offline
    /// (`online = false`). Taking a database offline terminates all other
    /// connections to it. Drivers must bracket/quote the identifier.
    async fn set_database_online(
        &mut self,
        _database: &str,
        _online: bool,
    ) -> Result<(), CoreError> {
        Err(CoreError::Unsupported(
            "set_database_online is not supported by this driver".into(),
        ))
    }

    /// Create a table from a column spec (for "import as new table"). Drivers
    /// must bracket/quote every identifier and validate each `sql_type`.
    async fn create_table(
        &mut self,
        _database: Option<&str>,
        _schema: &str,
        _table: &str,
        _columns: &[NewColumn],
        _cancel: &CancelToken,
    ) -> Result<(), CoreError> {
        Err(CoreError::Unsupported(
            "create_table is not supported by this driver".into(),
        ))
    }

    /// Drop the table identified by `database`/`schema`/`table`. Drivers must
    /// bracket/quote every identifier (the names come from user input). Used by
    /// the import flow's "replace existing" recovery: after an explicit,
    /// confirmed retry the caller drops the half-created table before
    /// re-running [`create_table`](Self::create_table).
    async fn drop_table(
        &mut self,
        _database: Option<&str>,
        _schema: &str,
        _table: &str,
        _cancel: &CancelToken,
    ) -> Result<(), CoreError> {
        Err(CoreError::Unsupported(
            "drop_table is not supported by this driver".into(),
        ))
    }

    /// Insert rows pulled from `source` into `target` using **bound
    /// parameters** (never spliced values). When `atomic`, the whole import runs
    /// in a transaction and any error rolls it back; otherwise each batch commits
    /// as it lands. Returns the number of rows inserted. `batch_size` is the
    /// caller's desired rows-per-statement (drivers may sub-batch to respect
    /// parameter limits). Honours `cancel` between batches.
    async fn import_rows(
        &mut self,
        _target: &ImportTarget,
        _source: &mut dyn RowSource,
        _atomic: bool,
        _batch_size: usize,
        _cancel: &CancelToken,
    ) -> Result<u64, CoreError> {
        Err(CoreError::Unsupported(
            "import_rows is not supported by this driver".into(),
        ))
    }

    /// Back up `database` to the server-side file `to_path` (a path on the
    /// **database server's** filesystem, not the client's). Honours `cancel`
    /// only cooperatively via the hard-stop the Tauri layer issues (the backup
    /// is a single statement); progress is observed out-of-band by polling
    /// [`backup_percent_complete`](Self::backup_percent_complete). Drivers must
    /// bracket-quote the database name and escape `to_path` as a string literal.
    async fn backup_database(
        &mut self,
        _database: &str,
        _to_path: &str,
        _opts: &BackupOptions,
        _cancel: &CancelToken,
    ) -> Result<(), CoreError> {
        Err(CoreError::Unsupported(
            "backup_database is not supported by this driver".into(),
        ))
    }

    /// List the logical files contained in the backup at `from_path`
    /// (`RESTORE FILELISTONLY`). Used to preview a `.bak` and to plan `MOVE`
    /// relocations for a restore.
    async fn restore_filelist(&mut self, _from_path: &str) -> Result<Vec<BackupFile>, CoreError> {
        Err(CoreError::Unsupported(
            "restore_filelist is not supported by this driver".into(),
        ))
    }

    /// List the current physical files of an existing `database`
    /// (`sys.master_files`), used as relocation targets when restoring over it.
    async fn database_files(&mut self, _database: &str) -> Result<Vec<DbFile>, CoreError> {
        Err(CoreError::Unsupported(
            "database_files is not supported by this driver".into(),
        ))
    }

    /// The server's default data/log directories, used as a fallback when a
    /// restore relocation target cannot be derived from the target database.
    async fn default_file_dirs(&mut self) -> Result<DefaultDirs, CoreError> {
        Err(CoreError::Unsupported(
            "default_file_dirs is not supported by this driver".into(),
        ))
    }

    /// The server's default **backup** directory, for pre-filling a backup
    /// destination and as the starting point for the server-side file browser.
    async fn default_backup_dir(&mut self) -> Result<String, CoreError> {
        Err(CoreError::Unsupported(
            "default_backup_dir is not supported by this driver".into(),
        ))
    }

    /// List the immediate entries (sub-directories and files) of the **server**
    /// directory `path`, so the UI can browse the server's filesystem to pick a
    /// backup destination or a `.bak` to restore. Returns names only.
    async fn list_server_dir(&mut self, _path: &str) -> Result<Vec<ServerDirEntry>, CoreError> {
        Err(CoreError::Unsupported(
            "list_server_dir is not supported by this driver".into(),
        ))
    }

    /// Restore the backup at `from_path` **over** the existing database
    /// `target` (`RESTORE … WITH REPLACE`), relocating each file per `moves`.
    /// The target is taken single-user for the duration and returned to
    /// multi-user afterwards (even on failure). Drivers must bracket-quote the
    /// database name and escape all paths/logical names as string literals.
    async fn restore_database(
        &mut self,
        _target: &str,
        _from_path: &str,
        _moves: &[FileMove],
        _opts: &RestoreOptions,
        _cancel: &CancelToken,
    ) -> Result<(), CoreError> {
        Err(CoreError::Unsupported(
            "restore_database is not supported by this driver".into(),
        ))
    }

    /// The server-assigned session id (`@@SPID`) of this connection, used to
    /// correlate the running backup/restore in `sys.dm_exec_requests`.
    async fn current_session_id(&mut self) -> Result<i32, CoreError> {
        Err(CoreError::Unsupported(
            "current_session_id is not supported by this driver".into(),
        ))
    }

    /// The `percent_complete` of the request running on session `spid`
    /// (`sys.dm_exec_requests`), or `None` if no such request is active. Called
    /// on a *separate* connection while a backup/restore runs. Requires
    /// `VIEW SERVER STATE`; a permission error should surface as an `Err` so the
    /// caller can fall back to indeterminate progress.
    async fn backup_percent_complete(&mut self, _spid: i32) -> Result<Option<f32>, CoreError> {
        Err(CoreError::Unsupported(
            "backup_percent_complete is not supported by this driver".into(),
        ))
    }

    /// Terminate the server session `spid` (`KILL`). Best-effort cancellation of
    /// a backup/restore, issued from a separate connection.
    async fn kill_session(&mut self, _spid: i32) -> Result<(), CoreError> {
        Err(CoreError::Unsupported(
            "kill_session is not supported by this driver".into(),
        ))
    }

    /// Delete a single file on the **server's** filesystem (e.g. a `.bak` after a
    /// restore). Best-effort and may be refused by server policy (the driver must
    /// never relax security settings to do it). Drivers must escape the path.
    async fn delete_server_file(&mut self, _path: &str) -> Result<(), CoreError> {
        Err(CoreError::Unsupported(
            "delete_server_file is not supported by this driver".into(),
        ))
    }
}

/// A database backend: opens connections and advertises its capabilities.
#[async_trait::async_trait]
pub trait DatabaseDriver: Send + Sync {
    /// Which backend this is.
    fn id(&self) -> DriverId;

    /// What this driver supports (drives UI feature gating).
    fn capabilities(&self) -> DriverCapabilities;

    /// Validate connectivity without establishing a pooled session.
    async fn test_connection(
        &self,
        spec: &ConnectionSpec,
        secret: &Secret,
    ) -> Result<TestReport, CoreError>;

    /// Open a live connection.
    async fn connect(
        &self,
        spec: &ConnectionSpec,
        secret: &Secret,
    ) -> Result<Box<dyn Connection>, CoreError>;
}

/// Return the driver implementation for `id`, if compiled into this build.
///
/// New backends are registered here as they are implemented.
pub fn driver_for(id: DriverId) -> Result<Box<dyn DatabaseDriver>, CoreError> {
    match id {
        #[cfg(feature = "mssql")]
        DriverId::Mssql => Ok(Box::new(mssql::MssqlDriver::new())),
        #[cfg(feature = "postgres")]
        DriverId::Postgres => Ok(Box::new(postgres::PostgresDriver::new())),
        #[cfg(feature = "mysql")]
        DriverId::Mysql => Ok(Box::new(mysql::MysqlDriver::new())),
        #[cfg(feature = "sqlite")]
        DriverId::Sqlite => Ok(Box::new(sqlite::SqliteDriver::new())),
        #[cfg(feature = "mongodb")]
        DriverId::Mongodb => Ok(Box::new(mongodb::MongodbDriver::new())),
        // Catch-all for any `DriverId` whose backend feature is off in this build
        // (e.g. the default mssql-only bundle, or a sqlx-only test build). When
        // *every* driver feature happens to be enabled at once this arm becomes
        // unreachable — but it is genuinely reachable in the common single/partial
        // feature configurations, so the lint is suppressed only here rather than
        // dropping the arm (which would then fail to compile those builds).
        #[allow(unreachable_patterns)]
        other => Err(CoreError::Unsupported(format!(
            "driver {other:?} is not available in this build"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bound_passes_a_ready_future_through() {
        let token = CancelToken::new();
        let out = token.bound(async { 7 }).await.expect("not cancelled");
        assert_eq!(out, 7);
    }

    #[tokio::test]
    async fn bound_short_circuits_a_precancelled_token() {
        let token = CancelToken::new();
        token.cancel();
        // The future would resolve fine — the cancel check must win first.
        let err = token.bound(async { 7 }).await.expect_err("cancelled");
        assert!(matches!(err, CoreError::Cancelled));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_wakes_a_parked_bound_future() {
        // The regression this token exists for: a future that never resolves on
        // its own (a query the server hasn't answered) must be interrupted the
        // moment `cancel()` fires from elsewhere.
        let token = CancelToken::new();
        let canceller = token.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            canceller.cancel();
        });
        let err = token
            .bound(std::future::pending::<()>())
            .await
            .expect_err("woken by cancel");
        assert!(matches!(err, CoreError::Cancelled));
    }
}
