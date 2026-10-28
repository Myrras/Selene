/**
 * SqlEditor scroll/focus contract.
 *
 * - A parent re-render (EditorPane re-renders several times per query run as
 *   status and results change) must not reconfigure CodeMirror: each
 *   reconfigure swaps in a freshly generated theme class and forces a full
 *   re-measure of the editor.
 * - Focusing the live view must go through the scroll-safe override installed
 *   by `scrollSafeFocus`, so returning focus after a Run keeps the scroll.
 */

import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { SqlEditor } from "./SqlEditor";
import { useSettingsStore } from "../state/settingsStore";

beforeEach(() => {
  useSettingsStore.getState().resetSettings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderEditor() {
  const viewRef: React.MutableRefObject<EditorView | null> = { current: null };
  const onRun = vi.fn();
  const utils = render(
    <SqlEditor tabId="t1" onRun={onRun} viewRef={viewRef} />,
  );
  const view = viewRef.current;
  if (!view) throw new Error("editor view was not created");
  return { ...utils, view, onRun, viewRef };
}

describe("SqlEditor", () => {
  it("does not reconfigure CodeMirror when the parent re-renders", () => {
    const { view, onRun, viewRef, rerender } = renderEditor();
    const dispatch = vi.spyOn(view, "dispatch");

    for (let i = 0; i < 3; i++) {
      rerender(<SqlEditor tabId="t1" onRun={onRun} viewRef={viewRef} />);
    }

    const reconfigures = dispatch.mock.calls.filter(([spec]) => {
      const effects = (spec as { effects?: unknown })?.effects;
      const list = Array.isArray(effects) ? effects : effects ? [effects] : [];
      return list.some(
        (e) => e instanceof StateEffect && e.is(StateEffect.reconfigure),
      );
    });
    expect(reconfigures).toHaveLength(0);
  });

  it("installs the scroll-safe focus override on the content DOM", () => {
    const { view } = renderEditor();
    expect(Object.prototype.hasOwnProperty.call(view.contentDOM, "focus")).toBe(
      true,
    );
  });
});
