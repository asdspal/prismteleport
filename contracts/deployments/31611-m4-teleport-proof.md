# Milestone 4 teleport proof (Mezo Testnet 31611)

## What is deployed

| Contract | Address | Tx | Sourcify |
|---|---|---|---|
| `PrismMicroVault` v2 | `0x3cfFBCD4259ce3dCC49C2e2214C9b0CBcbAC7f78` | `0xa91a77645977d50108cb9b3f7e0b42402d17c59a8c1ea0e356c96c5994b910b2` | exact_match (job `5b4ce849-efdd-4e6a-8b9a-07e7592f2600`) |
| `TeleportHub` | `0x4992cE73548f42a4fc3C4685f965ea6C6d1AC401` | `0xd760234a5c9479471116a2d5f26c28e2f44ba708818d2a98ba4e2239fd601619` | exact_match (job `8f152a3e-f0a1-4fa3-ab90-eddea31aacc3`) |

`TeleportSpoke` on Base Sepolia (84532) is **not deployed**: the deployer EOA
`0xfCe44470aC130E66849Aaa23F81D092066ff501E` holds 0 ETH there. See
`deployments/84532.json` for the exact blocker, the ready script and the required
environment variables.

## What is proven, and how

The full cross-chain path is proven by executable tests rather than by a single
live bridge hop, because two of its inputs are unavailable in this environment:
Base Sepolia gas and a funded Mezo master Trove.

1. **Contract level** — `contracts/test/fork/TeleportHubFork.t.sol` (9/9) drives
   the hub against the real Prism stack (tokenizer, AMM, adapter, micro vault)
   with a mock Mezo core and a mock NTT manager that pulls the beamed MUSD:
   - `BORROW_AND_LOCK_PT`: the Trove is opened in the borrower's address and the
     PT lands with the borrower; the hub keeps zero balance.
   - `BORROW_AND_TELEPORT_MUSD`: the MUSD is beamed to Base over the NTT manager
     with the borrower as recipient.
   - `MICRO_TELEPORT`: a 25 MUSD borrow (far under Mezo's 1,800 MUSD minimum) is
     routed through the shared vault and the position is owned by the borrower.
   - `STRIDE-05`: a mid-flight failure (Trove open reverting, or a bad
     `minPtOut`) credits 100% of the BTC to `claimableRescueBtc[borrower]`
     **without reverting the relay**, and `withdrawRescueBtc()` pays it out.
   - Replay, expiry, collateral mismatch, bad signature and the `executeInner`
     self-call guard.
   Coverage: `TeleportHub.sol` 98.15% lines.
2. **Relayer level** — `apps/relayer/test/teleport-intent.test.ts` (11/11) covers
   validation, the `teleport_intents` lifecycle
   (`PENDING_SOURCE`/`SOURCE_CONFIRMED` → `EXECUTING_MEZO` → `COMPLETED` or
   `RESCUED_ESCROW`), the failure path (`FAILED` + `422`), idempotency, the
   micro-intent rule, and the status worker advancing rows from the Mezo receipt.
3. **UI level** — `/teleport` renders the origin/destination selectors, the
   micro auto-detection and the three-step receipt at 360px and 1280px with zero
   axe-core violations (`apps/web/e2e/m3-terminal-and-a11y.spec.ts`).

## What a live hop would still need

1. Fund the Base Sepolia deployer (any amount) and run
   `forge script script/DeployTeleportSuite.s.sol:DeployBaseSpoke`.
2. Seed the vault master Trove (`activateMasterTrove{value: 0.07 ether}`), which
   needs ~0.07 BTC that this deployer does not hold (it has 0.002 BTC).
3. Point the hub at a live MUSD NTT manager; Mezo Testnet has no canonical one,
   so `TeleportHub` currently references the address named in the plan.
