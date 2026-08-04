/**
 * Persistent sidebar layout: width, panel order, collapsed state, panel heights,
 * plus the editor/results split of the work area.
 */

import { create } from "zustand";

export type PanelId = "connections" | "files" | "schema";

interface LayoutPersisted {
  sidebarWidth: number;
  panelOrder: PanelId[];
  collapsed: { connections: boolean; files: boolean; schema: boolean };
  panelH: { connections: number; files: number; schema: number };
  /** Editor's share of the work-area height, in percent. */
  editorPct: number;
}

const STORAGE_KEY = "selene.layout";

const DEFAULTS: LayoutPersisted = {
  sidebarWidth: 280,
  panelOrder: ["connections", "files", "schema"],
  collapsed: { connections: false, files: false, schema: false },
  panelH: { connections: 200, files: 160, schema: 240 },
  // The editor is where you work; results are a readout. Give the editor
  // roughly two thirds by default.
  editorPct: 68,
};

function load(): LayoutPersisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const saved = JSON.parse(raw) as Partial<LayoutPersisted>;
    return {
      ...DEFAULTS,
      ...saved,
      collapsed: { ...DEFAULTS.collapsed, ...(saved.collapsed ?? {}) },
      panelH: { ...DEFAULTS.panelH, ...(saved.panelH ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function persist(state: LayoutPersisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota exceeded */
  }
}

export interface LayoutState extends LayoutPersisted {
  setSidebarWidth: (w: number) => void;
  setPanelOrder: (order: PanelId[]) => void;
  toggleCollapsed: (panel: PanelId) => void;
  setPanelH: (panel: PanelId, h: number) => void;
  setEditorPct: (pct: number) => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => {
  // Every setter writes the same way: merge the patch into state and mirror the
  // persisted slice to localStorage. Keeps the field list in DEFAULTS only.
  const save = (patch: Partial<LayoutPersisted>) => {
    const next = { ...get(), ...patch };
    persist({
      sidebarWidth: next.sidebarWidth,
      panelOrder: next.panelOrder,
      collapsed: next.collapsed,
      panelH: next.panelH,
      editorPct: next.editorPct,
    });
    set(patch);
  };

  return {
    ...load(),
    setSidebarWidth: (w) =>
      save({ sidebarWidth: Math.min(600, Math.max(160, w)) }),
    setPanelOrder: (panelOrder) => save({ panelOrder }),
    toggleCollapsed: (panel) =>
      save({
        collapsed: { ...get().collapsed, [panel]: !get().collapsed[panel] },
      }),
    setPanelH: (panel, h) =>
      save({
        panelH: { ...get().panelH, [panel]: Math.min(800, Math.max(80, h)) },
      }),
    setEditorPct: (pct) => save({ editorPct: Math.min(80, Math.max(15, pct)) }),
  };
});
