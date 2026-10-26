import Link from "next/link";

const TRACKS = [
  {
    tag: "TRACK 01",
    title: "Fixed income",
    body: "Split MUSD into PT-sMUSD and YT-sMUSD. Lock a fixed rate or buy the yield leg.",
    href: "/prism",
    accent: "text-brand-cyan",
    border: "hover:border-brand-cyan",
  },
  {
    tag: "TRACK 02",
    title: "One-click teleport",
    body: "Borrow MUSD against BTC on Mezo from Base or Ethereum with one signed intent.",
    href: "/teleport",
    accent: "text-brand-amber",
    border: "hover:border-brand-amber",
  },
];

const METRICS = [
  { label: "Trove borrow rate", value: "—", note: "Awaiting series" },
  { label: "PT fixed APY", value: "—", note: "Awaiting series" },
  { label: "YT implied APY", value: "—", note: "Awaiting series" },
];

export default function HomePage() {
  return (
    <main id="main" className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <section aria-labelledby="hero-heading" className="max-w-3xl">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand-cyan">
          Bitcoin fixed carry · Mezo
        </p>
        <h1
          id="hero-heading"
          className="mt-3 text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl"
        >
          Strip sMUSD yield. Lock the carry.
        </h1>
        <p className="mt-4 max-w-2xl text-base text-text-secondary">
          PrismTeleport turns Mezo&apos;s sMUSD savings rate into a fixed-income
          market, then lets Base and Ethereum BTC collateral open a Mezo trove
          in a single signed intent.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/prism"
            className="rounded-md bg-brand-amber px-4 py-2 text-sm font-semibold text-text-inverse transition-opacity hover:opacity-90"
          >
            Open Prism
          </Link>
          <Link
            href="/teleport"
            className="rounded-md border border-border-default bg-bg-surface px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-bg-hover"
          >
            Open Teleport
          </Link>
        </div>
      </section>

      <section aria-labelledby="metrics-heading" className="mt-10">
        <h2 id="metrics-heading" className="sr-only">
          Market metrics
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {METRICS.map((metric) => (
            <div
              key={metric.label}
              className="rounded-lg border border-border-default bg-bg-surface p-4"
            >
              <p className="text-xs text-text-secondary">{metric.label}</p>
              <p className="mt-2 font-mono text-2xl text-text-primary">
                {metric.value}
              </p>
              <p className="mt-1 text-xs text-text-secondary">{metric.note}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="tracks-heading" className="mt-10">
        <h2
          id="tracks-heading"
          className="text-sm font-semibold uppercase tracking-[0.16em] text-text-secondary"
        >
          Two tracks
        </h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {TRACKS.map((track) => (
            <Link
              key={track.tag}
              href={track.href}
              className={`rounded-lg border border-border-default bg-bg-surface p-5 transition-colors ${track.border}`}
            >
              <p className={`font-mono text-xs uppercase tracking-[0.18em] ${track.accent}`}>
                {track.tag}
              </p>
              <h3 className="mt-2 text-xl font-semibold text-text-primary">
                {track.title}
              </h3>
              <p className="mt-2 text-sm text-text-secondary">{track.body}</p>
            </Link>
          ))}
        </div>
      </section>

      <section
        aria-labelledby="status-heading"
        className="mt-10 rounded-lg border border-border-default bg-bg-muted p-5"
      >
        <h2 id="status-heading" className="text-sm font-semibold text-text-primary">
          Deployment status
        </h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-text-secondary">Mezo Testnet</dt>
            <dd className="font-mono text-text-primary">31611</dd>
          </div>
          <div>
            <dt className="text-text-secondary">Base Sepolia</dt>
            <dd className="font-mono text-text-primary">84532</dd>
          </div>
          <div>
            <dt className="text-text-secondary">Testnet sMUSD adapter</dt>
            <dd className="break-all font-mono text-xs text-text-primary">
              0xd0F748a45708E77bf00384ED1C0ACC2e968517c3
            </dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
