# PrismTeleport — Progress Tracker

Plan: `memory-bank/implementation-plan.md` (M0–M5, 24 requirements `R-001`..`R-024`).

## Milestone 0 — Foundation, RPC Verification & First On-Chain Test

| Step | Name | Status |
| --- | --- | --- |
| 0.1 | Monorepo, environment config & Foundry workspace | DONE |
| 0.2 | Mezo core interfaces + live fork verification (31611/31612) | DONE |
| 0.3 | TestnetFeeInjector build/test/deploy+verify on 31611 | DONE |
| 0.4 | PostgreSQL 16 + Redis 7.4 + schema migration tests | DONE |
| 0.5 | Fastify server + resilient Mezo RPC client (`/v1/health`) | DONE |
| 0.6 | Next.js 15 shell, design tokens, WCAG/a11y suite | DONE |

## Milestones 1–5

PENDING.

---

## Step 0.1 evidence

- `forge build` and `forge test` pass (2/2 SetupSmoke tests).
- Local Anvil chain id `31611`; live RPC chain ids `31611` (testnet) and `31612` (mainnet).
- Toolchain: Foundry 1.8.5 (solc 0.8.28), forge-std 1.17.0, OpenZeppelin 5.1.0.
- Commit: `chore(setup): initialize monorepo and foundry 0.8.28 workspace [Step 0.1] [R-017]`.

## Step 0.2 evidence

Live reads at testnet block `16379698` and mainnet block `12777165` (2026-10-26).

| Value | Testnet 31611 | Mainnet 31612 |
| --- | --- | --- |
| MUSD | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` | `0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186` |
| BorrowerOperations | `0xCdF7028ceAB81fA0C6971208e83fa7872994beE5` | `0x44b1bac67dDA612a41a58AAf779143B181dEe031` |
| BorrowerOperationsSignatures | `0xD757e3646AF370b15f32EB557F0F8380Df7D639e` | `0xB57ab578BF20b3e318f3EFAA587C51DBccE5df7a` |
| sMUSD | not deployed | `0xb4D498029af77680cD1eF828b967f010d06C51CC` |
| NTT Manager | `0x20888B20e2F5F405d44261dA96467a1b1acE15be` | `0x7efb386675d75280D39Aae42964A6776DE0ee0bD` |
| BTC/USD (`1e18`) | `80233.588850` | `80231.895480` |
| SortedTroves size | `342` | `1` |
| MEZO precompile decimals | `18` | `18` |

- `borrowerOperations.musd()` matches the canonical MUSD on both chains (impostor guard).
- `borrowerOperationsSignatures.borrowerOperations()` points at the canonical BorrowerOperations.
- NTT: token = MUSD, Wormhole chain id `50`, LOCKING mode, threshold `1`.
- Mainnet sMUSD probe: deposit `1,000 MUSD` mints `1,000 sMUSD`; withdraw burns the same shares and returns `1,000 MUSD`. `yieldIndex = 215867387405979216`, `pendingYield = 0`, `totalSupply = 7382555220886352475979905`.

### Verified deviations from the blueprint (deployed ABI wins)

1. **sMUSD is not ERC-4626.** Deposit/withdraw are 1:1. Yield is a separately claimable balance driven by `yieldIndex` (`amount * 1e18 / totalSupply` per distribution), claimed via `claimYield()`. The PT/YT design must use `yieldIndex` for YT accrual and treat PT redemption as 1 sMUSD per PT.
2. **`BorrowerOperations.musd()` is the MUSD getter**, not `musdToken()`.
3. **`BorrowerOperationsSignatures` is a separate contract** from `BorrowerOperations`; use the signatures addresses above.
4. **`PriceFeed.lastGoodPrice()` does not exist**; only `fetchPrice()`.
5. **`PriceFeed.fetchPrice()` and the ERC-20 precompiles cannot execute under Foundry forks** because Mezo's chain-level precompiles (`0x7b7c...0015`, `0x7B7c...0001`, `0x7b7C...0000`) are not implemented by revm. Fork tests verify addresses/selectors and cap the gas; live values are checked with `cast`.
6. **No sMUSD on testnet**, consistent with GAP-001; Step 0.3's `TestnetFeeInjector` remains the testnet adapter.

## Step 0.3 evidence

- `contracts/src/mocks/TestnetFeeInjector.sol`: testnet sMUSD stand-in. 1:1 MUSD deposit/withdraw, cumulative `yieldIndex`, lazy `claimYield()`, `injectWeeklyFeeYield(uint256)` capped at 500 bps of supply with a 60 s cooldown.
- `contracts/test/unit/TestnetFeeInjector.t.sol`: 19 tests pass, including a 1,000-run conservation fuzz. `forge coverage --match-path test/unit/TestnetFeeInjector.t.sol` reports **100% lines/statements/branches/functions** for the injector (64/64 lines, 22/22 branches).
- Gas (cold storage): `deposit` ~150k test call / ~114k contract-only, `injectWeeklyFeeYield` ~116k, `withdraw` ~61k, `claimYield` ~116k. All within the plan's ceilings.
- `contracts/script/DeployTestnetFeeInjector.s.sol`: chain-id guard (31611), MUSD from `MEZO_TESTNET_MUSD_ADDRESS` with canonical fallback, deployer from `--private-key`.
- Local Anvil fork of testnet 31611: deploy succeeded at `0x7188450134eFbda4591D303dA02BE644Bb4B63Fb`; `musdToken()` = canonical testnet MUSD, `name()` = `Testnet sMUSD`, `yieldPerShare()` = `1e18`.
- **Live deploy (2026-10-26):** `TestnetFeeInjector` at `0xd0F748a45708E77bf00384ED1C0ACC2e968517c3` on 31611, tx `0xd281d326b6161922c84b2fa76e2f0ffecb601c4f1e6d65b85d776927737e1f98`, block `16380089`, gas `1,129,736`.
- Deployer `0xfCe44470aC130E66849Aaa23F81D092066ff501E`; remaining testnet BTC after deploy: `0.049999999852004584`.
- Live reads: `musdToken()` = `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`, `name()` = `Testnet sMUSD`, `symbol()` = `tsMUSD`, `yieldPerShare()` = `1e18`.
- Sourcify: **exact_match** (job `637cacf7-7d5a-4d55-8302-9d0c9b692aa3`), `https://sourcify.dev/server/verify-ui/jobs/637cacf7-7d5a-4d55-8302-9d0c9b692aa3`.
- Deployment record: `contracts/deployments/31611.json`; `MEZO_TESTNET_SMUSD_ADDRESS` now points at the adapter.

