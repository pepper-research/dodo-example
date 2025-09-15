/**
 * Intent step status response payload.
 */
export interface IntentStepStatusResponse {
  success: boolean;
  data: {
    status: 'created' | 'executing' | 'success' | 'reverted';
    transactionHash?: string;
  }
}

/**
 * Fetch the status of a specific intent step.
 * GET {txApiUrl}/intent/{intentId}/step/{stepId}/status
 */
export async function getIntentStepStatus(
  txApiUrl: string,
  intentId: string,
  stepId: number
): Promise<IntentStepStatusResponse> {
  const res = await fetch(`${txApiUrl}/intent/${intentId}/step/${stepId}/status`);
  if (!res.ok) throw new Error(`HTTP error ${res.status}`);
  return res.json();
}


