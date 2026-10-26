# PrismTeleport — Progress Tracker

Plan: `memory-bank/implementation-plan.md` (M0–M5, 24 requirements `R-001`..`R-024`).

## Milestone 0 — Foundation, RPC Verification & First On-Chain Test

| Step | Name | Status |
| --- | --- | --- |
| 0.1 | Monorepo, environment config & Foundry workspace | DONE |
| 0.2 | Mezo core interfaces + live fork verification (31611/31612) | DONE |
| 0.3 | TestnetFeeInjector build/test/deploy+verify on 31611 | PENDING |
| 0.4 | PostgreSQL 16 + Redis 7.4 + schema migration tests | PENDING |
| 0.5 | Fastify server + resilient Mezo RPC client (`/v1/health`) | PENDING |
| 0.6 | Next.js 15 shell, design tokens, WCAG/a11y suite | PENDING |

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
