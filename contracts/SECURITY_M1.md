# Milestone 1 Security & Invariant Report

**Date:** 2026-10-26
**Scope:** Prism Core (`PrismTokenizer`, `PrismYieldAMM`, `PrismFeeStaking`, `DualTrackAdapter`, PT/YT tokens, `PrismSeriesFactory`) plus testnet helpers (`TestnetFeeInjector`, `MockMUSDSavingsGauge`).
**Toolchain:** Solidity `0.8.28`, Foundry `1.8.5`, Slither `0.11.6`, OpenZeppelin Contracts `5.x`.

## 1. Result Summary

| Gate | Target | Result |
|---|---|---|
| Slither High | 0 | **0** |
| Slither Critical | 0 | **0** |
| Slither Medium | 0 unchecked | **25 found, 25 triaged; none exploitable** |
| Stateful invariants | 4/4, 65,536 calls | **4/4 pass, 65,536 calls, 0 reverts** |
| `src/core` line coverage | >= 95% | **99.19% (616/621)** |
| Live 31611 E2E | 5 core transactions | **5/5 confirmed (blocks 16382297-16382302)** |

Slither totals: **0 High, 0 Critical, 25 Medium, 44 Low, 7 Informational**. The Medium findings are reviewed in Section 4; the audit gate requires no *unchecked* Medium, not zero Medium false positives.

## 2. Stateful Invariant Suite

File: `test/invariant/PrismCoreInvariants.t.sol`

- Profile: `[profile.default.invariant] runs = 512`, `depth = 128` -> **65,536 calls**.
- Actors: 5 (`0xA000`..`0xA004`), each funded with `5,000,000 MUSD` and `1,000,000 MEZO`.
- Handler actions: `mintPy`, `redeemPy`, `redeemPtAfterMaturity`, `claimYield`, `swapMusdForPt`, `swapPtForMusd`, `swapMusdForYt`, `injectWeeklyFeeYield`, `evaluateAndSwitchMode`, `stakeMezo`, `unstakeMezo`, `warpTime`, `warpPastMaturity`.
- Guarded no-ops keep every call valid (maturity checks, balance caps, AMM reserve caps, fee-injection cap/cooldown, stake caps). Result: **0 reverts**.
- `fail_on_revert = false` is configured for future guard additions, but the recorded run has no reverts.

Command and result:

```
forge test --match-path test/invariant/PrismCoreInvariants.t.sol
```

```
[PASS] invariant_adapterSolvencyCoversAllPtAndYield
[PASS] invariant_feeStakingBalanceMatchesStakes
[PASS] invariant_ptEqualsYtSupplyBeforeMaturity
[PASS] invariant_smoothedRateNeverExceedsSpotRate
runs: 512, calls: 65536, reverts: 0
```

### Invariant adaptations

- **Invariant 1** uses `adapter.totalSmusdControlled() + MUSD(tokenizer) + MUSD(adapter) >= sum(series.totalPt) + sum(pendingYield(series, holders))`. Holders include all actors and the LP/test holder. This is the concrete form of the plan's "unredeemed PT par + unclaimed vested YT yield".
- **Invariant 3** uses `smoothedExchangeRate() <= 1e18 + smusd.yieldIndex()`. Mezo sMUSD is **not ERC-4626**; the deployed contract has no `convertToAssets`, so `yieldIndex` is the correct spot-rate source.
- **Invariant 4** checks `MEZO.balanceOf(feeStaking) >= feeStaking.totalMezoStaked()`.

### Bug found and fixed by the invariant suite

`TestnetFeeInjector.claimYield()` could underflow `totalClaimable` by **1 wei** after several distributions because aggregate claimable yield was computed with floor rounding while per-user `storedClaimable` was rounded independently. The invariant fuzzer reproduced it (stored `10967521084377828876` vs aggregate `10967521084377828875`).

Fix in `src/mocks/TestnetFeeInjector.sol`:

```solidity
totalClaimable = amount >= totalClaimable ? 0 : totalClaimable - amount;
```

The write-off is bounded by 1 wei per distribution and the contract retains the rounding dust in MUSD. After the fix the 65,536-call suite reports **0 reverts** and all invariants pass. This helper is testnet-only; see the deployment note in Section 5.

## 3. Coverage

Command: `forge coverage --report summary --no-match-path "test/invariant/*"` (invariants excluded from coverage instrumentation; they add no `src/core` lines).

