import { API_CONFIG } from '../config/api';

type StepStatus = 'created' | 'executing' | 'success' | 'reverted';

export type IntentStepStatusResponse = {
    success: boolean;
    data: {
        status: StepStatus;
        transactionHash?: string;
    }
};

export type PollOptions = {
    stepId?: number;
    intervalMs?: number;
    timeoutMs?: number;
    onUpdate?: (s: IntentStepStatusResponse) => void;
};

export function pollIntentStep(intentId: string, opts: PollOptions = {}) {
    const stepId = opts.stepId ?? 0;
    const intervalMs = opts.intervalMs ?? 4000;
    const timeoutMs = opts.timeoutMs;

    let timer: any;
    let timeoutTimer: any;
    let stopped = false;
    let attempts = 0;
    let prevStatus: StepStatus | undefined;
    let prevTxHash: string | undefined;
    const startedAt = Date.now();

    console.log(`[poll] start intent=${intentId} step=${stepId} intervalMs=${intervalMs} timeoutMs=${timeoutMs ?? 'none'} base=${API_CONFIG.TX_API_URL}`);

    const getStatus = async (): Promise<IntentStepStatusResponse> => {
        const url = `${API_CONFIG.TX_API_URL}/intent/${intentId}/step/${stepId}/status`;
        console.log(`[poll] GET ${url}`);
        const r = await fetch(url);
        const raw = await r.text();
        if (!r.ok) throw new Error(`status ${r.status} ${raw}`);
        console.log(`[poll] raw response: ${raw}`);
        return JSON.parse(raw);
    };

    const stop = () => {
        stopped = true;
        if (timer) clearInterval(timer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const elapsed = Date.now() - startedAt;
        console.log(`[poll] stopped after ${attempts} attempt(s), elapsed ${elapsed}ms`);
    };

    const start = async (): Promise<IntentStepStatusResponse> => {
        try {
            const first = await getStatus();
            attempts += 1;
            prevStatus = first.data.status;
            prevTxHash = first.data.transactionHash;
            console.log(`[poll] initial status=${first.data.status}${first.data.transactionHash ? ` tx=${first.data.transactionHash}` : ''}`);
            opts.onUpdate?.(first);
            if (first.data.status === 'success' || first.data.status === 'reverted') {
                return first;
            }
        } catch (e) {
            console.warn(`[poll] initial check error: ${(e as any)?.message || e}`);
        }

        return await new Promise<IntentStepStatusResponse>((resolve, reject) => {
            if (timeoutMs) {
                timeoutTimer = setTimeout(() => {
                    stop();
                    console.warn('[poll] timeout reached');
                    reject(new Error('Polling timeout'));
                }, timeoutMs);
            }

            timer = setInterval(async () => {
                if (stopped) return;
                try {
                    const s = await getStatus();
                    attempts += 1;
                    const elapsed = Date.now() - startedAt;
                    if (s.data.status !== prevStatus) {
                        console.log(`[poll] status change ${prevStatus ?? 'n/a'} -> ${s.data.status} (attempt ${attempts}, ${elapsed}ms)`);
                        prevStatus = s.data.status;
                    } else {
                        console.log(`[poll] status unchanged (${s.data.status}) (attempt ${attempts}, ${elapsed}ms)`);
                    }

                    if (s.data.transactionHash && s.data.transactionHash !== prevTxHash) {
                        prevTxHash = s.data.transactionHash;
                        console.log(`[poll] tx available: ${s.data.transactionHash}`);
                    }

                    opts.onUpdate?.(s);
                    if (s.data.status === 'success' || s.data.status === 'reverted') {
                        stop();
                        resolve(s);
                    }
                } catch (err) {
                    console.warn(`[poll] fetch error (attempt ${attempts + 1}): ${(err as any)?.message || err}`);
                }
            }, intervalMs);
        });
    };

    return { start, stop };
}


