/**
 * scrollSafeFocus: focusing the editor must never move its scroll position.
 *
 * jsdom has no layout, so the WebKit 26 bug is simulated: the prototype
 * `focus` is spied to ignore `preventScroll` and reset the scroller and an
 * outer container to 0, like the macOS WebView does. The tests then check the
 * observable contract — every focus path CodeMirror uses (`view.focus()` and a
 * mousedown on an unfocused editor) leaves the scroll offsets where they were.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";

import { focusPreservingScroll, scrollSafeFocus } from "./scrollSafeFocus";

const DOC = Array.from({ length: 200 }, (_, i) => `SELECT ${i};`).join("\n");

let view: EditorView | null = null;
let outer: HTMLDivElement;

function makeView(withFix: boolean): EditorView {
  outer = document.createElement("div");
  document.body.appendChild(outer);
  view = new EditorView({
    doc: DOC,
    extensions: withFix ? [scrollSafeFocus] : [],
    parent: outer,
  });
  // Scrolled down in the editor, and an overflow:hidden ancestor nudged too.
  view.scrollDOM.scrollTop = 900;
  outer.scrollTop = 40;
  return view;
}

beforeEach(() => {
  const nativeFocus = HTMLElement.prototype.focus;
  // WebKit 26: `preventScroll` is ignored and the focus reveals the start of
  // the content, scrolling every ancestor.
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    // Reading the option is what makes CodeMirror's feature probe conclude
    // `preventScroll` is supported (as it does in the WKWebView, whose UA has
    // no `Version/26` for its Safari-26 sniff), so it skips its own kludge.
    void options?.preventScroll;
    nativeFocus.call(this, options);
    this.scrollTop = 0;
    for (let el = this.parentElement; el; el = el.parentElement) {
      el.scrollTop = 0;
    }
  });
});

afterEach(() => {
  view?.destroy();
  view = null;
  outer?.remove();
});

describe("scrollSafeFocus", () => {
  it("control: without the extension, view.focus() loses the scroll position", () => {
    const v = makeView(false);
    v.focus();
    expect(v.scrollDOM.scrollTop).toBe(0);
  });

  it("view.focus() keeps the editor and its ancestors where they were", () => {
    const v = makeView(true);
    v.focus();
    expect(document.activeElement).toBe(v.contentDOM);
    expect(v.scrollDOM.scrollTop).toBe(900);
    expect(outer.scrollTop).toBe(40);
  });

  it("the focus CodeMirror performs on mousedown into an unfocused editor keeps the scroll", () => {
    const v = makeView(true);
    expect(v.hasFocus).toBe(false);
    // CodeMirror's mousedown handler focuses via `contentDOM.focus(...)`
    // (focusPreventScroll); exercise exactly that call.
    v.contentDOM.focus({ preventScroll: true });
    expect(document.activeElement).toBe(v.contentDOM);
    expect(v.scrollDOM.scrollTop).toBe(900);
    expect(outer.scrollTop).toBe(40);
  });

  it("removes the override when the view is destroyed", () => {
    const v = makeView(true);
    const dom = v.contentDOM;
    expect(Object.prototype.hasOwnProperty.call(dom, "focus")).toBe(true);
    v.destroy();
    view = null;
    expect(Object.prototype.hasOwnProperty.call(dom, "focus")).toBe(false);
  });

  it("focusPreservingScroll focuses and restores a plain element", () => {
    const box = document.createElement("div");
    const input = document.createElement("input");
    box.appendChild(input);
    document.body.appendChild(box);
    box.scrollTop = 25;
    focusPreservingScroll(input, { preventScroll: true });
    expect(document.activeElement).toBe(input);
    expect(box.scrollTop).toBe(25);
    box.remove();
  });
});
