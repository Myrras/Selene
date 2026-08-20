/**
 * Zed-style Enter: insert a newline that copies the previous line's
 * indentation verbatim, never more. The default `insertNewlineAndIndent`
 * asks the language for an indentation, and lang-sql marks every Statement
 * as `continuedIndent()` — so Enter inside a multi-line statement kept
 * adding an extra indent unit. Bound at `Prec.highest` to beat the default
 * keymap; autocomplete's accept-Enter is registered earlier at the same
 * precedence (basicSetup precedes user extensions), so an open completion
 * popup still wins.
 */

import { insertNewlineKeepIndent } from "@codemirror/commands";
import { Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";

export const keepIndentOnEnter = Prec.highest(
  keymap.of([{ key: "Enter", run: insertNewlineKeepIndent }]),
);
