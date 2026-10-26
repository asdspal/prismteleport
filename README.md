# PrismTeleport

"1-Click Fixed-Carry Bitcoin Banking & sMUSD Yield-Stripping Protocol" for the Mezo Buildathon (Wave 2).

## Quickstart

```bash
pnpm install                       # install JS workspace deps
cd contracts && forge build        # compile Solidity 0.8.28
cd contracts && forge test         # unit + fuzz tests
```

Requires Node.js >= 22.11.0, pnpm >= 9.12.0, Foundry (forge/cast/anvil), Docker.

## Layout

- `contracts/` — Foundry workspace (Solidity 0.8.28, OpenZeppelin 5.1.0, `evm_version = "paris"`)
- `apps/relayer/` — Fastify hint/relayer API, indexer (PostgreSQL 16 + Redis 7.4)
- `apps/web/` — Next.js 15 terminal UI
- `packages/sdk/` — shared hint/multicall readers and `<PrismTeleportModal />`
- `memory-bank/` — locked blueprint, requirements, and implementation plan

## Networks

| Network | Chain ID | Explorer |
| --- | --- | --- |
| Mezo Testnet | 31611 | https://explorer.test.mezo.org |
| Mezo Mainnet | 31612 | https://explorer.mezo.org |
| Base Sepolia | 84532 | https://sepolia.basescan.org |

Configuration is documented in `.env.example`. Never commit real keys.
