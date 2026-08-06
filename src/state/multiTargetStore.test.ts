/**
 * Multi-target store — the run-lifecycle reducers the MultiEvent channel drives
 * (started → target/targetDone/serverError → finished), plus selection helpers
 * and the event-coalescing progress buffer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProgressBuffer,
  PROGRESS_FLUSH_MS,
  useMultiTargetStore,
} from "./multiTargetStore";
import type { TargetProgress } from "./multiTargetStore";

const TAB = "tab-1";

function view() {
  return useMultiTargetStore.getState().views[TAB];
}

/** A progress row with defaults, for terse test bodies. */
function row(patch: Partial<TargetProgress>): TargetProgress {
  return {
    connectionId: "c1",
    server: "srv",
    database: "db1",
    status: "pending",
    rows: null,
    error: null,
    ...patch,
  };
}

beforeEach(() => {
  useMultiTargetStore.setState({ views: {} });
  useMultiTargetStore.getState().ensure(TAB, "SELECT name FROM sys.databases");
});

describe("multiTargetStore", () => {
  it("ensure seeds the filter query and is idempotent", () => {
    expect(view().filterSql).toBe("SELECT name FROM sys.databases");
    expect(view().dbMode).toBe("query");
    // A second ensure with a different seed must not clobber the existing view.
    useMultiTargetStore.getState().ensure(TAB, "OTHER");
    expect(view().filterSql).toBe("SELECT name FROM sys.databases");
  });

  it("toggleConnection adds then removes a server", () => {
    const s = useMultiTargetStore.getState();
    s.toggleConnection(TAB, "c1");
    s.toggleConnection(TAB, "c2");
    expect(view().selectedConnectionIds).toEqual(["c1", "c2"]);
    s.toggleConnection(TAB, "c1");
    expect(view().selectedConnectionIds).toEqual(["c2"]);
  });

  it("setListSelection stores per-connection database picks", () => {
    useMultiTargetStore.getState().setListSelection(TAB, "c1", ["a", "b"]);
    expect(view().listSelections.c1).toEqual(["a", "b"]);
  });

  it("startRun resets progress and marks running", () => {
    const s = useMultiTargetStore.getState();
    // Stale row from a prior run.
    s.applyProgress(TAB, [row({ database: "db", status: "ok", rows: 1 })]);
    s.startRun(TAB, "results", 3, "run-1");
    expect(view().runStatus).toBe("running");
    expect(view().runMode).toBe("results");
    expect(view().total).toBe(3);
    expect(view().runId).toBe("run-1");
    expect(view().progress).toEqual([]);
  });

  it("applyProgress upserts by (connection, db) and appends new keys", () => {
    const s = useMultiTargetStore.getState();
    s.startRun(TAB, "results", 2, "run-1");
    s.applyProgress(TAB, [row({}), row({ database: "db2" })]);
    expect(view().progress).toHaveLength(2);
    expect(view().progress[0].status).toBe("pending");
    // Same key updates in place (keeps arrival order); new key appends.
    s.applyProgress(TAB, [
      row({ status: "ok", rows: 7 }),
      row({ database: "db3", status: "error", error: "boom" }),
    ]);
    expect(view().progress).toHaveLength(3);
    expect(view().progress[0]).toMatchObject({
      database: "db1",
      status: "ok",
      rows: 7,
    });
    expect(view().progress[2]).toMatchObject({
      database: "db3",
      status: "error",
      error: "boom",
    });
  });

  it("applyProgress records a server-level row (empty database)", () => {
    const s = useMultiTargetStore.getState();
    s.startRun(TAB, "execute", 2, "run-1");
    s.applyProgress(TAB, [
      row({ database: "", status: "error", error: "no stored password" }),
    ]);
    expect(view().progress[0].database).toBe("");
    expect(view().progress[0].status).toBe("error");
  });

  it("pauseRun marks paused and stores the at-pause counts", () => {
    const s = useMultiTargetStore.getState();
    s.startRun(TAB, "execute", 50, "run-1");
    s.pauseRun(TAB, 5, 50);
    expect(view().runStatus).toBe("paused");
    expect(view().failed).toBe(5);
    expect(view().total).toBe(50);
    // The cancel handle is kept so Continue/Stop can act on the run.
    expect(view().runId).toBe("run-1");
  });

  it("resumeRun returns a paused run to running, and is a no-op otherwise", () => {
    const s = useMultiTargetStore.getState();
    s.startRun(TAB, "execute", 10, "run-1");
    s.pauseRun(TAB, 2, 10);
    s.resumeRun(TAB);
    expect(view().runStatus).toBe("running");
    // Resuming a non-paused run must not change its status.
    s.finishRun(TAB, 8, 2, 0);
    s.resumeRun(TAB);
    expect(view().runStatus).toBe("done");
  });

  it("finishRun records authoritative counts and clears runId", () => {
    const s = useMultiTargetStore.getState();
    s.startRun(TAB, "results", 5, "run-1");
    s.finishRun(TAB, 4, 1, 123);
    expect(view().runStatus).toBe("done");
    expect(view().succeeded).toBe(4);
    expect(view().failed).toBe(1);
    expect(view().rowsTotal).toBe(123);
    expect(view().runId).toBeNull();
  });

  it("cancelRun flips still-pending rows to cancelled, keeps finished ones", () => {
    const s = useMultiTargetStore.getState();
    s.startRun(TAB, "execute", 3, "run-1");
    s.applyProgress(TAB, [
      row({ status: "ok", rows: 5 }),
      row({ database: "db2" }),
      row({ database: "db3" }),
    ]);
    s.cancelRun(TAB);
    expect(view().runStatus).toBe("cancelled");
    expect(view().runId).toBeNull();
    expect(view().progress.map((p) => p.status)).toEqual([
      "ok",
      "cancelled",
      "cancelled",
    ]);
  });

  it("remove drops the view (tab close)", () => {
    useMultiTargetStore.getState().remove(TAB);
    expect(view()).toBeUndefined();
  });

  it("actions on a removed view are a no-op (run finishing after close)", () => {
    useMultiTargetStore.getState().remove(TAB);
    // Must not throw or resurrect the view.
    useMultiTargetStore.getState().finishRun(TAB, 1, 0, 0);
    expect(view()).toBeUndefined();
  });
});

describe("createProgressBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces pushes into one deferred store flush", () => {
    const buf = createProgressBuffer(TAB);
    buf.push(row({}));
    buf.push(row({ database: "db2" }));
    // Same key again before the flush: the later row wins (pending → done).
    buf.push(row({ status: "ok", rows: 3 }));
    expect(view().progress).toEqual([]); // nothing applied yet
    vi.advanceTimersByTime(PROGRESS_FLUSH_MS);
    expect(view().progress).toHaveLength(2);
    expect(view().progress[0]).toMatchObject({ database: "db1", rows: 3 });
  });

  it("flush applies immediately and disarms the timer", () => {
    const buf = createProgressBuffer(TAB);
    buf.push(row({}));
    buf.flush();
    expect(view().progress).toHaveLength(1);
    // The pending timer was cancelled; nothing double-applies later.
    const after = view().progress;
    vi.advanceTimersByTime(PROGRESS_FLUSH_MS * 2);
    expect(view().progress).toBe(after);
  });

  it("flush with an empty buffer is a no-op", () => {
    const before = view();
    createProgressBuffer(TAB).flush();
    expect(view()).toBe(before);
  });
});
