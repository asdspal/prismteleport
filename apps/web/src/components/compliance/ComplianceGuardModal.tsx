"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PROHIBITED_JURISDICTIONS } from "@/lib/prismTerminal";

/**
 * Compliance & prohibited-jurisdiction guard (R-023).
 *
 * Read-only browsing stays open worldwide, so a judge never hits a wall. Only a
 * state-changing transaction asks for a one-time Terms & non-prohibited-
 * jurisdiction attestation, which is remembered locally afterwards.
 */

const STORAGE_KEY = "prism.compliance.attested.v1";

export function useComplianceGuard() {
  const [attested, setAttested] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | undefined>();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      setAttested(window.localStorage.getItem(STORAGE_KEY) === "true");
    } catch {
      setAttested(false);
    }
  }, []);

  const attest = useCallback(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, "true");
    } catch {
      // Storage unavailable (private mode): keep the in-memory attestation.
    }
    setAttested(true);
    setOpen(false);
    const action = pendingAction;
    setPendingAction(undefined);
    action?.();
  }, [pendingAction]);

  const cancel = useCallback(() => {
    setOpen(false);
    setPendingAction(undefined);
  }, []);

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setAttested(false);
  }, []);

  /** Runs `action` immediately when attested, otherwise after the attestation. */
  const guard = useCallback(
    (action: () => void) => {
      if (attested) {
        action();
        return;
      }
      setPendingAction(() => action);
      setOpen(true);
    },
    [attested],
  );

  const modal = useMemo(
    () => ({ open, onAttest: attest, onCancel: cancel }),
    [open, attest, cancel],
  );

  return { attested, guard, modal, reset };
}

export function ComplianceGuardModal({
  open,
  onAttest,
  onCancel,
}: {
  open: boolean;
  onAttest: () => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!open) setChecked(false);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="compliance-heading"
        className="w-full max-w-lg rounded-lg border border-border-default bg-bg-primary p-5"
      >
        <h2
          id="compliance-heading"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary"
        >
          Terms &amp; eligibility
        </h2>
        <p className="mt-3 text-sm text-text-secondary">
          Reading the terminal is open to everyone. Before sending a transaction,
          please confirm you are not a resident of a prohibited jurisdiction and
          accept the terms of use.
        </p>

        <ul className="mt-3 grid grid-cols-2 gap-1 font-mono text-[11px] text-text-tertiary">
          {PROHIBITED_JURISDICTIONS.map((jurisdiction) => (
            <li key={jurisdiction}>{jurisdiction}</li>
          ))}
        </ul>

        <label className="mt-4 flex items-start gap-2 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            I confirm I am not located in, or a resident of, any prohibited
            jurisdiction above, and I accept the terms of use.
          </span>
        </label>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border-default px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-text-secondary transition-colors hover:text-text-primary"
          >
            Keep browsing
          </button>
          <button
            type="button"
            disabled={!checked}
            onClick={onAttest}
            className="rounded-md border border-brand-cyan px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-brand-cyan transition-colors hover:bg-brand-cyan/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Attest &amp; continue
          </button>
        </div>
      </div>
    </div>
  );
}
