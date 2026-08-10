/**
 * Export re-runs a query, so it must re-run the SQL that produced the rows on
 * screen — the editor *selection* when the run had one, not the whole tab
 * buffer. The grid and the OS save dialog are mocked at their module
 * boundaries; we only assert which SQL reaches `exportResult`.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(async () => "/tmp/out.csv"),
}));

vi.mock("../ipc/commands", () => ({
  exportResult: vi.fn(async () => ({ rows_written: 0, path: "/tmp/out.csv" })),
}));

vi.mock("../ipc/channels", () => ({
  createExportChannel: vi.fn(() => ({ __channel: true })),
}));

// The virtualized grid needs layout jsdom does not have, and none of these
// assertions touch it.
vi.mock("./ResultsGrid", () => ({ ResultsGrid: () => <div /> }));

import { exportResult } from "../ipc/commands";
import type { Column } from "../ipc/types";
import { useEditorStore } from "../state/editorStore";
import { ResultsPanel } from "./ResultsPanel";

const mockExport = vi.mocked(exportResult);

const COLUMNS: Column[] = [
  {
    name: "id",
    ordinal: 0,
    db_type: "int",
    logical: "integer",
    nullable: false,
  },
];

/** A tab whose buffer holds two statements, with one result set on screen. */
function seedTab(bufferSql: string, executedSql: string): string {
  const store = useEditorStore.getState();
  const id = store.addTab("session-1", bufferSql);
  store.resetResult(id, executedSql);
  useEditorStore.getState().resultMeta(id, 0, COLUMNS);
  return id;
}

/** Open the export menu and pick CSV. */
async function exportCsv() {
  fireEvent.click(screen.getByRole("button", { name: /export/i }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "CSV" }));
}

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null, results: {} });
  mockExport.mockClear();
});

describe("ResultsPanel — export", () => {
  it("exports the SQL the run executed, not the whole tab buffer", async () => {
    const buffer = "SELECT TOP 8 * FROM small;\nSELECT * FROM big;";
    const id = seedTab(buffer, "SELECT * FROM big;");

    render(<ResultsPanel tabId={id} />);
    await exportCsv();

    await waitFor(() => expect(mockExport).toHaveBeenCalledTimes(1));
    expect(mockExport.mock.calls[0][1]).toBe("SELECT * FROM big;");
  });

  it("falls back to the tab buffer when the run recorded no SQL", async () => {
    const id = seedTab("SELECT 1;", "");

    render(<ResultsPanel tabId={id} />);
    await exportCsv();

    await waitFor(() => expect(mockExport).toHaveBeenCalledTimes(1));
    expect(mockExport.mock.calls[0][1]).toBe("SELECT 1;");
  });
});
