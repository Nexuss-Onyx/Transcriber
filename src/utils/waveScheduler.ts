export const WORKERS_PER_WAVE = 5;
export const MAX_WAVES = 1;

export interface WaveScheduleParams {
  totalChunks: number;
  completed: ReadonlySet<number>;
  active: ReadonlySet<number>;
  isPreBuffering: boolean;
  isPlaying: boolean;
  isAudioEnded: boolean;
  playheadChunkIdx: number;
}

export function getWaveCount(totalChunks: number): number {
  if (totalChunks <= 0) return 0;
  return MAX_WAVES;
}

/**
 * Picks the single current 15-second segment index to focus all workers on.
 * Never picks a segment already completed or currently active.
 */
export function pickNextWaveSegment(
  params: WaveScheduleParams
): number | null {
  const {
    totalChunks,
    completed,
    active,
    isPreBuffering,
    isPlaying,
    isAudioEnded,
    playheadChunkIdx,
  } = params;

  if (totalChunks <= 0) return null;

  const isAvailable = (idx: number) =>
    idx >= 0 &&
    idx < totalChunks &&
    !completed.has(idx) &&
    !active.has(idx);

  if (isPreBuffering) {
    for (let i = 0; i < totalChunks; i++) {
      if (isAvailable(i)) return i;
    }
    return null;
  }

  if (isPlaying) {
    const start = Math.max(0, Math.min(totalChunks - 1, playheadChunkIdx));
    for (let i = start; i < totalChunks; i++) {
      if (isAvailable(i)) return i;
    }
    for (let i = 0; i < start; i++) {
      if (isAvailable(i)) return i;
    }
    return null;
  }

  if (isAudioEnded) {
    for (let i = 0; i < totalChunks; i++) {
      if (isAvailable(i)) return i;
    }
  }

  return null;
}

export function shouldInterruptWaveOnSeek(
  targetIdx: number,
  seekedChunkIdx: number,
  completed: ReadonlySet<number>
): boolean {
  if (completed.has(seekedChunkIdx)) {
    return false;
  }
  return targetIdx !== seekedChunkIdx;
}
