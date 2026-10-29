/**
 * Per-tab state for the "run on multiple targets" view.
 *
 * Keyed by the owning editor tab's id so the form (selected servers, the
 * database filter, the query) and the last run's progress survive tab switches
 * — the pane component is unmounted when you switch away and remounted when you
 * return, but the store outlives it. Cleared when the tab closes.
 *
 * Passwords/secrets never live here (they stay in the OS keychain, resolved in
 * Rust); this holds only ids, names, SQL text the user typed, and progress.
 */

import { create } from "zustand";

import type { MultiMode, ResolvedTarget } from "../ipc/types";

/** How the databases-per-server are chosen. */
export type DbMode = "query" | "list";

export type MultiRunStatus =
  "idle" | "running" | "paused" | "done" | "cancelled";

/** Status of one (server, database) — or one server-level failure. */
export interface TargetProgress {
  connectionId: string;
  server: string;
  /** Empty string marks a server-level failure (no specific database). */
  database: string;
  /** `cancelled` = still pending when the run was cancelled (never ran/finished). */
  status: "pending" | "ok" | "error" | "cancelled";
  /** Rows returned (results mode); `null` otherwise. */
  rows: number | null;
  error: string | null;
}

/** Everything one multi-target tab needs to remember. */
export interface MultiTargetView {
  /** Saved connections selected as servers. */
  selectedConnectionIds: string[];
  /** Whether databases come from the filter query or hand-picked lists. */
  dbMode: DbMode;
  /** The `sys.databases` filter query (query mode). Seeded from settings. */
  filterSql: string;
  /** Hand-picked databases per connection (list mode). */
  listSelections: Record<string, string[]>;
  /** The SQL run against each database. */
  querySql: string;
  /** Last preview / plan from `multi_target_resolve` (query mode). */
  resolved: ResolvedTarget[];
  /** A preview is in flight. */
  resolving: boolean;

  /** Lifecycle of the current/last run. */
  runStatus: MultiRunStatus;
  /** Which mode is/was running. */
  runMode: MultiMode | null;
  /** Cancellation handle for an in-flight run. */
  runId: string | null;
  /** Per (server, database) progress, in arrival order. */
  progress: TargetProgress[];
  total: number;
  succeeded: number;
  failed: number;
  rowsTotal: number;
  /** A top-level (non per-target) error, e.g. a preview failure. */
  error: string | null;
}

function emptyView(filterSqlSeed: string): MultiTargetView {
  return {
    selectedConnectionIds: [],
    dbMode: "query",
    filterSql: filterSqlSeed,
    listSelections: {},
    querySql: "",
    resolved: [],
    resolving: false,
    runStatus: "idle",
    runMode: null,
    runId: null,
    progress: [],
    total: 0,
    succeeded: 0,
    failed: 0,
    rowsTotal: 0,
    error: null,
  };
}

/** Key a progress row by its (connection, database) pair. */
function progressKey(connectionId: string, database: string): string {
  return `${connectionId}\0${database}`;
}

interface MultiTargetState {
  views: Record<string, MultiTargetView>;

  /** Create the view for `tabId` if absent (seeding the filter query), no-op
   *  otherwise. Returns nothing — read with the `useView` selector. */
  ensure: (tabId: string, filterSqlSeed: string) => void;
  /** Shallow-merge a patch into a view. */
  update: (tabId: string, patch: Partial<MultiTargetView>) => void;
  /** Drop a view (on tab close). */
  remove: (tabId: string) => void;

  toggleConnection: (tabId: string, connectionId: string) => void;
  setListSelection: (
    tabId: string,
    connectionId: string,
    databases: string[],
  ) => void;

  // --- run lifecycle (driven by the MultiEvent channel) ---
  startRun: (
    tabId: string,
    mode: MultiMode,
    total: number,
    runId: string,
  ) => void;
  /** Upsert a batch of progress rows (keyed by connection+database) in one
   *  store update. Events are coalesced into batches by
   *  {@link createProgressBuffer} so a many-database run costs ~10 renders/sec
   *  instead of one per event. */
  applyProgress: (tabId: string, updates: TargetProgress[]) => void;
  /** Auto-paused after the failure rate crossed the threshold. Stores the
   *  at-pause counts for the prompt; the run idles until resume/cancel. */
  pauseRun: (tabId: string, failed: number, total: number) => void;
  /** Continue a paused run (user chose "Continue"). */
  resumeRun: (tabId: string) => void;
  finishRun: (
    tabId: string,
    succeeded: number,
    failed: number,
    rowsTotal: number,
  ) => void;
  cancelRun: (tabId: string) => void;
}

