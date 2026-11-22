import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_WAVES,
  WORKERS_PER_WAVE,
  getWaveCount,
  pickNextWaveSegment,
  shouldInterruptWaveOnSeek,
} from "./waveScheduler";

test("getWaveCount scales from 0 to 1 to 2 waves", () => {
  assert.equal(WORKERS_PER_WAVE, 3);
  assert.equal(MAX_WAVES, 2);
  assert.equal(getWaveCount(0), 0);
  assert.equal(getWaveCount(1), 1);
  assert.equal(getWaveCount(2), 2);
  assert.equal(getWaveCount(10), 2);
});

test("two waves start simultaneously on segment 0 and segment 1 at pre-buffering", () => {
  const completed = new Set<number>();
  const active = new Set<number>();

  const wave1 = pickNextWaveSegment({
    totalChunks: 6,
    completed,
    active,
    isPreBuffering: true,
    isPlaying: false,
    isAudioEnded: false,
    playheadChunkIdx: 0,
  });
  assert.equal(wave1, 0);
  active.add(wave1!);

  const wave2 = pickNextWaveSegment({
    totalChunks: 6,
    completed,
    active,
    isPreBuffering: true,
    isPlaying: false,
    isAudioEnded: false,
    playheadChunkIdx: 0,
  });
  assert.equal(wave2, 1);
  active.add(wave2!);

  // No 3rd wave steals a segment while both waves are active
  assert.equal(active.size, 2);
});

test("when either segment 0 or segment 1 finishes, free workers proceed to segment 2", () => {
  // Case A: Wave 2 finishes segment 1 while Wave 1 is still on segment 0
  const completedA = new Set<number>([1]);
  const activeA = new Set<number>([0]);
  assert.equal(
    pickNextWaveSegment({
      totalChunks: 5,
      completed: completedA,
      active: activeA,
      isPreBuffering: true,
      isPlaying: false,
      isAudioEnded: false,
      playheadChunkIdx: 0,
    }),
    2
  );

  // Case B: Wave 1 finishes segment 0 while Wave 2 is still on segment 1, playback starts
  const completedB = new Set<number>([0]);
  const activeB = new Set<number>([1]);
  assert.equal(
    pickNextWaveSegment({
      totalChunks: 5,
      completed: completedB,
      active: activeB,
      isPreBuffering: false,
      isPlaying: true,
      isAudioEnded: false,
      playheadChunkIdx: 0,
    }),
    2
  );
});

test("during playback after seek, waves prioritize playhead and next segment then backfill", () => {
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
  active.add(first!);

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
  active.add(second!);

  // Now 4 and 5 are active, 0 and 1 are completed -> backfills 2
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

test("shouldInterruptWaveOnSeek keeps waves on seekedChunk and seekedChunk + 1", () => {
  const completed = new Set<number>([0]);
  assert.equal(shouldInterruptWaveOnSeek(4, 4, completed), false);
  assert.equal(shouldInterruptWaveOnSeek(5, 4, completed), false);
  assert.equal(shouldInterruptWaveOnSeek(2, 4, completed), true);
  assert.equal(shouldInterruptWaveOnSeek(2, 0, completed), false);
});
