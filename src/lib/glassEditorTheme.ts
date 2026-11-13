/** CodeMirror extensions for the glass themes (shared by all SQL editors). */

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  githubDarkStyle,
  githubLightStyle,
} from "@uiw/codemirror-theme-github";

import { isDarkTheme, type ThemeMode } from "../state/themeStore";

/** githubDark/githubLight colours below 4.5:1 on the glass fill, replaced. */
const GLASS_SYNTAX: Record<string, string> = {
  "#8b949e": "#a3adb9", // dark comment 3.7 -> 5.05
  "#ff7b72": "#ff8a82", // dark keyword 4.55 -> 5.04
  "#d73a49": "#c42335", // light keyword 3.98 -> 5.02
  "#6a737d": "#59626d", // light comment 4.19 -> 5.38
  "#005cc5": "#0550ae", // light number 5.47 -> 6.6
};

/**
 * Glass: the editor sits on the island's own fill, so CodeMirror's opaque paper
 * goes transparent and low-contrast syntax colours are swapped. Empty for
 * every non-glass theme.
 */
export function glassEditorExtensions(mode: ThemeMode): Extension[] {
  if (!mode.startsWith("glass")) return [];
  const dark = isDarkTheme(mode);
  const tint = dark ? "rgba(255,255,255,0.06)" : "rgba(20,30,60,0.06)";
  return [
    Prec.highest(
      EditorView.theme({
        "&": { background: "transparent" },
        ".cm-gutters": {
          background: "transparent",
          borderRight: "1px solid var(--border)",
        },
        ".cm-activeLine": { background: tint },
        ".cm-activeLineGutter": { background: tint },
      }),
    ),
    Prec.highest(
      syntaxHighlighting(
        HighlightStyle.define(
          (dark ? githubDarkStyle : githubLightStyle).map((r) => ({
            ...r,
            color: GLASS_SYNTAX[String(r.color)] ?? r.color,
          })),
        ),
      ),
    ),
  ];
}
