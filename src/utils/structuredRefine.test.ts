import test from "node:test";
import assert from "node:assert/strict";
import type { TranscriptSegment } from "../types/transcribe";
import {
  applyLmRefinedChunksToSegments,
  applyLmRefinedWindowsToSegments,
  buildPriorContextSnippet,
  collectDueRefinementWindows,
  upsertBackwardWorkerObservations,
  upsertLiveWorkerObservation,
  type StructuredWorkerWindow,
} from "./structuredRefine";

test("upsertLiveWorkerObservation and upsertBackwardWorkerObservations preserve all 5 worker outputs independently", () => {
  const map = new Map<number, StructuredWorkerWindow>();

  upsertLiveWorkerObservation(map, 0, 0, 10_000, "yeah i was gonna");
  upsertLiveWorkerObservation(map, 0, 0, 10_000, "tell you about it");

  upsertBackwardWorkerObservations(map, 0, 0, 10_000, {
    firstHalfPrimary: "Yeah I was gonna tell",
    firstHalfContrast: "yeah i was going to tell",
    secondHalfPrimary: "you about it yesterday",
    secondHalfContrast: "you about it yesterday morning",
  });

  const entry = map.get(0);
  assert.ok(entry);
  assert.equal(entry.backwardDone, true);
  assert.equal(entry.lmRefined, false);
  assert.equal(entry.workers.worker1LiveRealtime, "yeah i was gonna tell you about it");
  assert.equal(entry.workers.worker2FirstHalfPrimary, "Yeah I was gonna tell");
  assert.equal(entry.workers.worker3FirstHalfContrast, "yeah i was going to tell");
  assert.equal(entry.workers.worker4SecondHalfPrimary, "you about it yesterday");
  assert.equal(
    entry.workers.worker5SecondHalfContrast,
    "you about it yesterday morning"
  );
});

test("collectDueRefinementWindows skips incomplete or silence-only windows and preserves chronological order", () => {
  const map = new Map<number, StructuredWorkerWindow>();

  // Window 2 complete
  upsertBackwardWorkerObservations(map, 2, 20_000, 30_000, {
    firstHalfPrimary: "third window text",
  });
  // Window 0 complete & already LM refined
  upsertBackwardWorkerObservations(map, 0, 0, 10_000, {
    firstHalfPrimary: "already refined",
  });
  map.get(0)!.lmRefined = true;

  // Window 1 has live worker only, backward not done yet
  upsertLiveWorkerObservation(map, 1, 10_000, 20_000, "still waiting");

  // Window 3 backward done, pure silence (all empty)
  upsertBackwardWorkerObservations(map, 3, 30_000, 40_000, {});

  // Window 1 finishes
  upsertBackwardWorkerObservations(map, 1, 10_000, 20_000, {
    secondHalfPrimary: "second window text",
  });

  const due = collectDueRefinementWindows(map);
  assert.deepEqual(
    due.map((w) => w.windowIndex),
    [1, 2]
  );
});

test("buildPriorContextSnippet only uses segments strictly before the batch window", () => {
  const segs: TranscriptSegment[] = [
    {
      id: "s0",
      text: "First minute intro.",
      speakerId: "spk_1",
      timestampMs: 0,
      liveWindowIndex: 0,
    },
    {
      id: "s1",
      text: "Next thing we discussed.",
      speakerId: "spk_1",
      timestampMs: 10_000,
      liveWindowIndex: 1,
    },
    {
      id: "s2",
      text: "Current batch window text.",
      speakerId: "spk_1",
      timestampMs: 20_000,
      liveWindowIndex: 2,
    },
  ];

  const ctx = buildPriorContextSnippet(segs, 2, 200);
  assert.equal(ctx, "First minute intro. Next thing we discussed.");
});

test("applyLmRefinedWindowsToSegments updates refined windows cleanly while respecting manual user edits", () => {
  const map = new Map<number, StructuredWorkerWindow>();
  upsertBackwardWorkerObservations(map, 0, 0, 10_000, {
    firstHalfPrimary: "rough draft zero",
  });
  upsertBackwardWorkerObservations(map, 1, 10_000, 20_000, {
    firstHalfPrimary: "rough draft one",
  });

  const existing: TranscriptSegment[] = [
    {
      id: "prov_0",
      text: "rough draft zero",
      speakerId: "spk_1",
      timestampMs: 500,
      liveWindowIndex: 0,
      isProvisional: true,
    },
    {
      id: "edited_1",
      text: "User manually fixed this line.",
      speakerId: "spk_1",
      timestampMs: 11_000,
      liveWindowIndex: 1,
      isEdited: true,
    },
  ];

  const merged = applyLmRefinedWindowsToSegments(
    existing,
    map,
    [
      { windowIndex: 0, refinedText: "Yeah, I was gonna tell you about it yesterday morning.", detectedLanguage: "en-US" },
      { windowIndex: 1, refinedText: "Model output should not overwrite edit", detectedLanguage: "en-US" },
    ],
    "en-US"
  );

  assert.ok(merged.some((s) => s.liveWindowIndex === 0 && s.isRefined && !s.isProvisional));
  assert.ok(!merged.some((s) => s.id === "prov_0"));
  assert.equal(
    merged.find((s) => s.id === "edited_1")?.text,
    "User manually fixed this line."
  );
});

