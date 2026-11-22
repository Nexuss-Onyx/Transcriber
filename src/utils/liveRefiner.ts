import type { TranscriptSegment } from "../types/transcribe";
import {
  applySpeechHighPassFilter,
  encodeFloat32ToWavBase64,
  float32ToBase64Pcm16,
  normalizeSpeechDynamics,
} from "./audioCapture";

export const LIVE_SAMPLE_RATE = 16000;
export const LIVE_WINDOW_SECONDS = 10;
export const LIVE_WINDOW_SAMPLES = LIVE_SAMPLE_RATE * LIVE_WINDOW_SECONDS; // 160,000 samples (10s)
export const LIVE_PACKET_SAMPLES = 2048; // 128ms per 16kHz packet
export const LIVE_OVERLAP_SAMPLES = Math.floor(0.5 * LIVE_SAMPLE_RATE); // 0.5s lead-in overlap

export interface LiveHalfSlice {
  halfIndex: number;
  halfOffset: 0 | 1;
  startMs: number;
  endMs: number;
  hasAudioSignal: boolean;
  pcmPacketsBase64: string[];
  rawPacketsBase64: string[];
}

export interface SlicedLiveWindow {
  windowIndex: number;
  windowStartMs: number;
  windowEndMs: number;
  hasAudioSignal: boolean;
  halves: LiveHalfSlice[];
  tailSamples: Float32Array;
  hqWavBase64: string;
  rawWavBase64: string;
}

export function concatFloat32Arrays(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Appends incoming 16kHz PCM samples to a rolling buffer and immediately slices out
 * complete 10-second windows, dropping consumed samples while carrying overflow
 * seamlessly into the next 10s window.
 */
export function appendAndExtractLiveWindows(
  existingChunks: Float32Array[],
  existingCount: number,
  incoming: Float32Array,
  windowSizeSamples = LIVE_WINDOW_SAMPLES
): {
  completedWindows: Float32Array[];
  remainingChunks: Float32Array[];
  remainingCount: number;
} {
  if (incoming.length === 0) {
    return {
      completedWindows: [],
      remainingChunks: existingChunks,
      remainingCount: existingCount,
    };
  }

  const allChunks = [...existingChunks, incoming];
  const totalCount = existingCount + incoming.length;

  if (totalCount < windowSizeSamples) {
    return {
      completedWindows: [],
      remainingChunks: allChunks,
      remainingCount: totalCount,
    };
  }

  const combined = concatFloat32Arrays(allChunks);
  const completedWindows: Float32Array[] = [];
  let cursor = 0;

  while (cursor + windowSizeSamples <= combined.length) {
    completedWindows.push(combined.slice(cursor, cursor + windowSizeSamples));
    cursor += windowSizeSamples;
  }

  const leftover = combined.slice(cursor);
  return {
    completedWindows,
    remainingChunks: leftover.length > 0 ? [leftover] : [],
    remainingCount: leftover.length,
  };
}

function packetize16kMono(
  samples: Float32Array,
  hasSignal: boolean,
  samplesPerPacket = LIVE_PACKET_SAMPLES
): string[] {
  if (samples.length === 0) return [];
  const silentPad = float32ToBase64Pcm16(new Float32Array(samplesPerPacket));
  const pkts: string[] = [];
  if (hasSignal) {
    pkts.push(silentPad, silentPad, silentPad, silentPad);
  }
  for (let p = 0; p < samples.length; p += samplesPerPacket) {
    const end = Math.min(samples.length, p + samplesPerPacket);
    pkts.push(float32ToBase64Pcm16(samples.subarray(p, end)));
  }
  if (hasSignal && pkts.length > 4) {
    pkts.push(silentPad, silentPad, silentPad, silentPad, silentPad);
  }
  return pkts;
}

function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSq += samples[i] * samples[i];
  }
  return Math.sqrt(sumSq / samples.length);
}