### Step 0.3 deviation

The plan called this an ERC-4626 vault. Mainnet sMUSD is verified **not** ERC-4626 (1:1 principal + separate `yieldIndex`/`claimYield`). The adapter mirrors the deployed ABI so `PrismTokenizer` has one interface on both networks; ERC-4626 `convertToAssets`/`convertToShares` are intentionally omitted. Mainnet-only extras (`strategy`, `pendingYield`, `vaultGauge`, `pcv`) were removed from `IMUSDSavingsRate`; the fork test uses a local extras interface.

## Step 0.4 evidence

- `docker-compose.yml`: PostgreSQL `16.4-alpine` and Redis `7.4.1-alpine`, healthchecks, persistent volumes, configurable host ports (`POSTGRES_PORT`, `REDIS_PORT`).
- `apps/relayer/migrations/001_init.sql`: exact `blueprint/schema.sql` copy (6 tables, 6 named indexes, CHECK constraints).
- `apps/relayer/src/db/migrate.ts`: `pg` migration runner with `schema_migrations` tracking, advisory lock, per-file transaction, idempotent re-runs, and a direct-execution CLI guard.
- `apps/relayer/test/db-schema.test.ts`: **5/5 passing** — all 6 tables, all 6 named indexes, `chain_id = 99999` rejected with SQLSTATE `23514`, migration idempotency, Redis `PING` = `PONG`.
- `pnpm --filter @prism-teleport/relayer build` (`tsc --noEmit`) passes.
- Manual: `psql \dt` shows the 6 tables plus `schema_migrations`; `pg_indexes` shows the 6 required indexes; `redis-cli ping` returns `PONG`.
- Containers: `prismteleport-postgres-1` and `prismteleport-redis-1` both healthy on `5432`/`6379`.
- Node `22.15.1`, pnpm `9.12.0`, Vitest `2.1.9`.

