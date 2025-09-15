import { Address, Hash, PublicClient, encodeAbiParameters, keccak256 } from "viem";
import type { Call, ChainAuthorizationInput } from "./types";

/**
 * ABI description of the per-chain signature components used by EIP‑7702
 * to derive the chain authorization hash for a batch of calls.
 */
export const ChainAuthorizationSignatureComponentsAbi = [
  { name: "chainId", type: "uint256" },
  { name: "calls", type: "tuple[]", components: [
    { name: "to", type: "address" },
    { name: "value", type: "uint" },
    { name: "data", type: "bytes" },
  ] },
  { name: "recentBlock", type: "uint256" },
] as const;

/**
 * Hash each chain's call batch into an EIP‑7702 chain authorization tuple.
 */
export function hashChainBatches(chainCalls: ChainAuthorizationInput[]) {
  return chainCalls.map(({ chainId, calls, recentBlock }) => {
    const cid = BigInt(chainId);
    const rb = BigInt(recentBlock);
    const hash = keccak256(
      encodeAbiParameters(ChainAuthorizationSignatureComponentsAbi as any, [cid, calls, rb])
    );
    return { hash, chainId: cid, calls, recentBlock: rb };
  });
}

/**
 * Compute the intent hash from an array of per-chain authorization hashes.
 */
export function getAuthorizationHash(chainAuthorizations: { hash: Hash }[]): Hash {
  const hashes = chainAuthorizations.map(({ hash }) => hash);
  return keccak256(encodeAbiParameters([{ type: "bytes32[]" }], [hashes]));
}

/**
 * Load the account nonce to be used when signing a chain delegation.
 */
export async function getAccountNonce(address: Address, publicClient: PublicClient): Promise<number> {
  return await publicClient.getTransactionCount({ address });
}

/**
 * Fetch a recent block number used as freshness bound for chain batches.
 */
export async function getRecentBlock(publicClient: PublicClient): Promise<bigint> {
  return await publicClient.getBlockNumber();
}
