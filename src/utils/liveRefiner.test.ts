import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_SAMPLE_RATE,
  LIVE_WINDOW_SAMPLES,
  appendAndExtractLiveWindows,
  mergeWindowRefinedSegments,
  sliceLiveWindowIntoHalves,
} from "./liveRefiner";
import type { TranscriptSegment } from "../types/transcribe";

function makeSineSamples(seconds: number, amp = 0.2): Float32Array {
  const n = Math.round(seconds * LIVE_SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin((2 * Math.PI * 220 * i) / LIVE_SAMPLE_RATE) * amp;
  }
  return out;
}

test("appendAndExtractLiveWindows holds up to 10s then emits window and drops consumed buffer", () => {
  let chunks: Float32Array[] = [];
  let count = 0;

  // Feed 6 seconds -> no complete 10s window yet
  const step1 = appendAndExtractLiveWindows(
    chunks,
    count,
    makeSineSamples(6)
  );
  assert.equal(step1.completedWindows.length, 0);
  assert.equal(step1.remainingCount, 6 * LIVE_SAMPLE_RATE);
  chunks = step1.remainingChunks;
  count = step1.remainingCount;

  // Feed 5.5 more seconds -> emits exactly one 10s window and keeps 1.5s leftover
  const step2 = appendAndExtractLiveWindows(
    chunks,
    count,
    makeSineSamples(5.5)
  );
  assert.equal(step2.completedWindows.length, 1);
  assert.equal(step2.completedWindows[0].length, LIVE_WINDOW_SAMPLES);
  assert.equal(step2.remainingCount, Math.round(1.5 * LIVE_SAMPLE_RATE));
});

test("sliceLiveWindowIntoHalves splits 10s window into first 5s and later 5s slices with signal", () => {
  const win = makeSineSamples(10, 0.15);
  const sliced = sliceLiveWindowIntoHalves({
    windowSamples: win,
    prevTailSamples: makeSineSamples(0.5, 0.1),
    windowIndex: 0,
    windowStartMs: 0,
  });

  assert.equal(sliced.windowIndex, 0);
  assert.equal(sliced.windowStartMs, 0);
  assert.equal(sliced.windowEndMs, 10000);
  assert.equal(sliced.hasAudioSignal, true);
  assert.equal(sliced.halves.length, 2);

  const [first5s, later5s] = sliced.halves;
  assert.equal(first5s.halfIndex, 0);
  assert.equal(first5s.startMs, 0);
  assert.ok(first5s.endMs >= 4500 && first5s.endMs <= 5500);
  assert.ok(first5s.pcmPacketsBase64.length > 30);
  assert.ok(first5s.rawPacketsBase64.length > 30);

  assert.equal(later5s.halfIndex, 1);
  assert.equal(later5s.startMs, first5s.endMs);
  assert.equal(later5s.endMs, 10000);
  assert.ok(later5s.pcmPacketsBase64.length > 30);
  assert.ok(later5s.rawPacketsBase64.length > 30);
  assert.equal(sliced.tailSamples.length, 8000);
  assert.ok(sliced.hqWavBase64.length > 1000);
  assert.ok(sliced.rawWavBase64.length > 1000);
  assert.equal(
    Buffer.from(sliced.hqWavBase64, "base64").subarray(0, 4).toString("ascii"),
    "RIFF"
  );
  assert.equal(
    Buffer.from(sliced.rawWavBase64, "base64").subarray(0, 4).toString("ascii"),
    "RIFF"
  );
});

test("sliceLiveWindowIntoHalves detects pure silence accurately", () => {
  const silentWin = new Float32Array(LIVE_WINDOW_SAMPLES);
  const sliced = sliceLiveWindowIntoHalves({
    windowSamples: silentWin,
    prevTailSamples: null,
    windowIndex: 1,
    windowStartMs: 10000,
  });
  assert.equal(sliced.hasAudioSignal, false);
  assert.equal(sliced.halves[0].hasAudioSignal, false);
  assert.equal(sliced.halves[0].pcmPacketsBase64.length, 0);
  assert.equal(sliced.hqWavBase64, "");
  assert.equal(sliced.rawWavBase64, "");
});