## Step 0.5 evidence

- `apps/relayer/src/lib/mezoClient.ts`: viem `PublicClient`s for 31611 and 31612, mainnet `fallback()` transport, `getLogsChunked()` with inclusive `<= 9,000` block windows, and `waitForReceiptResilient()` retrying null/not-found receipts.
- `apps/relayer/src/server.ts`: Fastify 5.1.0 with CORS, 100 req/min rate limit, `x-correlation-id` request IDs, and `GET /v1/health`.
- `apps/relayer/test/health-and-rpc.test.ts`: **3/3 passing** — `[1000, 29000]` splits into `[1000-9999, 10000-18999, 19000-27999, 28000-29000]`; null receipt twice then success on attempt 3; live health endpoint.
- Live `curl http://localhost:8080/v1/health` (2026-10-26):
  `{"status":"ok","mezoTestnetBlock":16380171,"mezoMainnetBlock":12777711,"relayerGasBtc":"0.049999999852004584"}`
- `pnpm --filter @prism-teleport/relayer build` (`tsc --noEmit`) passes.

## Step 0.6 evidence

- `apps/web/`: Next.js `15.1.0`, React `19.0.0`, Tailwind `3.4.15`, viem `2.21.54`.
- `blueprint/design-tokens.json` mirrored into the repo; `apps/web/tailwind.config.ts` reads colors, fonts, type scale, radii, and breakpoints from it.
- `apps/web/src/app/layout.tsx` + `page.tsx`: responsive terminal shell, five routes, skip link, primary nav, live Mezo Testnet/Mainnet block badge (direct viem, CORS verified), deployment-status panel.
- `apps/web/test/design-tokens.test.ts`: **3/3 passing** using exact IEC 61966-2-1 sRGB linearization; all 25 active text/background pairs are `>= 4.5:1`.
- `pnpm --filter @prism-teleport/web typecheck`, `lint` (`next lint`), and `build` pass with zero errors.
- Playwright + `@axe-core/playwright`: **2/2 passing** at `360x800` and `1280x800`, `0` violations, `0` horizontal overflow.
- Axe fix: removed a redundant `aria-label` from the wordmark (label-in-name mismatch); the `//` glyph is now a JSX expression to satisfy `react/jsx-no-comment-textnodes`.

### Step 0.6 deviations

- **wagmi omitted for now**: the shell has no wallet connection, so `viem` alone covers the live status. Add wagmi in the wallet/Prism phase.
- **Contrast math vs blueprint**: exact linearization gives `mezoViolet` on `bg.surface` = `4.49:1` (blueprint claims `4.60`). The UI uses violet as a badge background with inverse text (`4.88:1`) and never places violet text on the surface; the test covers the pairs actually used.
- **ESLint** is configured (`eslint-config-next` 15.1.0) and `next lint` reports no warnings/errors.

## Milestone 0 completion (2026-10-26)

- Steps 0.1–0.6 are complete: Foundry workspace, live Mezo interfaces, testnet sMUSD adapter, PostgreSQL/Redis schema, Fastify `/v1/health`, Next.js shell and accessibility gate.
- Live testnet contract: `TestnetFeeInjector` at `0xd0F748a45708E77bf00384ED1C0ACC2e968517c3`, Sourcify `exact_match`.
- Contract tests: 21 unit/fuzz tests pass; injector coverage 100%; both live fork suites pass.
- Relayer tests: 8 pass (5 DB + 3 RPC/health); web tests: 3 pass; Playwright: 2 pass; all TypeScript/ESLint gates pass.
- Known constraints carried into M1: Mezo precompiles cannot execute under revm forks; sMUSD is 1:1 principal + `yieldIndex`, not ERC-4626; testnet sMUSD is the adapter; `slither` is not installed yet.
