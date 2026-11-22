import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_WAVES,
  WORKERS_PER_WAVE,
  getWaveCount,
  pickNextWaveSegment,
  shouldInterruptWaveOnSeek,
} from "./waveScheduler";

test("getWaveCount focuses strictly on 1 current segment wave with 5 parallel workers", () => {
  assert.equal(WORKERS_PER_WAVE, 5);
  assert.equal(MAX_WAVES, 1);
  assert.equal(getWaveCount(0), 0);
  assert.equal(getWaveCount(1), 1);
  assert.equal(getWaveCount(2), 1);
  assert.equal(getWaveCount(10), 1);
});

test("single wave focuses on segment 0 during pre-buffering without splitting across segments", () => {
  const completed = new Set<number>();
  const active = new Set<number>();

  const current = pickNextWaveSegment({
    totalChunks: 6,
    completed,
    active,
    isPreBuffering: true,
    isPlaying: false,
    isAudioEnded: false,
    playheadChunkIdx: 0,
  });
  assert.equal(current, 0);
  active.add(current!);

  // Completed chunk 0 advances strictly sequentially to segment 1
  active.clear();
  completed.add(0);
  const next = pickNextWaveSegment({
    totalChunks: 6,
    completed,
    active,
    isPreBuffering: true,
    isPlaying: false,
    isAudioEnded: false,
    playheadChunkIdx: 0,
  });
  assert.equal(next, 1);
});

test("during playback after seek, single wave focuses on exact playhead segment then backfills", () => {
  const completed = new Set<number>([0, 1]);
  const active = new Set<number>();

  const first = pickNextWaveSegment({
    totalChunks: 6,
    completed,
    active,
    isPreBuffering: false,
    isPlaying: true,
    isAudioEnded: false,
    playheadChunkIdx: 4,
  });
  assert.equal(first, 4);
  completed.add(4);

  const second = pickNextWaveSegment({
    totalChunks: 6,
    completed,
    active,
    isPreBuffering: false,
    isPlaying: true,
    isAudioEnded: false,
    playheadChunkIdx: 4,
  });
  assert.equal(second, 5);
  completed.add(5);

  // Now 4 and 5 are completed -> backfills 2
  const third = pickNextWaveSegment({
    totalChunks: 6,
    completed,
    active,
    isPreBuffering: false,
    isPlaying: true,
    isAudioEnded: false,
    playheadChunkIdx: 4,
  });
  assert.equal(third, 2);
});

test("paused state returns null and audio-ended finishes remaining segments", () => {
  const completed = new Set<number>([0, 1]);
  const active = new Set<number>();

  assert.equal(
    pickNextWaveSegment({
      totalChunks: 4,
      completed,
      active,
      isPreBuffering: false,
      isPlaying: false,
      isAudioEnded: false,
      playheadChunkIdx: 1,
    }),
    null
  );

  assert.equal(
    pickNextWaveSegment({
      totalChunks: 4,
      completed,
      active,
      isPreBuffering: false,
      isPlaying: false,
      isAudioEnded: true,
      playheadChunkIdx: 3,
    }),
    2
  );
});

test("shouldInterruptWaveOnSeek immediately interrupts whenever wave is not on seekedChunk", () => {
  const completed = new Set<number>([0]);
  assert.equal(shouldInterruptWaveOnSeek(4, 4, completed), false);
  assert.equal(shouldInterruptWaveOnSeek(5, 4, completed), true);
  assert.equal(shouldInterruptWaveOnSeek(2, 4, completed), true);
  assert.equal(shouldInterruptWaveOnSeek(2, 0, completed), false);
});
