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

## Milestone 1 — Prism Core Smart Contracts

| Step | Name | Status |
| --- | --- | --- |
| 1.1 | `PrismFeeStaking` MEZO precompile staking, fee tiers & MUSD revenue | DONE |
| 1.2 | `DualTrackAdapter` unstaked sMUSD vs. gauge routing | DONE |
| 1.3 | `PrismTokenizer`, PT & YT tokens with smoothed index | PENDING |
| 1.4 | `PrismYieldAMM` time-decay curve & flash-mint netting | PENDING |
| 1.5 | 65,536-run invariants, Slither audit & live 31611 E2E | PENDING |

## Milestones 2–5

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

## Step 1.1 evidence

- `contracts/src/core/PrismFeeStaking.sol`: MEZO precompile staking with `stake`, `stakeWithPermit`, `unstake`, `claimRewards`, `notifyRewardAmount`, `pendingMusd`, and `getFeeDiscountBps`.
- MasterChef-style `accMusdPerMezo` (1e18 precision), `unallocatedMusdBuffer` for pre-staker revenue, and a dust buffer so rounding never strands MUSD.
- `StakeInfo` is packed into two storage slots (`uint128 amount`, `uint64 lastStakeTimestamp`, `uint128 rewardDebt`, `uint128 claimableMusd`) with checked casts.
- 1-hour `DISCOUNT_COOLDOWN`; tiers at `10/100/500 MEZO` = `1000/2500/5000 bps`; top-ups reset the cooldown.
- `stakeWithPermit` uses a low-level precompile call, normalizes `v < 27` to `27/28`, accepts either 32-byte `bool` or empty return data, and rejects other return lengths.
- `contracts/test/unit/PrismFeeStaking.t.sol`: **18/18 passing** (incl. 3 fuzz suites at 1,000 runs). Coverage: **100% lines (74/74), 100% statements (78/78), 100% functions (11/11), 78.12% branches**, all above the 90% line gate.
- `contracts/test/fork/PrismFeeStakingFork.t.sol`: **2/2 passing** against live 31611 state. The real precompile storage is unavailable under Foundry's revm fork, so the lifecycle test etches a mock at the canonical MEZO address; the metadata test verifies the real address and documents the limitation.
- Local Anvil fork deploy: `0x7188450134eFbda4591D303dA02BE644Bb4B63Fb`.
- **Live deploy (2026-10-26):** `0xE5E0905F3c0b084cDc9221cA44146A6B4bD143a7`, tx `0xe48361416eeba4259778fab2e5f7c56cda6cdef06d242b3c7ccd80fc8e9ee06e`, block `16380737`, gas `964,263`.
- Sourcify: **exact_match** (job `fa17d92a-526e-4374-94f3-f4dea1fc8b5b`).
- Live reads: `mezoToken()` = `0x7B7c000000000000000000000000000000000001`, `musdToken()` = canonical testnet MUSD, `getFeeDiscountBps(unstaked)` = `0`.
- Live smoke: staked `1 MEZO` in tx `0xce392b...d85d` (`81,438` gas, below the `110,000` target), then unstaked in tx `0x6b3ca1...9184` (`41,295` gas). `totalMezoStaked()` returned to `0`; MEZO balance restored to `100e18`.
- Deployment record: `contracts/deployments/31611.json` now has a `contracts` map with both M0 and M1 entries.

### Step 1.1 deviations

- Claim gas is not measured live yet because the deployer has `0 MUSD`; it will be exercised in the Step 1.5 E2E after MUSD is minted/borrowed.
- The live MEZO precompile `transferFrom` is much cheaper than the OpenZeppelin mock used in unit gas reports (`stake` 81,438 gas live vs. 117,560 mock). The live number is the authoritative one.

## Step 1.2 evidence

- `contracts/src/core/DualTrackAdapter.sol`: sMUSD custody with `UNSTAKED_SMUSD` and `GAUGE_STAKED_MEZO` modes, `50 bps` hysteresis, tokenizer-only deposits/withdrawals, permissionless `evaluateAndSwitchMode()`, automatic gauge withdrawal on redemption, and permissionless MEZO harvest forwarding to the tokenizer.
- `contracts/src/mocks/MockMUSDSavingsGauge.sol`: testnet gauge stand-in implementing `IMUSDSavingsGauge` (`deposit`, `withdraw`, `getReward`, `rewardRate`, `balanceOf`).
- `contracts/src/interfaces/IMezoCore.sol`: added `IMUSDSavingsGauge`.
- `contracts/test/unit/DualTrackAdapter.t.sol`: **18/18 passing** (incl. 2 fuzz suites at 1,000 runs). Coverage: **100% lines (65/65), 100% statements (70/70), 100% functions (12/12), 96.97% branches (32/33)** for `DualTrackAdapter`.
- Gas: `evaluateAndSwitchMode()` max **124,222** (target `< 145,000`); `depositSmusd` max **110,956**.
- `contracts/test/fork/DualTrackAdapterFork.t.sol`: **1/1 passing** on live 31611 state. Uses the deployed `TestnetFeeInjector` ABI, real testnet MUSD/sMUSD addresses, a mock MEZO at the canonical precompile, and a mock gauge; covers deposit, switch, harvest, withdraw, and unstake.
- Local Anvil fork deploy succeeded: gauge `0x3253cc93878f1790427e77b98c7Ce8Cc90276Fb2`, adapter `0x82af04cf8Ef50A94707Adb55182592e48c4a6CC8` (same addresses as live because the deployer nonce sequence is identical).
- **Live deploy (2026-10-26):** `MockMUSDSavingsGauge` at `0x3253cc93878f1790427e77b98c7Ce8Cc90276Fb2`, tx `0x547e6c75...b90616`, block `16380872`, gas `332,718`; `DualTrackAdapter` at `0x82af04cf8Ef50A94707Adb55182592e48c4a6CC8`, tx `0x2aacf122...b34c3`, block `16380874`, gas `1,118,310`.
- Sourcify: **exact_match** for both (gauge job `8c626fb4-0f1e-4a50-83be-20009ce14270`, adapter job `061d4b76-171e-42a4-aefa-5623f6ec9624`).
- Live reads: `activeMode()` = `0`, `totalSmusdControlled()` = `0`, `tokenizer()` = zero, `gauge()` = mock gauge, `smusd()` = testnet `TestnetFeeInjector`.
- Deployment record and `progress.md` updated; all `forge test` suites pass.

### Step 1.2 deviations

- The plan did not specify how `gaugeAprBps` / `unstakedAprBps` reach the adapter. Added tokenizer-only `setAprs(uint256 gaugeMezoAprBps, uint256 unstakedFeeAprBps)`; `PrismTokenizer` will own the oracle/keeper handoff in Step 1.3. `evaluateAndSwitchMode()` remains permissionless and uses the last tokenizer-set values.
- The testnet gauge is a mock, as allowed by the plan (`gauge == address(0)` and zero-emission epochs are supported).
- `initializeTokenizer` is intentionally uncalled on live 31611; Step 1.3 will bind the deployed `PrismTokenizer`.