test("applyLmRefinedChunksToSegments updates uploaded chunks by chunkIndex while preserving user edits", () => {
  const chunkMap = new Map<number, StructuredWorkerWindow>();
  upsertBackwardWorkerObservations(chunkMap, 0, 0, 15_000, {
    firstHalfPrimary: "rough chunk zero",
    firstHalfContrast: "rough chunk oh",
    secondHalfPrimary: "rough chunk zero",
  });
  upsertBackwardWorkerObservations(chunkMap, 1, 15_000, 30_000, {
    firstHalfPrimary: "rough chunk one",
  });

  const existing: TranscriptSegment[] = [
    {
      id: "chunk_0_seg",
      text: "rough chunk zero",
      speakerId: "spk_1",
      timestampMs: 0,
      endTimestampMs: 15_000,
      chunkIndex: 0,
    },
    {
      id: "chunk_1_edited",
      text: "User edited chunk one.",
      speakerId: "spk_1",
      timestampMs: 15_000,
      endTimestampMs: 30_000,
      chunkIndex: 1,
      isEdited: true,
    },
  ];

  assert.equal(
    buildPriorContextSnippet(existing, 1, 200, "chunkIndex"),
    "rough chunk zero"
  );

  const merged = applyLmRefinedChunksToSegments(
    existing,
    chunkMap,
    [
      {
        windowIndex: 0,
        refinedText: "Refined chunk zero text.",
        detectedLanguage: "en-US",
      },
      {
        windowIndex: 1,
        refinedText: "Should not overwrite user edited chunk",
        detectedLanguage: "en-US",
      },
    ],
    "en-US"
  );

  const updatedChunk0 = merged.find((s) => s.chunkIndex === 0);
  assert.ok(updatedChunk0);
  assert.equal(updatedChunk0.text, "Refined chunk zero text.");
  assert.equal(updatedChunk0.isRefined, true);
  assert.equal(
    merged.find((s) => s.id === "chunk_1_edited")?.text,
    "User edited chunk one."
  );
});

test("upsertLiveHqWorkerObservation and upsertUploadWorkerObservations preserve all 8 live and 7 upload workers + WAV attachments independently", async () => {
  const { upsertLiveHqWorkerObservation, upsertUploadWorkerObservations } =
    await import("./structuredRefine");
  const liveMap = new Map<number, StructuredWorkerWindow>();
  upsertLiveWorkerObservation(liveMap, 0, 0, 10_000, "raw one");
  upsertLiveHqWorkerObservation(liveMap, 0, 0, 10_000, "hq conditioned one");
  upsertBackwardWorkerObservations(liveMap, 0, 0, 10_000, {
    firstHalfPrimary: "half1 hq",
    firstHalfContrast: "half1 raw",
    secondHalfPrimary: "half2 hq",
    secondHalfContrast: "half2 raw",
    staticHqWav: "static hq live",
    staticRawWav: "static raw live",
    audioAttachment: { hqWavBase64: "UklGRg==", rawWavBase64: "UklGRh==" },
  });
  const liveEntry = liveMap.get(0)!;
  assert.equal(liveEntry.workers.worker1LiveRealtime, "raw one");
  assert.equal(liveEntry.workers.worker6LiveHqRealtime, "hq conditioned one");
  assert.equal(liveEntry.workers.worker2FirstHalfPrimary, "half1 hq");
  assert.equal(liveEntry.workers.worker5SecondHalfContrast, "half2 raw");
  assert.equal(liveEntry.workers.worker7StaticHqWav, "static hq live");
  assert.equal(liveEntry.workers.worker8StaticRawWav, "static raw live");
  assert.equal(liveEntry.audioAttachment?.hqWavBase64, "UklGRg==");

  const upMap = new Map<number, StructuredWorkerWindow>();
  upsertUploadWorkerObservations(upMap, 0, 0, 15_000, {
    worker0RawPrimary: "raw primary",
    worker1RawContrast: "raw contrast",
    worker2HqVerbatim: "hq verbatim",
    worker3HqSmart: "hq smart",
    worker4HqClarified: "hq clarified",
    staticHqWav: "static hq upload",
    staticRawWav: "static raw upload",
    audioAttachment: { hqWavBase64: "UklGRq==", rawWavBase64: "UklGRr==" },
  });
  const upEntry = upMap.get(0)!;
  assert.equal(upEntry.workers.worker1LiveRealtime, "raw primary");
  assert.equal(upEntry.workers.worker2FirstHalfPrimary, "raw contrast");
  assert.equal(upEntry.workers.worker3FirstHalfContrast, "hq verbatim");
  assert.equal(upEntry.workers.worker4SecondHalfPrimary, "hq smart");
  assert.equal(upEntry.workers.worker5SecondHalfContrast, "hq clarified");
  assert.equal(upEntry.workers.worker7StaticHqWav, "static hq upload");
  assert.equal(upEntry.workers.worker8StaticRawWav, "static raw upload");
  const due = collectDueRefinementWindows(upMap);
  assert.equal(due.length, 1);
  assert.equal(due[0].audioAttachment?.rawWavBase64, "UklGRr==");
});
