"use client";

import {
  darkTheme,
  RainbowKitProvider,
  type WalletList,
} from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
// Deep imports on purpose: the package barrel re-exports its own UI components,
// which pull in `@mezo-org/mezo-clay` and that bundle reads the React 18-only
// `ReactCurrentOwner` internal, crashing Next's prerender on React 19. We use
// RainbowKit's ConnectButton instead, so only config + chains are needed.
import {
  getConfig,
  okxWalletMezoTestnet,
  unisatWalletMezoTestnet,
  xverseWalletMezoTestnet,
} from "@mezo-org/passport/dist/src/config";
import {
  mezoMainnet,
  mezoTestnet,
} from "@mezo-org/passport/dist/src/constants";
import {
  injectedWallet,
  metaMaskWallet,
  rabbyWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useAccount, useChainId, useSwitchChain, WagmiProvider } from "wagmi";
import { JudgeModeProvider } from "./judgeMode";

/**
 * Unified wallet provider (R-015): wagmi + Mezo Passport, which layers Bitcoin
 * wallets (Unisat, Xverse, OKX) on top of RainbowKit's EVM wallets (MetaMask,
 * Rabby, Rainbow) and routes Mezo transactions through the wallet's smart
 * account. Both Mezo chains are configured so the header can switch between
 * Testnet 31611 and Mainnet 31612.
 */

/**
 * A usable WalletConnect (Reown) project id is exactly 32 hex characters.
 *
 * The connector is created eagerly when WalletConnect is in the wallet list, and
 * an invalid id makes its `setup()`/`getProvider()` throw — which aborts the whole
 * connect modal, so even MetaMask never prompts. The id is therefore validated
 * here and WalletConnect is only offered when it is real.
 */
const RAW_WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

export const WALLETCONNECT_ENABLED = /^[0-9a-f]{32}$/i.test(
  RAW_WALLETCONNECT_PROJECT_ID,
);

/** Syntactically valid placeholder when WalletConnect is unavailable. */
export const WALLETCONNECT_PROJECT_ID = WALLETCONNECT_ENABLED
  ? RAW_WALLETCONNECT_PROJECT_ID
  : "00000000000000000000000000000000";

export const MEZO_CHAIN_IDS = { testnet: 31611, mainnet: 31612 } as const;

/**
 * Explicit wallet list: Bitcoin wallets from Mezo Passport plus the EVM wallets
 * the blueprint asks for. Declaring it also keeps RainbowKit's newer
 * "Base Account" default out of the bundle, whose Coinbase SDK chain pulls a
 * missing optional dependency (`@x402/core/client`) and breaks `next build`.
 */
const PRISM_WALLETS: WalletList = [
  {
    groupName: "Bitcoin",
    wallets: [
      unisatWalletMezoTestnet,
      okxWalletMezoTestnet,
      xverseWalletMezoTestnet,
    ],
  },
  {
    groupName: "Ethereum",
    wallets: [metaMaskWallet, rabbyWallet, rainbowWallet, walletConnectWallet],
  },
] as WalletList;

/**
 * Minimal list used when WalletConnect is not configured.
 *
 * The vendor bundle's SDK-backed connectors (WalletConnect, the MetaMask SDK,
 * Mezo Passport's orangekit/Gelato layer) can throw while they initialise, and an
 * exception in one connector aborts the whole connect modal — MetaMask included.
 * `injectedWallet` talks to `window.ethereum` directly, so no SDK is loaded and
 * MetaMask, Rabby and Brave all work.
 */
const INJECTED_ONLY_WALLETS: WalletList = [
  { groupName: "Browser wallet", wallets: [injectedWallet] },
];

/** WalletConnect needs a real project id; without one, stay SDK-free. */
const ACTIVE_WALLETS: WalletList = WALLETCONNECT_ENABLED
  ? PRISM_WALLETS
  : INJECTED_ONLY_WALLETS;

export function PrismWeb3Provider({ children }: { children: ReactNode }) {
  // Created lazily on the client: wallet connectors touch `window` and must not
  // run during the server render (Next.js 15 + wagmi SSR hydration).
  const [config] = useState(() =>
    getConfig({
      appName: "PrismTeleport",
      appDescription: "Fixed-carry Bitcoin banking and sMUSD yield stripping on Mezo",
      walletConnectProjectId: WALLETCONNECT_PROJECT_ID,
      mezoNetwork: "testnet",
      chains: [mezoTestnet, mezoMainnet],
      wallets: ACTIVE_WALLETS,
      ssr: true,
    }),
  );
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          initialChain={mezoTestnet}
          theme={darkTheme({
            // Match the terminal's palette: cyan on near-black clears WCAG AA,
            // which RainbowKit's default accent does not.
            accentColor: "#22D3EE",
            accentColorForeground: "#0B0E14",
            borderRadius: "small",
          })}
        >
          <JudgeModeProvider>{children}</JudgeModeProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

/** Header network switcher state (Testnet 31611 <-> Mainnet 31612). */
export function usePrismNetwork() {
  const chainId = useChainId();
  const { isConnected } = useAccount();
  const { switchChain, isPending } = useSwitchChain();

  const isTestnet = chainId !== MEZO_CHAIN_IDS.mainnet;
  return {
    chainId,
    isTestnet,
    isConnected,
    isSwitching: isPending,
    label: isTestnet ? "Testnet 31611" : "Mainnet 31612",
    switchTo: (target: number) => switchChain({ chainId: target }),
  };
}
