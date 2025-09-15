import type { PublicClient } from "viem";
import { getAccountNonce, getRecentBlock, hashChainBatches, getAuthorizationHash } from "./authorization";
import type { SpiceFlowConfig } from "./config";
import type { Authorization, Call } from "./types";
import { submitTransaction } from "./relayer";

export interface Signers {
  /** Sign an EIP‑7702 chain delegation for a given delegate contract & chain. */
  authorizationSigner: (args: { contractAddress: `0x${string}`; chainId: number; nonce: number; address: `0x${string}` }) => Promise<Authorization>;
  /** Sign the final cross‑chain intent hash. */
  messageSigner: (digest: `0x${string}`) => Promise<`0x${string}`>;
}

export class SpiceFlowCore {
  constructor(private cfg: SpiceFlowConfig, private signers: Signers) {}

  getConfig(): SpiceFlowConfig { return this.cfg; }
  getClient(chainId: number): PublicClient { return this.cfg.publicClientForChain(chainId); }

  /**
   * Create EIP‑7702 authorizations for one or more chains.
   * Will load nonces unless explicitly provided.
   */
  async signDelegations(params: { user: `0x${string}`; delegations: { chainId: number; contractAddress: `0x${string}`; nonce?: number }[] }): Promise<Authorization[]> {
    const out: Authorization[] = [] as any;
    for (const d of params.delegations) {
      const client = this.getClient(d.chainId);
      const nonce = typeof d.nonce === 'number' ? d.nonce : await getAccountNonce(params.user, client);
      const auth = await this.signers.authorizationSigner({ contractAddress: d.contractAddress, chainId: d.chainId, nonce, address: params.user });
      // @ts-ignore
      delete (auth as any).v;
      out.push(auth);
    }
    return out;
  }

  /**
   * Build chain authorization batches and return the final intent digest.
   */
  async buildChainBatches(callsByChain: { chainId: number; calls: Call[]; recentBlock?: bigint }[]) {
    const filled = [] as { chainId: number; calls: Call[]; recentBlock: bigint }[];
    for (const c of callsByChain) {
      const recent = typeof c.recentBlock === 'bigint' ? c.recentBlock : await getRecentBlock(this.getClient(c.chainId));
      filled.push({ chainId: c.chainId, calls: c.calls, recentBlock: recent });
    }
    const chainBatches = hashChainBatches(filled);
    const digest = getAuthorizationHash(chainBatches) as `0x${string}`;
    return { chainBatches, digest };
  }

  /** Sign the final intent hash (EIP‑7702). */
  async signIntent(digest: `0x${string}`): Promise<`0x${string}`> { return this.signers.messageSigner(digest); }

  /**
   * Submit a signed intent to the SpiceFlow relayer.
   */
  async submitIntent(req: {
    user: `0x${string}`;
    authorization: Authorization[];
    chainBatches: ReturnType<typeof hashChainBatches>;
    tokenAddress: `0x${string}`;
    tokenAmount: bigint;
    signature?: `0x${string}`; // optional if caller signs digest externally
  }) {
    const signature = req.signature ?? await this.signIntent(getAuthorizationHash(req.chainBatches) as `0x${string}`);
    const resp = await submitTransaction(this.cfg.txApiUrl, {
      tokenAddress: req.tokenAddress,
      tokenAmount: req.tokenAmount,
      address: req.user,
      authorization: req.authorization,
      intentAuthorization: { signature, chainBatches: req.chainBatches },
    } as any);
    return resp;
  }
}
