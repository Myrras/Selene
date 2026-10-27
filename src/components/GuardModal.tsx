/**
 * Renders the SQL guard's `confirm` and `block` verdicts.
 *
 * - `block`: a non-dismissable-by-action message; the query does not run.
 * - `confirm`: lists the reasons and offers Run anyway / Cancel.
 *
 * `action="export"` rewords both for Export, which re-runs the batch
 * server-side — so the user knows the flagged statements execute again.
 */

import { useEffect, useRef } from "react";

import type { GuardVerdict } from "../ipc/types";
import { Modal } from "./Modal";
import styles from "./GuardModal.module.css";

interface GuardModalProps {
  /** The pending verdict, or null when no prompt is shown. */
  state:
    | { kind: "confirm"; verdict: GuardVerdict }
    | { kind: "block"; verdict: GuardVerdict }
    | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** What the guarded batch is for; only changes the wording. */
  action?: "run" | "export";
}

const COPY = {
  run: {
    confirmTitle: "Confirm potentially destructive SQL",
    confirmLead: "The SQL guard flagged this batch. Review before running:",
    confirmButton: "Run anyway",
    blockLead: "The SQL guard refused to run this batch:",
  },
  export: {
    confirmTitle: "Export re-runs this SQL",
    confirmLead:
      "Exporting executes the batch again, including the flagged statements. Review before exporting:",
    confirmButton: "Re-run and export",
    blockLead: "The SQL guard refused to re-run this batch for export:",
  },
} as const;

export function GuardModal({
  state,
  onConfirm,
  onCancel,
  action = "run",
}: GuardModalProps) {
  const copy = COPY[action];
  // Retain the last verdict so the Modal can still animate out after the parent
  // clears `state` on resolve — otherwise it would unmount instantly. Updating
  // the ref during render is safe here: it's a pure function of the prop.
  const last = useRef(state);
  if (state) last.current = state;
  const shown = state ?? last.current;

  // Enter activates the primary action: "Run anyway" for confirm, "OK" for
  // block. Mirrors the Modal's Escape handler. Skip when focus is in an
  // editable element so typing isn't hijacked.
  useEffect(() => {
    if (!state) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Enter") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      e.preventDefault();
      if (state!.kind === "confirm") onConfirm();
      else onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state, onConfirm, onCancel]);

  if (!shown) return null;
  const isBlock = shown.kind === "block";

  return (
    <Modal
      open={state !== null}
      title={isBlock ? "Statement blocked" : copy.confirmTitle}
      tone={isBlock ? "danger" : "warning"}
      onClose={onCancel}
      footer={
        isBlock ? (
          <button type="button" className="primary" onClick={onCancel}>
            OK
          </button>
        ) : (
          <>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="danger" onClick={onConfirm}>
              {copy.confirmButton}
            </button>
          </>
        )
      }
    >
      <p className={styles.lead}>
        {isBlock ? copy.blockLead : copy.confirmLead}
      </p>
      <ul className={styles.reasons}>
        {shown.verdict.reasons.length === 0 ? (
          <li>No specific reason provided.</li>
        ) : (
          shown.verdict.reasons.map((r, i) => <li key={i}>{r}</li>)
        )}
      </ul>
      {isBlock && (
        <p className={styles.hint}>
          This connection may be read-only, or the statement is disallowed.
        </p>
      )}
    </Modal>
  );
}
