/**
 * Uses a real (headless) EditorView with the same keymap layering as the app
 * (defaultKeymap + SQL language first, `keepIndentOnEnter` after) so the test
 * fails if the binding or its precedence over `insertNewlineAndIndent` breaks.
 */

import { afterEach, describe, expect, it } from "vitest";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { sql, MSSQL } from "@codemirror/lang-sql";

import { keepIndentOnEnter } from "./editorKeymap";

let view: EditorView | null = null;

function makeView(doc: string): EditorView {
  view = new EditorView({
    doc,
    extensions: [
      sql({ dialect: MSSQL }),
      keymap.of(defaultKeymap),
      keepIndentOnEnter,
    ],
    parent: document.body,
  });
  view.dispatch({ selection: { anchor: doc.length } });
  return view;
}

function pressEnter(v: EditorView) {
  runScopeHandlers(v, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
}

afterEach(() => {
  view?.destroy();
  view = null;
});

describe("keepIndentOnEnter", () => {
  it("copies the previous line's indentation", () => {
    const v = makeView("SELECT a,\n  b");
    pressEnter(v);
    expect(v.state.doc.toString()).toBe("SELECT a,\n  b\n  ");
  });

  it("does not add the syntax-driven extra indent inside a statement", () => {
    // Without the binding, lang-sql's continuedIndent() would indent this
    // continuation line one unit past "SELECT a".
    const v = makeView("SELECT a");
    pressEnter(v);
    expect(v.state.doc.toString()).toBe("SELECT a\n");
  });

  it("keeps tab indentation as-is", () => {
    const v = makeView("SELECT a,\n\tb FROM (");
    pressEnter(v);
    expect(v.state.doc.toString()).toBe("SELECT a,\n\tb FROM (\n\t");
  });
});
