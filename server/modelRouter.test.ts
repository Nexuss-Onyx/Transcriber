import test from "node:test";
import assert from "node:assert/strict";
import {
  FrontierModelRouter,
  LM_MODEL_CHAIN,
  classifyGeminiRouterError,
} from "./modelRouter";

test("FrontierModelRouter starts with gemini-4-hydrogen and prioritizes frontier down to lite", () => {
  const router = new FrontierModelRouter();
  const order = router.getCandidateOrder(1_000_000);

  assert.equal(order[0], "gemini-4-hydrogen");
  assert.equal(order[1], "gemini-3.8-flash");
  assert.equal(order[order.length - 1], "gemini-2.5-flash-lite");
  assert.equal(order.length, LM_MODEL_CHAIN.length);
});

test("FrontierModelRouter spares lower models when frontier succeeds", async () => {
  const router = new FrontierModelRouter();
  const called: string[] = [];

  for (let i = 0; i < 4; i++) {
    const res = await router.executeWithFailover(
      async (modelId) => {
        called.push(modelId);
        return `ok:${modelId}`;
      },
      () => 2_000_000 + i * 100
    );
    assert.equal(res.modelUsed, "gemini-4-hydrogen");
  }

  assert.deepEqual(called, [
    "gemini-4-hydrogen",
    "gemini-4-hydrogen",
    "gemini-4-hydrogen",
    "gemini-4-hydrogen",
  ]);
});

test("FrontierModelRouter automatically cascades down when upper models hit 429 or transient errors", async () => {
  const router = new FrontierModelRouter();
  const tried: string[] = [];
  let now = 5_000_000;

  const { modelUsed, result } = await router.executeWithFailover(
    async (modelId) => {
      tried.push(modelId);
      if (modelId === "gemini-4-hydrogen") {
        throw new Error('429 RESOURCE_EXHAUSTED {"code":429}');
      }
      if (modelId === "gemini-3.8-flash") {
        throw new Error("503 Service Unavailable");
      }
      return `refined:${modelId}`;
    },
    () => now
  );

  assert.deepEqual(tried, [
    "gemini-4-hydrogen",
    "gemini-3.8-flash",
    "gemini-3.6-flash",
  ]);
  assert.equal(modelUsed, "gemini-3.6-flash");
  assert.equal(result, "refined:gemini-3.6-flash");

  // Immediately afterward (within cooldown), frontier & 3.8-flash stay skipped
  const nextOrder = router.getCandidateOrder(now + 1000);
  assert.equal(nextOrder[0], "gemini-3.6-flash");

  // Once 66s pass, frontier becomes primary again so lite models aren't overused
  now += 66_000;
  const recoveredOrder = router.getCandidateOrder(now);
  assert.equal(recoveredOrder[0], "gemini-4-hydrogen");
});

test("FrontierModelRouter respects RPM ceiling preemptively before reaching Lite tier", async () => {
  const router = new FrontierModelRouter();
  const now = 9_000_000;

  // Exhaust 5 RPM on gemini-4-hydrogen
  for (let i = 0; i < 5; i++) {
    router.recordAttempt("gemini-4-hydrogen", now + i);
  }

  const order = router.getCandidateOrder(now + 100);
  assert.equal(order[0], "gemini-3.8-flash");
  assert.ok(!order.slice(0, 4).includes("gemini-4-hydrogen"));
});

test("FrontierModelRouter fails fast on auth errors without burning through all models", async () => {
  const router = new FrontierModelRouter();
  const tried: string[] = [];

  await assert.rejects(
    () =>
      router.executeWithFailover(async (modelId) => {
        tried.push(modelId);
        throw new Error("API_KEY_INVALID");
      }),
    /API_KEY_INVALID/
  );

  assert.deepEqual(tried, ["gemini-4-hydrogen"]);
  assert.equal(classifyGeminiRouterError(new Error("NOT_FOUND 404")), "not_found");
  assert.equal(
    classifyGeminiRouterError(new Error("RESOURCE_EXHAUSTED")),
    "rate_limit"
  );
});
