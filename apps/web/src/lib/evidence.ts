/**
 * Machine-readable mirror of `contracts/deployments/*.json` for the `/evidence`
 * portal (R-019): judges can see exactly what is deployed, where it is verified
 * and which proofs cover it, without reading the repository.
 */

export interface DeploymentEntry {
  label: string;
  address?: string;
  chainId: number;
  verified?: "exact_match";
  status?: "NOT_DEPLOYED";
  note?: string;
}

export const DEPLOYMENTS: DeploymentEntry[] = [
  {
    label: "PrismBorrowLockRouter",
    address: "0x7D536A4d33446d556CC8f6758ada141a17e0968b",
    chainId: 31611,
    verified: "exact_match",
  },
  {
    label: "PrismTokenizer",
    address: "0x7c2d76a696Fba9A12268f12d062AE04b7c4C20B3",
    chainId: 31611,
    verified: "exact_match",
  },
  {
    label: "PrismYieldAMM",
    address: "0xa40D6d099c8e5e86841367Ed384EDD09859bA979",
    chainId: 31611,
    verified: "exact_match",
  },
  {
    label: "PrismFeeStaking",
    address: "0xE5E0905F3c0b084cDc9221cA44146A6B4bD143a7",
    chainId: 31611,
    verified: "exact_match",
  },
  {
    label: "PrismMicroVault (v2)",
    address: "0x3cfFBCD4259ce3dCC49C2e2214C9b0CBcbAC7f78",
    chainId: 31611,
    verified: "exact_match",
  },
  {
    label: "TeleportHub",
    address: "0x4992cE73548f42a4fc3C4685f965ea6C6d1AC401",
    chainId: 31611,
    verified: "exact_match",
  },
  {
    label: "TeleportSpoke",
    chainId: 84532,
    status: "NOT_DEPLOYED",
    note: "Deployer holds 0 ETH on Base Sepolia; script and tests are ready.",
  },
  {
    label: "Capped production suite",
    chainId: 31612,
    status: "NOT_DEPLOYED",
    note: "Deployer holds 0 BTC on Mezo Mainnet; cap, rehearsal and script are ready.",
  },
];

export interface ProofEntry {
  title: string;
  detail: string;
  href: string;
}

export const PROOFS: ProofEntry[] = [
  {
    title: "Milestone 1 live E2E",
    detail: "Stake, mint PT/YT, swap PT, inject yield and claim it — 5 confirmed 31611 transactions.",
    href: "https://explorer.test.mezo.org/address/0x7c2d76a696Fba9A12268f12d062AE04b7c4C20B3",
  },
  {
    title: "Router v2 deployment",
    detail: "The borrow-and-lock router after the receive() fix, Sourcify exact_match.",
    href: "https://sourcify.dev/#/lookup/0x7D536A4d33446d556CC8f6758ada141a17e0968b",
  },
  {
    title: "Gasless relay",
    detail: "A real full-path borrow-and-lock executed against live 31611 state in the fork suite.",
    href: "https://explorer.test.mezo.org/address/0x7D536A4d33446d556CC8f6758ada141a17e0968b",
  },
  {
    title: "TeleportHub rescue escrow",
    detail: "STRIDE-05: a failed on-chain leg credits 100% of the BTC without reverting the relay.",
    href: "https://explorer.test.mezo.org/address/0x4992cE73548f42a4fc3C4685f965ea6C6d1AC401",
  },
];

export const TEST_SUMMARY = [
  { suite: "Foundry (contracts)", count: "152 passing", detail: "unit, fuzz, invariant and fork suites" },
  { suite: "Relayer (API + workers)", count: "46 passing", detail: "hints, relay, markets/positions, teleport" },
  { suite: "SDK", count: "9 passing", detail: "embeddable modal + intent building" },
  { suite: "Web (unit)", count: "50 passing", detail: "carry math, terminal, staking, compliance" },
  { suite: "Playwright + axe-core", count: "15 passing", detail: "0 violations at 360px and 1280px" },
];

export const LIVE_URLS = [
  { label: "Landing & carry calculator", path: "/" },
  { label: "Prism fixed-income terminal", path: "/prism" },
  { label: "MEZO staking portal", path: "/stake" },
  { label: "Cross-chain teleport", path: "/teleport" },
];
