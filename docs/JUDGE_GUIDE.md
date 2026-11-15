# PrismTeleport — Judge Testing Guide

Everything below can be done in a browser with **no installation, no wallet, and no
testnet funds**. Every number on screen is read live from Mezo Testnet.

**Live app:** https://prismteleport.vercel.app
**Source:** https://github.com/asdspal/prismteleport

---

## 1. What you are looking at (30 seconds)

PrismTeleport is a **fixed-income market for Bitcoin on Mezo**.

You borrow MUSD against your BTC, then lock that MUSD into **PT-sMUSD**, a token that
redeems for exactly 1 MUSD at maturity. If your Trove costs 1% to borrow and the lock
pays 5%, you have **locked in a 4% spread** regardless of what BTC does afterwards —
the locked principal is immune to price moves because it is no longer in BTC.

The app is four screens plus an evidence portal:

| Screen | What it does |
|---|---|
| `/` | Read-only carry calculator, BTC shock simulator, live series table |
| `/prism` | The terminal: 1-signature borrow & lock, PT/YT swap/mint/redeem, dual-track monitor |
| `/stake` | Stake MEZO for a fee discount, claim streamed MUSD fees |
| `/teleport` | Borrow on Mezo from Base with one signed intent (cross-chain) |
| `/evidence` | Every deployment, proof transaction and test count, plus the embeddable widget |

---

## 2. Start here — no wallet needed

Open https://prismteleport.vercel.app. In the top-right you will see a badge reading
**`direct on-chain RPC mode · block #…`**. That is deliberate: the app reads Mezo
directly through Multicall3 from your browser, so it works with **no backend server at
all**. If the block number is advancing, you are looking at live chain state.

### 2.1 The carry calculator (`/`)

1. Leave collateral at `0.05` and borrow at `2000`, series **12-week**.
2. Read the four figures: **Trove borrow APR** (≈1.00%), **PT-sMUSD fixed APY**
   (≈5.00%), **Net guaranteed spread** (≈4.00%), and **PT received today**.
3. Drag **What if BTC moves?** to `-40%`.

**What you should see:** the ICR and liquidation price recompute live, and the note
still reads *"redeems for exactly 1.00 MUSD per PT"*. That is the whole product thesis:
the BTC move cannot touch the locked leg.

**Verify it is not hardcoded:** the page footer of each metric names its contract
(`Mezo InterestRateManager`, `PrismYieldAMM quote`, `coll×price÷debt`), and the header
cites the block height the figures came from. Refresh and the numbers move with the
market.

### 2.2 Inspect a real, live position (no wallet)

Click **Inspect Live Demo Trove** in the header. The app now shows a **real funded
position** on Mezo Testnet belonging to a project wallet:

- Trove collateral ≈ `0.048 BTC`, debt ≈ `2,403 MUSD`, ICR ≈ `131%`
- `20.027 PT`, `1,010 YT` held across two maturities
- `50 MEZO` staked → a 10% fee discount

This is the point of the judge mode: you can audit an actual position without owning
a wallet, a key, or a single satoshi of testnet BTC.

### 2.3 The terminal (`/prism`)

The position summary at the top is the same live data. Below it are three cards:

- **1-signature borrow & lock** — the headline flow. Note the line
  `Hints ready from /v1/hints · ~5.7M gas saved via HintHelpers` when the API is
  reachable; without it the hints are computed in-browser by the same SDK.
- **PT / YT swap & mint** — switch between *Buy PT-sMUSD (fixed)*, *Buy YT-sMUSD
  (leverage)* and *Mint / Redeem / Claim*. The leverage tab shows the flash-mint
  netting: notional received, MUSD refunded, and the effective exposure multiple.
- **Dual-track sMUSD monitor** — the live adapter mode (`UNSTAKED_SMUSD` vs
  `GAUGE_STAKED_MEZO`), both track APRs, and the smoothed-vs-spot rate gap that
  prevents sandwiching a fee drop. The **`[TESTNET SIMULATOR]`** button is clearly
  labelled as a testnet-only affordance.

Write buttons stay disabled until a wallet is connected — see §3.

### 2.4 MEZO staking (`/stake`)

The three discount tiers are visible immediately: **10 MEZO → 10%**, **100 → 25%**,
**500 → 50%**, with the active tier marked from live `getFeeDiscountBps`. The demo
position shows `50 MEZO` staked and a 10% discount, plus the **1-hour anti-flash-stake
cooldown** countdown if a stake happened recently.

### 2.5 Cross-chain teleport (`/teleport`)

Choose an origin (**Base Sepolia 84532** or **Mezo Direct 31611** — the second is the
lag-proof path), pick a destination action, and type a small borrow such as `25`. The
page **auto-detects that anything under 1,800 MUSD must route through the shared
micro-vault** and says so, because Mezo refuses to open a standalone Trove below that
minimum. The three-step receipt below (`Source transaction → Mezo TeleportHub →
Receipt`) is where a real teleport is tracked.

### 2.6 Evidence portal (`/evidence`) — start here if you are short on time

This is the audit trail in one page:

- **Deployed contracts** with chain, explorer links and Sourcify status. Every testnet
  contract reads `exact_match`.
- **On-chain proofs** — the Milestone 1 live cycle (stake → mint PT/YT → swap → inject
  yield → claim), the router redeploy, the gasless relay run, and the rescue-escrow
  test.
- **Test suites** — Foundry 152, relayer 46, SDK 9, web 57 unit, Playwright 18.
- **Embeddable widget playground** — click **Open the widget** to run the real
  `<PrismTeleportModal />` component that a third-party Base or Mezo dApp can drop in
  with two lines of code.