function findQuietestMidpointSplit(
  samples: Float32Array,
  sampleRate = LIVE_SAMPLE_RATE
): number {
  const nominalMid = Math.floor(samples.length / 2);
  const snapRadius = Math.floor(0.4 * sampleRate);
  const winSamples = Math.max(1, Math.floor(0.025 * sampleRate));
  const minSamples = Math.floor(1.5 * sampleRate);

  const searchStart = Math.max(minSamples, nominalMid - snapRadius);
  const searchEnd = Math.min(
    samples.length - minSamples - winSamples,
    nominalMid + snapRadius
  );

  if (searchEnd <= searchStart) {
    return nominalMid;
  }

  let bestPos = nominalMid;
  let bestEnergy = Infinity;
  const step = Math.max(1, Math.floor(winSamples / 2));

  for (let pos = searchStart; pos <= searchEnd; pos += step) {
    let energy = 0;
    for (let k = 0; k < winSamples; k++) {
      const s = samples[pos + k];
      energy += s * s;
    }
    if (energy < bestEnergy) {
      bestEnergy = energy;
      bestPos = pos + Math.floor(winSamples / 2);
    }
  }
  return bestPos;
}

/**
 * Slices a 10s live recording window into two ~5s halves (first 5s + later 5s)
 * with high-pass filtering, dynamics normalization, quiet-gap split snapping,
 * and 0.5s acoustic lead-in overlap so the 4 backward workers (2+2) match
 * uploaded audio quality.
 */
export function sliceLiveWindowIntoHalves(params: {
  windowSamples: Float32Array;
  prevTailSamples: Float32Array | null;
  windowIndex: number;
  windowStartMs: number;
  sampleRate?: number;
  samplesPerPacket?: number;
}): SlicedLiveWindow {
  const {
    windowSamples,
    prevTailSamples,
    windowIndex,
    windowStartMs,
    sampleRate = LIVE_SAMPLE_RATE,
    samplesPerPacket = LIVE_PACKET_SAMPLES,
  } = params;

  const overlapSamples = Math.min(
    LIVE_OVERLAP_SAMPLES,
    prevTailSamples?.length ?? 0
  );
  const tailSlice =
    overlapSamples > 0 && prevTailSamples
      ? prevTailSamples.subarray(prevTailSamples.length - overlapSamples)
      : new Float32Array(0);

  const combinedRaw = new Float32Array(tailSlice.length + windowSamples.length);
  if (tailSlice.length > 0) {
    combinedRaw.set(tailSlice, 0);
  }
  combinedRaw.set(windowSamples, tailSlice.length);

  const combinedFiltered = applySpeechHighPassFilter(combinedRaw, sampleRate);
  const offset = tailSlice.length;
  const canonicalFiltered = combinedFiltered.subarray(offset);

  const windowRms = computeRms(canonicalFiltered);
  const windowHasSignal = windowRms > 0.0001;
  const durationMs = Math.round((windowSamples.length / sampleRate) * 1000);
  const windowEndMs = windowStartMs + durationMs;

  const nextTailLen = Math.min(LIVE_OVERLAP_SAMPLES, windowSamples.length);
  const tailSamples = windowSamples.slice(windowSamples.length - nextTailLen);

  // Split into 2 ~5s halves whenever >= 2.0s (always true for a 10s window)
  const canSplitIntoTwo = windowSamples.length >= sampleRate * 2;
  const halves: LiveHalfSlice[] = [];

  if (canSplitIntoTwo) {
    const splitSample = findQuietestMidpointSplit(canonicalFiltered, sampleRate);
    const midMs =
      windowStartMs + Math.round((splitSample / sampleRate) * 1000);

    // First 5s half: [0 .. splitSample] + prevTail overlap
    const h0Filtered = combinedFiltered.subarray(0, offset + splitSample);
    const h0Raw = combinedRaw.subarray(0, offset + splitSample);
    const h0HasSignal =
      windowHasSignal &&
      computeRms(canonicalFiltered.subarray(0, splitSample)) > 0.0001;

    halves.push({
      halfIndex: windowIndex * 2,
      halfOffset: 0,
      startMs: windowStartMs,
      endMs: midMs,
      hasAudioSignal: h0HasSignal,
      pcmPacketsBase64: h0HasSignal
        ? packetize16kMono(
            normalizeSpeechDynamics(h0Filtered),
            true,
            samplesPerPacket
          )
        : [],
      rawPacketsBase64: h0HasSignal
        ? packetize16kMono(h0Raw, true, samplesPerPacket)
        : [],
    });

    // Later 5s half: [splitSample .. end] + 0.5s acoustic lead-in before splitSample
    const h1LeadStart = Math.max(
      0,
      offset + splitSample - LIVE_OVERLAP_SAMPLES
    );
    const h1Filtered = combinedFiltered.subarray(h1LeadStart);
    const h1Raw = combinedRaw.subarray(h1LeadStart);
    const h1HasSignal =
      windowHasSignal &&
      computeRms(canonicalFiltered.subarray(splitSample)) > 0.0001;

    halves.push({
      halfIndex: windowIndex * 2 + 1,
      halfOffset: 1,
      startMs: midMs,
      endMs: windowEndMs,
      hasAudioSignal: h1HasSignal,
      pcmPacketsBase64: h1HasSignal
        ? packetize16kMono(
            normalizeSpeechDynamics(h1Filtered),
            true,
            samplesPerPacket
          )
        : [],
      rawPacketsBase64: h1HasSignal
        ? packetize16kMono(h1Raw, true, samplesPerPacket)
        : [],
    });
  } else {
    halves.push({
      halfIndex: windowIndex * 2,
      halfOffset: 0,
      startMs: windowStartMs,
      endMs: windowEndMs,
      hasAudioSignal: windowHasSignal,
      pcmPacketsBase64: windowHasSignal
        ? packetize16kMono(
            normalizeSpeechDynamics(combinedFiltered),
            true,
            samplesPerPacket
          )
        : [],
      rawPacketsBase64: windowHasSignal
        ? packetize16kMono(combinedRaw, true, samplesPerPacket)
        : [],
    });
  }

  const hqWavBase64 = windowHasSignal
    ? encodeFloat32ToWavBase64(normalizeSpeechDynamics(combinedFiltered), sampleRate)
    : "";
  const rawWavBase64 = windowHasSignal
    ? encodeFloat32ToWavBase64(combinedRaw, sampleRate)
    : "";

  return {
    windowIndex,
    windowStartMs,
    windowEndMs,
    hasAudioSignal: windowHasSignal,
    halves,
    tailSamples,
    hqWavBase64,
    rawWavBase64,
  };
}

