/**
 * RFQT request shape used by SpiceFlow to prepare a user-executed trade.
 */
export interface RFQTRequest {
  user: `0x${string}`;
  /** Input asset identifier (symbol, address, or provider-defined key). */
  tokenIn: string;
  /** Output asset identifier (symbol, address, or provider-defined key). */
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  expiry: number;
  quoteId: `0x${string}`;
}

/** RFQT response payload used to build a call {to, value, data}. */
export interface RFQTResponse {
  to: `0x${string}`;
  value: string; // decimal string amount of wei
  data: `0x${string}`;
}

/**
 * Prepare an RFQT transaction request.
 * POST {txApiUrl}/rfqt
 */
export async function prepareRFQT(
  txApiUrl: string,
  request: RFQTRequest
): Promise<RFQTResponse> {
  const res = await fetch(`${txApiUrl}/rfqt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  });
  if (!res.ok) throw new Error(`RFQT error ${res.status}`);
  return res.json();
}


