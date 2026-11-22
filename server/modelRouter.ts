export interface ModelQuotaSpec {
  id: string;
  tier: "frontier" | "flash" | "lite";
  rpmLimit: number;
  tpmLimit: number;
  rpdLimit: number;
}

/**
 * Priority order derived from the project's Gemini rate-limit table:
 * Start with the strongest frontier model (gemini-4-hydrogen), cascade down
 * through higher Flash tiers, and fall back to high-headroom Lite models only
 * when upper tiers fail or exhaust their quotas.
 */
export const LM_MODEL_CHAIN: readonly ModelQuotaSpec[] = [
  { id: "gemini-4-hydrogen", tier: "frontier", rpmLimit: 5, tpmLimit: 250_000, rpdLimit: 20 },
  { id: "gemini-3.8-flash", tier: "flash", rpmLimit: 5, tpmLimit: 250_000, rpdLimit: 20 },
  { id: "gemini-3.6-flash", tier: "flash", rpmLimit: 5, tpmLimit: 250_000, rpdLimit: 20 },
  { id: "gemini-3-flash-preview", tier: "flash", rpmLimit: 5, tpmLimit: 250_000, rpdLimit: 20 },
  { id: "gemini-2.5-flash", tier: "flash", rpmLimit: 5, tpmLimit: 250_000, rpdLimit: 20 },
  { id: "gemini-3.5-flash-lite", tier: "lite", rpmLimit: 15, tpmLimit: 250_000, rpdLimit: 500 },
  { id: "gemini-3.1-flash-lite", tier: "lite", rpmLimit: 15, tpmLimit: 250_000, rpdLimit: 500 },
  { id: "gemini-2.5-flash-lite", tier: "lite", rpmLimit: 10, tpmLimit: 250_000, rpdLimit: 20 },
];

export type RouterFailureKind = "rate_limit" | "not_found" | "transient" | "auth";

interface ModelUsageState {
  recentRequests: number[];
  dailyCount: number;
  dailyDateKey: string;
  cooldownUntil: number;
}

function getUtcDateKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function classifyGeminiRouterError(err: unknown): RouterFailureKind {
  const raw = (err instanceof Error ? err.message : String(err)).toLowerCase();

  if (
    raw.includes("api_key_invalid") ||
    raw.includes("permission_denied") ||
    raw.includes("permission denied") ||
    raw.includes("api key not valid") ||
    raw.includes('"code":403')
  ) {
    return "auth";
  }

  if (
    raw.includes("resource_exhausted") ||
    raw.includes("rate limit") ||
    raw.includes("quota") ||
    raw.includes("too many requests") ||
    raw.includes('"code":429') ||
    raw.includes("429")
  ) {
    return "rate_limit";
  }

  if (
    raw.includes("not_found") ||
    raw.includes("not found") ||
    raw.includes("is not supported for") ||
    raw.includes('"code":404')
  ) {
    return "not_found";
  }

  return "transient";
}

export class FrontierModelRouter {
  private readonly chain: readonly ModelQuotaSpec[];
  private readonly usage = new Map<string, ModelUsageState>();

  constructor(chain: readonly ModelQuotaSpec[] = LM_MODEL_CHAIN) {
    this.chain = chain;
  }

  private getState(spec: ModelQuotaSpec, nowMs: number): ModelUsageState {
    const today = getUtcDateKey(nowMs);
    let state = this.usage.get(spec.id);
    if (!state) {
      state = {
        recentRequests: [],
        dailyCount: 0,
        dailyDateKey: today,
        cooldownUntil: 0,
      };
      this.usage.set(spec.id, state);
    }
    if (state.dailyDateKey !== today) {
      state.dailyDateKey = today;
      state.dailyCount = 0;
    }
    const cutoff = nowMs - 60_000;
    if (state.recentRequests.length > 0) {
      state.recentRequests = state.recentRequests.filter((ts) => ts > cutoff);
    }
    return state;
  }

  isAvailable(spec: ModelQuotaSpec, nowMs = Date.now()): boolean {
    const state = this.getState(spec, nowMs);
    if (nowMs < state.cooldownUntil) return false;
    if (state.recentRequests.length >= spec.rpmLimit) return false;
    if (state.dailyCount >= spec.rpdLimit) return false;
    return true;
  }

  /**
   * Returns ordered candidate model IDs for a single request.
   * Always prioritizes available frontier -> flash -> lite models first,
   * keeping lite models untouched while higher models have headroom.
   */
  getCandidateOrder(nowMs = Date.now(), excludeIds?: Set<string>): string[] {
    const preferred: string[] = [];
    const fallbackInCooldown: Array<{ id: string; cooldownUntil: number }> = [];

    for (const spec of this.chain) {
      if (excludeIds?.has(spec.id)) continue;
      const state = this.getState(spec, nowMs);
      if (this.isAvailable(spec, nowMs)) {
        preferred.push(spec.id);
      } else if (state.dailyCount < spec.rpdLimit) {
        fallbackInCooldown.push({ id: spec.id, cooldownUntil: state.cooldownUntil });
      }
    }

    if (preferred.length > 0) {
      return preferred;
    }

    // Only if every tier is simultaneously in short RPM cooldown, still expose
    // non-daily-exhausted candidates sorted by earliest cooldown expiry.
    fallbackInCooldown.sort((a, b) => a.cooldownUntil - b.cooldownUntil);
    return fallbackInCooldown.map((item) => item.id);
  }

  recordAttempt(modelId: string, nowMs = Date.now()): void {
    const spec = this.chain.find((m) => m.id === modelId);
    if (!spec) return;
    const state = this.getState(spec, nowMs);
    state.recentRequests.push(nowMs);
    state.dailyCount += 1;
  }

  recordFailure(
    modelId: string,
    kind: RouterFailureKind,
    nowMs = Date.now()
  ): void {
    const spec = this.chain.find((m) => m.id === modelId);
    if (!spec) return;
    const state = this.getState(spec, nowMs);
    if (kind === "rate_limit") {
      state.cooldownUntil = Math.max(state.cooldownUntil, nowMs + 65_000);
    } else if (kind === "not_found") {
      state.cooldownUntil = Math.max(state.cooldownUntil, nowMs + 10 * 60_000);
    } else if (kind === "transient") {
      state.cooldownUntil = Math.max(state.cooldownUntil, nowMs + 25_000);
    }
  }

  /**
   * Executes `invoke(modelId)` starting from the highest available frontier
   * model and failing over across every remaining option until one succeeds.
   */
  async executeWithFailover<T>(
    invoke: (modelId: string) => Promise<T>,
    nowProvider: () => number = () => Date.now()
  ): Promise<{ modelUsed: string; result: T }> {
    const attempted = new Set<string>();
    let lastError: unknown;

    while (attempted.size < this.chain.length) {
      const now = nowProvider();
      const candidates = this.getCandidateOrder(now, attempted);
      if (candidates.length === 0) break;

      const modelId = candidates[0];
      attempted.add(modelId);
      this.recordAttempt(modelId, now);

      try {
        const result = await invoke(modelId);
        return { modelUsed: modelId, result };
      } catch (err) {
        lastError = err;
        const kind = classifyGeminiRouterError(err);
        if (kind === "auth") {
          throw err;
        }
        this.recordFailure(modelId, kind, nowProvider());
      }
    }

    throw lastError ?? new Error("All language model routes failed or exhausted.");
  }
}