/**
 * Replaces unedited provisional live segments in a 10s window with the
 * high-quality backward-refined segments from the 4 workers, while preserving
 * any user-edited segments and keeping all segments sorted chronologically.
 */
export function mergeWindowRefinedSegments(
  existingSegments: TranscriptSegment[],
  params: {
    windowIndex: number;
    windowStartMs: number;
    windowEndMs: number;
    refinedSegments: TranscriptSegment[];
    replaceHalfIndices?: number[];
  }
): TranscriptSegment[] {
  const {
    windowIndex,
    windowStartMs,
    windowEndMs,
    refinedSegments,
    replaceHalfIndices,
  } = params;
  const halfSet = replaceHalfIndices ? new Set(replaceHalfIndices) : null;

  const kept = existingSegments.filter((seg) => {
    if (seg.isEdited) return true;
    if (halfSet && seg.liveHalfIndex !== undefined && halfSet.has(seg.liveHalfIndex)) {
      return false;
    }
    if (seg.liveWindowIndex === windowIndex && !halfSet) {
      return false;
    }
    if (
      seg.isProvisional &&
      (seg.liveWindowIndex === windowIndex ||
        (seg.liveWindowIndex === undefined &&
          seg.timestampMs >= Math.max(0, windowStartMs - 150) &&
          seg.timestampMs < windowEndMs))
    ) {
      return false;
    }
    return true;
  });

  return [...kept, ...refinedSegments].sort(
    (a, b) => a.timestampMs - b.timestampMs
  );
}
