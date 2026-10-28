/**
 * ResultsPanel export. Export re-runs the query, so:
 * - it must re-run the SQL that produced the rows on screen (the selection,
 *   not the whole buffer) and write the selected result sub-tab, not the
 *   first set;
 * - it must pass the same guard as Run: a `block` verdict refuses, a `confirm`
 *   verdict prompts (Cancel → no export, accept → export), and an `info`
 *   verdict exports without a prompt.
 *
 * IPC, the export channel, and the OS save dialog are mocked at their module
 * boundaries (no Tauri).
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(async () => "/tmp/out.csv"),
}));

vi.mock("../ipc/commands", () => ({
  guardCheck: vi.fn(),
  exportResult: vi.fn(async () => ({ rows_written: 1 })),
}));

vi.mock("../ipc/channels", () => ({
  createExportChannel: vi.fn(() => ({ __channel: true })),
}));

import { exportResult, guardCheck } from "../ipc/commands";
import type {
  Column,
  ExportFormat,
  GuardVerdict,
  SessionInfo,
} from "../ipc/types";
import { useEditorStore } from "../state/editorStore";
import { useSessionStore } from "../state/sessionStore";
import { useSettingsStore } from "../state/settingsStore";
import { ResultsPanel } from "./ResultsPanel";

const mockGuard = vi.mocked(guardCheck);
const mockExport = vi.mocked(exportResult);

function col(name: string): Column[] {
  return [
    { name, ordinal: 0, db_type: "int", logical: "integer", nullable: false },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the guard lets the export through without a prompt.
  mockGuard.mockResolvedValue({ level: "info", reasons: [] });
  useEditorStore.setState({ tabs: [], activeTabId: null, results: {} });
  useSessionStore.setState({ sessions: {}, order: [] });
  useSettingsStore.setState((s) => ({
    query: { ...s.query, confirmOnReadWrite: false },
  }));
});

describe("ResultsPanel export", () => {
  const SQL = "SELECT 1 AS a;\nSELECT 2 AS b;\nSELECT 3 AS c;";

  it.each<ExportFormat>(["csv", "json", "xlsx"])(
    "exports the selected result set as %s",
    async (format) => {
      const s = useEditorStore.getState();
      const id = s.addTab("session-1", SQL);
      s.resetResult(id, SQL);
      ["a", "b", "c"].forEach((name, i) => {
        s.resultMeta(id, i, col(name));
        s.resultAppendRows(id, i, [[{ t: "I64", v: i + 1 }]]);
        s.resultSetEnd(id, i, null);
      });
      s.resultFinished(
        id,
        {
          result_sets: 3,
          total_rows: 3,
          truncated: false,
          rolled_back: false,
        },
        1,
      );

      render(<ResultsPanel tabId={id} />);
      fireEvent.click(screen.getByRole("tab", { name: "Result 2" }));
      fireEvent.click(screen.getByRole("button", { name: /export/i }));
      const label = { csv: "CSV", json: "JSON", xlsx: "Excel (.xlsx)" }[format];
      fireEvent.click(screen.getByRole("menuitem", { name: label }));

      await waitFor(() =>
        expect(mockExport).toHaveBeenCalledWith(
          "session-1",
          SQL,
          format,
          "/tmp/out.csv",
          undefined,
          expect.anything(),
          format === "csv" ? expect.any(Object) : undefined,
          1,
        ),
      );
    },
  );

  /** Seed a one-set result whose run executed `executedSql`, then export CSV. */
  async function exportCsvOf(bufferSql: string, executedSql: string) {
    const s = useEditorStore.getState();
    const id = s.addTab("session-1", bufferSql);
    s.resetResult(id, executedSql);
    s.resultMeta(id, 0, col("a"));

    render(<ResultsPanel tabId={id} />);
    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "CSV" }));
    await waitFor(() => expect(mockExport).toHaveBeenCalledTimes(1));
    return mockExport.mock.calls[0][1];
  }

  it("exports the SQL the run executed, not the whole tab buffer", async () => {
    expect(await exportCsvOf(SQL, "SELECT 2 AS b;")).toBe("SELECT 2 AS b;");
  });

  it("falls back to the tab buffer when the run recorded no SQL", async () => {
    expect(await exportCsvOf(SQL, "")).toBe(SQL);
  });
});

describe("ResultsPanel export guard", () => {
  const SQL = "SELECT 1 AS a; DELETE FROM widgets; SELECT 2 AS b;";

  function setup(readOnly = false): string {
    useSessionStore.getState().addSession({
      info: {
        sessionId: "s1",
        driver: "mssql",
        capabilities: {} as SessionInfo["capabilities"],
      },
      connectionId: "c1",
      connectionName: "Fictitious",
      readOnly,
    });
    const store = useEditorStore.getState();
    const tabId = store.addTab("s1", SQL);
    store.resetResult(tabId, SQL);
    store.resultMeta(tabId, 0, col("a"));
    return tabId;
  }

  async function clickExportCsv() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /export/i }));
    await user.click(screen.getByRole("menuitem", { name: "CSV" }));
    return user;
  }

  it("checks the exported SQL with the session's readOnly and driver", async () => {
    render(<ResultsPanel tabId={setup(true)} />);
    await clickExportCsv();

    await waitFor(() => expect(mockExport).toHaveBeenCalledTimes(1));
    expect(mockGuard).toHaveBeenCalledWith(SQL, true, "mssql");
    expect(mockExport.mock.calls[0][1]).toBe(SQL);
  });

  it("block: shows the block message and does not export", async () => {
    const verdict: GuardVerdict = {
      level: "block",
      reasons: ["non-SELECT on a read-only connection"],
    };
    mockGuard.mockResolvedValue(verdict);
    render(<ResultsPanel tabId={setup(true)} />);
    await clickExportCsv();

    expect(
      await screen.findByText(
        "The SQL guard refused to re-run this batch for export:",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("non-SELECT on a read-only connection"),
    ).toBeInTheDocument();
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("confirm + Cancel: prompts that export re-runs the SQL, then does not export", async () => {
    mockGuard.mockResolvedValue({
      level: "confirm",
      reasons: ["DELETE without WHERE"],
    });
    render(<ResultsPanel tabId={setup()} />);
    const user = await clickExportCsv();

    expect(
      await screen.findByText("Export re-runs this SQL"),
    ).toBeInTheDocument();
    expect(screen.getByText("DELETE without WHERE")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // Give the declined confirm a chance to (not) reach exportResult.
    await waitFor(() =>
      expect(screen.queryByText("DELETE without WHERE")).toBeNull(),
    );
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("confirm + accept: exports after the user confirms the re-run", async () => {
    mockGuard.mockResolvedValue({
      level: "confirm",
      reasons: ["DELETE without WHERE"],
    });
    render(<ResultsPanel tabId={setup()} />);
    const user = await clickExportCsv();

    await user.click(
      await screen.findByRole("button", { name: "Re-run and export" }),
    );
    await waitFor(() => expect(mockExport).toHaveBeenCalledTimes(1));
  });
});
