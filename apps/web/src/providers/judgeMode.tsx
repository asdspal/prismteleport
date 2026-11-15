"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Address } from "viem";

/**
 * Judge / Inspector mode (R-016): a 1-click switch that points every read at the
 * live Mezo Testnet borrower from Step 1.5, so a reviewer can inspect a real
 * funded position with no wallet, no extension and no signature.
 *
 * Kept in its own module (no wagmi/RainbowKit imports) so it can be unit tested
 * and rendered without the wallet stack.
 */

export const DEMO_BORROWER: Address =
  "0xfCe44470aC130E66849Aaa23F81D092066ff501E";

export interface JudgeModeValue {
  judgeMode: boolean;
  demoAddress: Address;
  setJudgeMode: (on: boolean) => void;
  toggleJudgeMode: () => void;
  /** The address every read should use: the demo trove while inspecting, else the wallet. */
  resolveActiveAddress: (connected?: Address) => Address | undefined;
}

const JudgeModeContext = createContext<JudgeModeValue | undefined>(undefined);

export function JudgeModeProvider({ children }: { children: ReactNode }) {
  const [judgeMode, setJudgeMode] = useState(false);

  const resolveActiveAddress = useCallback(
    (connected?: Address) => (judgeMode ? DEMO_BORROWER : connected),
    [judgeMode],
  );

  const value = useMemo<JudgeModeValue>(
    () => ({
      judgeMode,
      demoAddress: DEMO_BORROWER,
      setJudgeMode,
      toggleJudgeMode: () => setJudgeMode((on) => !on),
      resolveActiveAddress,
    }),
    [judgeMode, resolveActiveAddress],
  );

  return (
    <JudgeModeContext.Provider value={value}>{children}</JudgeModeContext.Provider>
  );
}

export function useJudgeMode(): JudgeModeValue {
  const value = useContext(JudgeModeContext);
  if (!value) {
    throw new Error("useJudgeMode must be used inside <JudgeModeProvider>");
  }
  return value;
}
