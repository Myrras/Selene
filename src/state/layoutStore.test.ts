/**
 * Layout store — persistence of the editor/results split.
 *
 * The split used to be local `useState` in EditorPane, which App remounts per
 * tab, so every drag was forgotten. These tests pin that it round-trips through
 * localStorage, that it is clamped, and that the shared `save` helper does not
 * drop sibling fields (the old per-setter field lists were easy to forget).
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useLayoutStore } from "./layoutStore";

const KEY = "selene.layout";

function stored(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(KEY) ?? "{}");
}

beforeEach(() => {
  localStorage.clear();
});

describe("layoutStore — editor/results split", () => {
  it("defaults to the editor taking the larger share", () => {
    expect(useLayoutStore.getState().editorPct).toBeGreaterThan(50);
  });

  it("persists a new split to localStorage, clamped", () => {
    useLayoutStore.getState().setEditorPct(70);
    expect(useLayoutStore.getState().editorPct).toBe(70);
    expect(stored().editorPct).toBe(70);

    useLayoutStore.getState().setEditorPct(99);
    expect(useLayoutStore.getState().editorPct).toBe(80);
    useLayoutStore.getState().setEditorPct(1);
    expect(useLayoutStore.getState().editorPct).toBe(15);
  });

  it("keeps sibling fields when persisting one of them", () => {
    useLayoutStore.getState().setSidebarWidth(320);
    useLayoutStore.getState().setEditorPct(55);

    expect(stored()).toMatchObject({ sidebarWidth: 320, editorPct: 55 });
    expect(stored().panelH).toBeDefined();
    expect(stored().panelOrder).toBeDefined();
  });
});
