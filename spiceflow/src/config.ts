import type { PublicClient } from "viem";

/**
 * Configuration for the generic SpiceFlow core.
 *
 * Consumers provide factories/resolvers for chain-specific details
 * (delegate contract, viem PublicClient, and API base URL).
 */
export interface SpiceFlowConfig {
  txApiUrl: string;
  delegateAddressForChain: (chainId: number) => `0x${string}`;
  publicClientForChain: (chainId: number) => PublicClient;
}
