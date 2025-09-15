import type { Address, Hash, Hex } from "viem";

/** A single call packed into a chain batch. */
export type Call = { to: Address; value: bigint; data: Hex };
/** Signed authorization (EIP‑7702) for a specific chain & delegate contract. */
export type Authorization = {
  address: string;
  chainId: number;
  nonce: number;
  r: string;
  s: string;
  yParity: number;
};

/** Input for hashing a per-chain authorization (preimage). */
export type ChainAuthorizationInput = { chainId: bigint | number; calls: Call[]; recentBlock: bigint | number };
/** Output of hashing: the EIP‑7702 chain authorization tuple. */
export type ChainAuthorization = { hash: Hash; chainId: bigint; calls: Call[]; recentBlock: bigint };