| Contract | Lines | Statements | Branches | Functions |
|---|---:|---:|---:|---:|
| `DualTrackAdapter.sol` | 100.00% (73/73) | 100.00% (80/80) | 94.44% (34/36) | 100.00% (13/13) |
| `PrismFeeStaking.sol` | 100.00% (73/73) | 100.00% (78/78) | 78.12% (25/32) | 100.00% (11/11) |
| `PrismTokenizer.sol` | 98.14% (264/269) | 97.75% (304/311) | 79.35% (73/92) | 100.00% (33/33) |
| `PrismYieldAMM.sol` | 100.00% (177/177) | 96.73% (207/214) | 65.12% (56/86) | 100.00% (17/17) |
| `tokens/PrismPrincipalToken.sol` | 100.00% (10/10) | 100.00% (6/6) | 50.00% (2/4) | 100.00% (4/4) |
| `tokens/PrismSeriesFactory.sol` | 100.00% (5/5) | 100.00% (5/5) | N/A (0/0) | 100.00% (1/1) |
| `tokens/PrismYieldToken.sol` | 100.00% (14/14) | 100.00% (11/11) | 60.00% (3/5) | 100.00% (5/5) |
| **`src/core` aggregate** | **99.19% (616/621)** | **98.01% (691/705)** | **75.69% (193/255)** | **100.00%** |

## 4. Slither Triage

Command:

```
slither . --compile-force-framework foundry --filter-paths "test|script|lib" --exclude-dependencies
```

### Medium (25 reviewed, 0 unchecked)

| Detector | Count | Disposition |
|---|---:|---|
| `divide-before-multiply` | 7 | **Accepted / false positive.** The divisions are intentional floor steps (`fee * (1e4 - discount) / 1e4`, implied-rate and quote math, per-share yield). Reordering would overflow or change the protocol-favouring rounding. Covered by unit, fuzz (10,000 runs), and invariant suites. |
| `incorrect-equality` | 6 | **Accepted / false positive.** Strict comparisons are zero guards (`fee == 0`, `amount == 0`, `totalActiveYt == 0`), not balance or price checks. |
| `reentrancy-no-eth` | 7 | **Accepted.** `PrismTokenizer` external entry points are `nonReentrant`; `_syncYield`, `_claimSmusdYield`, `_harvestMezo`, and `_mintPy` are internal and only reached under the guard. `DualTrackAdapter.evaluateAndSwitchMode()` moves no ETH and only switches between the adapter's own sMUSD/gauge custody; 65,536 invariant calls exercised it. No attacker-controlled reentrant callback exists. |
| `unused-return` | 5 | **Accepted.** Return values are deliberately ignored because the tokenizer re-reads balances/indices or emits its own event. `mintPyFromMusd` is called for its side effect; `harvestGaugeRewards` forwards the full MEZO balance. No user funds depend on the ignored values. |

### Low / Informational

- **`timestamp` (25):** maturity gates, 7-day smoothing, fee-injection cooldown, and staking discount cooldown. Timestamp logic is the requirement (`R-002`, `R-003`); miners can only move it by seconds and the smoothing is monotonic.
- **`calls-loop` (7):** `_finalizeMatured()` reads `smusd.yieldIndex()` once per active series. Series count is keeper-bounded and small; a future version can cache the index outside the loop.
- **`reentrancy-benign` / `reentrancy-events` (12):** event ordering behind `nonReentrant` / adapter calls. No state is read after an untrusted callback.
- **`low-level-calls` (1):** `stakeWithPermit` intentionally calls the MEZO precompile because it does not expose a standard Solidity ABI; return data length is validated and the boolean is checked.
- **`missing-inheritance` (2):** structural interface conformance (`IPrismFeeStaking`, `IPrismTokenizerHook`) is used at call sites; inheriting would add no runtime check.
- **`naming-convention` (4):** ABI-mandated names (`DOMAIN_SEPARATOR`) and constructor parameter style in adapter setters.

## 5. Deployment Note: TestnetFeeInjector Dust Fix

`TestnetFeeInjector` at `0xd0F748a45708E77bf00384ED1C0ACC2e968517c3` was deployed during Milestone 0 and is a **testnet helper**, not one of the four Milestone 1 core contracts. Its deployed bytecode predates the 1-wei `totalClaimable` fix. The fix only affects **multiple** fee distributions followed by a claim; the Milestone 1 live E2E performs a single injection and is unaffected. Re-pointing the core immutables to a new helper would require redeploying the tokenizer, adapter, gauge, and AMM; it is intentionally deferred rather than invalidating the Milestone 1 addresses. Any future helper deployment should be verified from the current source.

## 6. Live E2E

The five core transactions and state deltas are recorded in `deployments/31611-m1-proof.md`. All returned `status = 1`; events include `Staked`, `PyMinted`, `SwappedMusdForPt`, `WeeklyFeeYieldInjected`, and `YieldPaid`.

## 7. Residual Risks

- **Oracle / precompile dependence:** live Mezo precompiles cannot run under Foundry revm, so fork tests etch mocks at canonical addresses. The live E2E is the authoritative precompile check.
- **Smoothing at maturity:** unvested yield at maturity vests to treasury; documented in `progress.md` (Step 1.3 deviation).
- **Helper-only dust:** the deployed helper keeps the pre-fix 1-wei edge case for multi-injection claims; the source fix is covered by the invariant suite.
