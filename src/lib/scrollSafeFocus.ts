/**
 * Scroll-safe focus for the CodeMirror content DOM.
 *
 * On WebKit 26 (macOS 26) `element.focus({ preventScroll: true })` is broken:
 * focusing the editor's content DOM can scroll it (typically to the top) even
 * with `preventScroll`. CodeMirror works around this with a save-then-restore
 * scroll kludge, but only when its UA sniff matches Safari 26
 * (`browser.safari_version >= 26`, read from `Version/26` in the user agent).
 * The Tauri WKWebView's user agent has no `Version/…` token, so CodeMirror
 * concludes `preventScroll` works and trusts it. Every focus it performs — the
 * mousedown on an unfocused editor, and `EditorView.focus()` — then jumps the
 * editor: run a query, click the results, click back into the editor, and the
 * view is scrolled away from where you were.
 *
 * This extension shadows `focus` on the view's own content DOM (CodeMirror
 * calls `contentDOM.focus(...)` for both paths) with the same kludge: record
 * the scroll offsets of every ancestor, focus, and put back any that moved.
 * Where `preventScroll` works nothing moves, so the restore is a no-op.
 */

import { ViewPlugin, type EditorView } from "@codemirror/view";

/**
 * Focus `el` and restore the scroll offset of `el` and every ancestor that the
 * focus moved, so focusing never scrolls regardless of `preventScroll` support.
 */
export function focusPreservingScroll(
  el: HTMLElement,
  options?: FocusOptions,
): void {
  const saved: [Element, number, number][] = [];
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    saved.push([cur, cur.scrollTop, cur.scrollLeft]);
  }
  HTMLElement.prototype.focus.call(el, options);
  for (const [node, top, left] of saved) {
    if (node.scrollTop !== top) node.scrollTop = top;
    if (node.scrollLeft !== left) node.scrollLeft = left;
  }
}

export const scrollSafeFocus = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      const dom = view.contentDOM;
      dom.focus = (options?: FocusOptions) =>
        focusPreservingScroll(dom, options);
    }

    destroy() {
      // Drop the own-property override so the prototype `focus` shows again.
      Reflect.deleteProperty(this.view.contentDOM, "focus");
    }
  },
);