- It also **lists what is not deployed and why** (§6), rather than omitting it.

---

## 3. What needs a wallet (optional)

Write flows — borrow & lock, swaps, staking, teleport — need a wallet. The demo wallet
is a project wallet, so the quickest path is to ask us for a funded testnet key.

If you want to do it yourself:

1. Install MetaMask and add Mezo Testnet: RPC `https://rpc.test.mezo.org`, chain ID
   `31611`, symbol `BTC`, explorer `https://explorer.test.mezo.org`.
2. Get testnet BTC from the Mezo faucet, open a Trove with at least **1,800 MUSD** of
   debt (Mezo's protocol minimum), then use **1-signature borrow & lock** to lock an
   additional amount.
3. The connect button offers **Browser wallet** (MetaMask, Rabby, Brave). WalletConnect
   is only offered when a valid Reown project ID is configured; injected wallets need
   nothing.

**You do not need a wallet to evaluate the product** — the read-only screens show the
same live data, and the write flows are proven by the transaction links in
`/evidence`.

---

## 4. Verify the claims yourself

| Claim | How to check |
|---|---|
| Contracts are deployed and match the source | Sourcify `exact_match` links on `/evidence`; open any address on https://explorer.test.mezo.org |
| The app reads live chain state | The `block #…` in the header advances; refresh the calculator and the price moves |
| It works with no backend | The badge says `direct on-chain RPC mode`; there is no server behind this deployment |
| The full borrow-and-lock path works | `contracts/test/fork/PrismBorrowLockRouterFork.t.sol` (13 tests) and the relayer's fork suite execute it against live 31611 state |
| The rescue escrow never strands funds | `contracts/test/fork/TeleportHubFork.t.sol` — a forced failure credits 100% of the BTC and the relay does not revert |
| Accessibility | `pnpm --filter @prism-teleport/web test:e2e` — 18 tests across five routes at 360×800 and 1280×800 with **0 axe-core violations** |

Reproduce the whole suite locally:

```bash
git clone https://github.com/asdspal/prismteleport
cd prismteleport && pnpm install
pnpm test:contracts        # Foundry: 152 tests
pnpm test                  # relayer 46, SDK 9, web 57
pnpm --filter @prism-teleport/web test:e2e   # Playwright + axe: 18
```

---

## 5. How it fits together

```
Browser (Next.js, no backend required)
  │  reads live state via Multicall3 ─────────────► Mezo Testnet 31611
  │  optional: POST /v1/relay/borrow-and-lock ────► Gasless relayer (Fastify)
  ▼
PrismBorrowLockRouter ─► Mezo BorrowerOperations (opens/extends the Trove)
        └─► PrismYieldAMM ─► locks MUSD into PT-sMUSD ─► borrower
PrismTokenizer ─► mints/splits PT + YT, smoothed yield index
DualTrackAdapter ─► routes sMUSD between unstaked and gauge-staked tracks
PrismFeeStaking ─► MEZO staking → fee discount + MUSD fee stream
TeleportHub (Mezo) + TeleportSpoke (Base) ─► cross-chain intent + rescue escrow
PrismMicroVault ─► shared Trove so sub-1,800 MUSD borrows are possible
```

Key invariants the contracts enforce:

- **Zero custody:** the router asserts it holds 0 MUSD and 0 BTC at the end of every
  relayed transaction; the relayer fee is capped at 1% and paid only to a third party.
- **Minimum safety:** the router refuses a post-borrow ICR below 150%, and the micro
  vault requires 175% per sub-account.
- **Never stranded:** if a cross-chain leg fails mid-flight, 100% of the BTC is credited
  to the borrower's rescue escrow, claimable at any time.

---

## 6. Deliberate limitations

Stated plainly, because a judge should not have to discover them:

| Not deployed | Why | What exists instead |
|---|---|---|
| Capped production suite on Mezo **Mainnet** (31612) | The deployer holds 0 BTC on mainnet | The 2,500 MUSD issuance cap is implemented in `PrismTokenizer`, with a rehearsal suite (`MainnetCappedRehearsalFork.t.sol`, 4/4) and a ready deploy script |
| `TeleportSpoke` on **Base Sepolia** | The deployer holds 0 ETH there | The contract is implemented and tested; `DeployTeleportSuite.s.sol` is ready to broadcast |
| Micro-vault **master Trove** | Activating it needs ~0.056 BTC of collateral, which the deployer does not hold | The vault is deployed and verified; `activateMasterTrove` is permissionless and the micro flow is covered by unit and fuzz tests |

Everything else — the tokenizer, AMM, adapter, fee staking, router, micro vault and
teleport hub — is deployed and Sourcify-verified on Mezo Testnet 31611.

---

## 7. Troubleshooting

| What you see | Why | Action |
|---|---|---|
| Badge says `direct on-chain RPC mode` | No API server is deployed with this build; the app reads Mezo directly | Nothing — this is the zero-backend design |
| A console warning about `localhost:8080` | The app tries the API, it is not there, then falls back to chain reads | Harmless; ignore it |
| Connect shows only **Browser wallet** | WalletConnect needs a Reown project ID, which is not configured here | Use MetaMask/Rabby/Brave, or ask us for the funded demo key |
| `Mezo requires a 1,800 MUSD minimum` | A standalone Trove cannot borrow less | Use the micro-vault path (`/teleport` auto-selects it) |
| The 4-week series shows a negative carry | It matures 2026-11-19, so the fixed 5 bps swap fee exceeds four days of discount | Use the 12-week series, which quotes a positive carry |
| Numbers look slightly different from this guide | BTC price and debt accrue continuously | Everything is live; treat figures as ±1% |