export const useMultiTargetStore = create<MultiTargetState>((set) => {
  /** Patch one view immutably; no-op if the view is gone (tab closed mid-run). */
  function patchView(
    tabId: string,
    patch: (prev: MultiTargetView) => MultiTargetView,
  ) {
    set((state) => {
      const prev = state.views[tabId];
      if (!prev) return state;
      return { views: { ...state.views, [tabId]: patch(prev) } };
    });
  }

  return {
    views: {},

    ensure: (tabId, filterSqlSeed) =>
      set((state) =>
        state.views[tabId]
          ? state
          : { views: { ...state.views, [tabId]: emptyView(filterSqlSeed) } },
      ),

    update: (tabId, patch) =>
      patchView(tabId, (prev) => ({ ...prev, ...patch })),

    remove: (tabId) =>
      set((state) => {
        if (!state.views[tabId]) return state;
        const views = { ...state.views };
        delete views[tabId];
        return { views };
      }),

    toggleConnection: (tabId, connectionId) =>
      patchView(tabId, (prev) => {
        const has = prev.selectedConnectionIds.includes(connectionId);
        return {
          ...prev,
          selectedConnectionIds: has
            ? prev.selectedConnectionIds.filter((id) => id !== connectionId)
            : [...prev.selectedConnectionIds, connectionId],
        };
      }),

    setListSelection: (tabId, connectionId, databases) =>
      patchView(tabId, (prev) => ({
        ...prev,
        listSelections: { ...prev.listSelections, [connectionId]: databases },
      })),

    startRun: (tabId, mode, total, runId) =>
      patchView(tabId, (prev) => ({
        ...prev,
        runStatus: "running",
        runMode: mode,
        runId,
        total,
        progress: [],
        succeeded: 0,
        failed: 0,
        rowsTotal: 0,
        error: null,
      })),

    applyProgress: (tabId, updates) =>
      patchView(tabId, (prev) => {
        // One index pass per batch (not per event) keeps a many-database run
        // O(N) per flush instead of O(N) per event.
        const progress = prev.progress.slice();
        const index = new Map<string, number>();
        progress.forEach((p, i) =>
          index.set(progressKey(p.connectionId, p.database), i),
        );
        for (const next of updates) {
          const key = progressKey(next.connectionId, next.database);
          const at = index.get(key);
          if (at === undefined) {
            index.set(key, progress.length);
            progress.push(next);
          } else {
            progress[at] = next;
          }
        }
        return { ...prev, progress };
      }),

    pauseRun: (tabId, failed, total) =>
      patchView(tabId, (prev) => ({
        ...prev,
        runStatus: "paused",
        failed,
        total,
      })),

    resumeRun: (tabId) =>
      patchView(tabId, (prev) =>
        // Only a paused run can resume; ignore stray resumes.
        prev.runStatus === "paused" ? { ...prev, runStatus: "running" } : prev,
      ),

    finishRun: (tabId, succeeded, failed, rowsTotal) =>
      patchView(tabId, (prev) => ({
        ...prev,
        runStatus: "done",
        runId: null,
        succeeded,
        failed,
        rowsTotal,
      })),

    cancelRun: (tabId) =>
      patchView(tabId, (prev) => ({
        ...prev,
        runStatus: "cancelled",
        runId: null,
        // Rows still in flight when the run was cancelled never finish — flip
        // them to `cancelled` so the UI stops showing a spinner for them.
        progress: prev.progress.map((p) =>
          p.status === "pending" ? { ...p, status: "cancelled" } : p,
        ),
      })),
  };
});

/** Narrow selector: one tab's view (or `undefined` before `ensure`). */
export function useMultiTargetView(tabId: string): MultiTargetView | undefined {
  return useMultiTargetStore((s) => s.views[tabId]);
}

/** How often buffered progress events flush to the store (and thus re-render). */
export const PROGRESS_FLUSH_MS = 100;

export interface ProgressBuffer {
  /** Queue one progress row; flushes to the store at most every
   *  {@link PROGRESS_FLUSH_MS}. A later push for the same (connection,
   *  database) replaces the queued one (pending → done coalesces). */
  push: (p: TargetProgress) => void;
  /** Apply everything queued now (before a terminal/pause event). */
  flush: () => void;
}

/**
 * Coalesce the per-target MultiEvent storm into batched `applyProgress` calls.
 * A run across thousands of databases emits thousands of events in quick
 * succession; applying each one individually re-renders the pane per event
 * (which froze the app). One buffer is created per run; it holds only progress
 * rows, never SQL text or secrets.
 */
export function createProgressBuffer(tabId: string): ProgressBuffer {
  const queued = new Map<string, TargetProgress>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (queued.size === 0) return;
    const updates = [...queued.values()];
    queued.clear();
    useMultiTargetStore.getState().applyProgress(tabId, updates);
  };

  return {
    push: (p) => {
      queued.set(progressKey(p.connectionId, p.database), p);
      if (timer === null) timer = setTimeout(flush, PROGRESS_FLUSH_MS);
    },
    flush,
  };
}
