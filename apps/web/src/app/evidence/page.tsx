"use client";

import Link from "next/link";
import { useState } from "react";
import { PrismTeleportModal } from "@prism-teleport/sdk/PrismTeleportModal";
import {
  DEPLOYMENTS,
  LIVE_URLS,
  PROOFS,
  TEST_SUMMARY,
} from "@/lib/evidence";

/**
 * `/evidence` (R-019, R-024): the judge-facing portal. Every claim the project
 * makes is traceable from here — deployed addresses with their Sourcify status,
 * the proof transactions, the test counts, the live routes and a playground that
 * runs the embeddable `<PrismTeleportModal />` exactly as a third-party dApp
 * would.
 */
export default function EvidencePage() {
  const [playgroundOpen, setPlaygroundOpen] = useState(false);

  return (
    <main id="main" className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand-cyan">
          Evidence portal
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
          Every claim, traceable.
        </h1>
        <p className="mt-3 max-w-3xl text-sm text-text-secondary">
          This page is generated from the same deployment records and test suites
          the build runs against. Where something could not be executed in this
          environment, it says so explicitly instead of being glossed over.
        </p>
      </header>

      <section
        aria-labelledby="deployments-heading"
        className="mt-6 rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
      >
        <h2
          id="deployments-heading"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary"
        >
          Deployed contracts
        </h2>
        <div className="mt-4 overflow-x-auto" tabIndex={0} role="region" aria-label="Deployed contracts table">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
                <th className="py-1 font-normal">Contract</th>
                <th className="py-1 font-normal">Chain</th>
                <th className="py-1 font-normal">Address / status</th>
                <th className="py-1 font-normal">Sourcify</th>
              </tr>
            </thead>
            <tbody className="font-mono text-[11px] text-text-primary">
              {DEPLOYMENTS.map((entry) => (
                <tr key={`${entry.label}-${entry.chainId}`} className="border-t border-border-default">
                  <td className="py-2">{entry.label}</td>
                  <td className="py-2 text-text-secondary">{entry.chainId}</td>
                  <td className="py-2">
                    {entry.address ? (
                      <a
                        className="text-brand-cyan underline"
                        href={`https://explorer.test.mezo.org/address/${entry.address}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {entry.address.slice(0, 10)}…{entry.address.slice(-6)}
                      </a>
                    ) : (
                      <span className="text-brand-amber">NOT_DEPLOYED</span>
                    )}
                    {entry.note ? (
                      <span className="block text-[10px] text-text-tertiary">{entry.note}</span>
                    ) : null}
                  </td>
                  <td className="py-2 text-text-secondary">
                    {entry.verified ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section
        aria-labelledby="proofs-heading"
        className="mt-5 rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
      >
        <h2
          id="proofs-heading"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary"
        >
          On-chain proofs
        </h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {PROOFS.map((proof) => (
            <li key={proof.title} className="rounded-md border border-border-default p-3">
              <a
                className="font-mono text-xs text-brand-cyan underline"
                href={proof.href}
                target="_blank"
                rel="noreferrer"
              >
                {proof.title} ↗
              </a>
              <p className="mt-1 text-[11px] text-text-secondary">{proof.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-labelledby="tests-heading"
        className="mt-5 rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
      >
        <h2
          id="tests-heading"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary"
        >
          Test suites
        </h2>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TEST_SUMMARY.map((entry) => (
            <div key={entry.suite} className="rounded-md border border-border-default p-3">
              <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
                {entry.suite}
              </dt>
              <dd className="mt-1 font-mono text-sm tabular-nums text-brand-cyan">{entry.count}</dd>
              <dd className="text-[11px] text-text-secondary">{entry.detail}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section
        aria-labelledby="playground-heading"
        className="mt-5 rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
      >
        <h2
          id="playground-heading"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary"
        >
          Embeddable widget playground
        </h2>
        <p className="mt-3 text-sm text-text-secondary">
          <code className="font-mono text-brand-cyan">@prism-teleport/sdk/PrismTeleportModal</code>{" "}
          is a React-only, wallet-agnostic component: any Base or Mezo dApp can embed
          the whole teleport flow without depending on this frontend (R-018).
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md border border-border-default bg-bg-primary p-3 font-mono text-[11px] text-text-secondary">
{`<PrismTeleportModal
  defaultBorrowMusd="2000"
  onComplete={(tx) => console.log(tx)}
/>`}
        </pre>
        <button
          type="button"
          onClick={() => setPlaygroundOpen(true)}
          className="mt-4 rounded-md border border-brand-cyan px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-brand-cyan transition-colors hover:bg-brand-cyan/10"
        >
          Open the widget
        </button>
        {playgroundOpen ? (
          <PrismTeleportModal
            defaultBorrowMusd="2000"
            onComplete={() => setPlaygroundOpen(false)}
          >
            <button
              type="button"
              onClick={() => setPlaygroundOpen(false)}
              className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-text-secondary underline"
            >
              Close playground
            </button>
          </PrismTeleportModal>
        ) : null}
      </section>

      <section
        aria-labelledby="routes-heading"
        className="mt-5 rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
      >
        <h2
          id="routes-heading"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary"
        >
          Live routes
        </h2>
        <ul className="mt-4 flex flex-wrap gap-3">
          {LIVE_URLS.map((entry) => (
            <li key={entry.path}>
              <Link
                href={entry.path}
                className="rounded-md border border-border-default px-3 py-2 font-mono text-[11px] text-text-secondary transition-colors hover:text-text-primary"
              >
                {entry.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
