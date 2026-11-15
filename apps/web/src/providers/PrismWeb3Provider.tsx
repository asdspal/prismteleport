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

export const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "prismteleport-dev";

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
] as const;

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
      wallets: PRISM_WALLETS,
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