test("mergeWindowRefinedSegments replaces unedited provisional drafts while keeping edited & other windows", () => {
  const existing: TranscriptSegment[] = [
    {
      id: "draft_0",
      text: "lossy draft",
      speakerId: "spk_1",
      timestampMs: 1200,
      liveWindowIndex: 0,
      isProvisional: true,
    },
    {
      id: "edited_0",
      text: "user edited line",
      speakerId: "spk_1",
      timestampMs: 6100,
      liveWindowIndex: 0,
      isProvisional: true,
      isEdited: true,
    },
    {
      id: "draft_1",
      text: "next window live draft",
      speakerId: "spk_1",
      timestampMs: 12000,
      liveWindowIndex: 1,
      isProvisional: true,
    },
  ];

  const refined: TranscriptSegment[] = [
    {
      id: "ref_0_0",
      text: "Refined first 5s.",
      speakerId: "spk_1",
      timestampMs: 0,
      endTimestampMs: 5000,
      liveWindowIndex: 0,
      liveHalfIndex: 0,
      isRefined: true,
    },
    {
      id: "ref_0_1",
      text: "Refined later 5s.",
      speakerId: "spk_1",
      timestampMs: 5000,
      endTimestampMs: 10000,
      liveWindowIndex: 0,
      liveHalfIndex: 1,
      isRefined: true,
    },
  ];

  const merged = mergeWindowRefinedSegments(existing, {
    windowIndex: 0,
    windowStartMs: 0,
    windowEndMs: 10000,
    refinedSegments: refined,
  });

  assert.deepEqual(
    merged.map((s) => s.id),
    ["ref_0_0", "ref_0_1", "edited_0", "draft_1"]
  );
  assert.equal(merged[0].isRefined, true);
});

test("sliceLiveWindowIntoHalves handles partial Stop flush < 2s (single half) and >= 2s (dual halves)", () => {
  const shortTail = makeSineSamples(1.2, 0.12);
  const slicedShort = sliceLiveWindowIntoHalves({
    windowSamples: shortTail,
    prevTailSamples: makeSineSamples(0.5, 0.1),
    windowIndex: 2,
    windowStartMs: 20000,
  });
  assert.equal(slicedShort.windowIndex, 2);
  assert.equal(slicedShort.windowStartMs, 20000);
  assert.equal(slicedShort.windowEndMs, 21200);
  assert.equal(slicedShort.hasAudioSignal, true);
  assert.equal(slicedShort.halves.length, 1);
  assert.equal(slicedShort.halves[0].halfIndex, 4);
  assert.ok(slicedShort.halves[0].pcmPacketsBase64.length > 5);

  const midTail = makeSineSamples(4.6, 0.12);
  const slicedMid = sliceLiveWindowIntoHalves({
    windowSamples: midTail,
    prevTailSamples: null,
    windowIndex: 3,
    windowStartMs: 30000,
  });
  assert.equal(slicedMid.windowEndMs, 34600);
  assert.equal(slicedMid.halves.length, 2);
  assert.equal(slicedMid.halves[0].halfIndex, 6);
  assert.equal(slicedMid.halves[1].halfIndex, 7);
});

test("mergeWindowRefinedSegments inserts backward-refined segments cleanly when live worker dropped with 0 drafts", () => {
  const existing: TranscriptSegment[] = [
    {
      id: "ref_w0",
      text: "First ten seconds refined.",
      speakerId: "spk_1",
      languageCode: "am-ET",
      timestampMs: 0,
      endTimestampMs: 10000,
      liveWindowIndex: 0,
      liveHalfIndex: 0,
      isRefined: true,
    },
  ];

  // Live worker dropped during window 1, so zero drafts exist for window 1
  const refinedW1: TranscriptSegment[] = [
    {
      id: "ref_w1_h2",
      text: "ሰላም እንደምን አለህ",
      speakerId: "spk_1",
      languageCode: "am-ET",
      timestampMs: 10000,
      endTimestampMs: 15000,
      liveWindowIndex: 1,
      liveHalfIndex: 2,
      isRefined: true,
    },
    {
      id: "ref_w1_h3",
      text: "ዛሬ ሁሉ ነገር ጥሩ ነው",
      speakerId: "spk_1",
      languageCode: "am-ET",
      timestampMs: 15000,
      endTimestampMs: 20000,
      liveWindowIndex: 1,
      liveHalfIndex: 3,
      isRefined: true,
    },
  ];

  const merged = mergeWindowRefinedSegments(existing, {
    windowIndex: 1,
    windowStartMs: 10000,
    windowEndMs: 20000,
    refinedSegments: refinedW1,
  });

  assert.deepEqual(
    merged.map((s) => s.id),
    ["ref_w0", "ref_w1_h2", "ref_w1_h3"]
  );
  assert.equal(merged[1].languageCode, "am-ET");
});

