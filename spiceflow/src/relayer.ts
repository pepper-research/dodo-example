/**
 * Request payload to submit an EIP‑7702 intent via the SpiceFlow relayer.
 * Values like bigint are stringified for transport.
 */
export interface RelayerSubmitRequest {
  tokenAddress: string;
  tokenAmount: bigint;
  address: string;
  authorization: any[];
  intentAuthorization: {
    signature: string;
    chainBatches: Array<{ hash: string; chainId: bigint; calls: any[]; recentBlock: bigint; }>;
  };
}

/** Response from the relayer on successful submission. */
export interface RelayerSubmitResponse { hash: string; intentId: string; }

/**
 * Submit an intent to the relayer.
 * The relayer broadcasts the transaction(s) and returns a cross‑chain intent id.
 */
export async function submitTransaction(baseUrl: string, request: RelayerSubmitRequest): Promise<RelayerSubmitResponse> {
  const res = await fetch(`${baseUrl}/transaction/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request, (k, v) => typeof v === 'bigint' ? v.toString() : v)
  });
  if (!res.ok) throw new Error(`Relayer API error: ${res.status} - ${await res.text()}`);
  const result = await res.json();
  return { hash: result.hash, intentId: result.intentId || request.intentAuthorization.signature };
}
