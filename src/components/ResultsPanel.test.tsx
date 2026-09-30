/**
 * ResultsPanel export: Export re-runs the query, so it must re-run the SQL
 * that produced the rows on screen (the selection, not the whole buffer) and
 * write the selected result sub-tab, not the first set. The save dialog and
 * IPC are mocked at their module boundaries.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(async () => "/tmp/out.csv"),
}));

vi.mock("../ipc/commands", () => ({
  exportResult: vi.fn(async () => ({ rows_written: 1 })),
}));

vi.mock("../ipc/channels", () => ({
  createExportChannel: vi.fn(() => ({ __channel: true })),
}));

import { exportResult } from "../ipc/commands";
import type { Column, ExportFormat } from "../ipc/types";
import { useEditorStore } from "../state/editorStore";
import { ResultsPanel } from "./ResultsPanel";

const mockExport = vi.mocked(exportResult);

const SQL = "SELECT 1 AS a;\nSELECT 2 AS b;\nSELECT 3 AS c;";

function col(name: string): Column[] {
  return [
    { name, ordinal: 0, db_type: "int", logical: "integer", nullable: false },
  ];
}

beforeEach(() => {
  mockExport.mockClear();
  useEditorStore.setState({ tabs: [], activeTabId: null, results: {} });
});

describe("ResultsPanel export", () => {
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
