import type { TranscriptionSession } from "../types/transcribe";

export function downsampleBuffer(
  buffer: Float32Array,
  inputSampleRate: number,
  targetSampleRate = 16000
): Float32Array {
  if (inputSampleRate === targetSampleRate || buffer.length === 0) {
    return buffer;
  }

  const ratio = inputSampleRate / targetSampleRate;
  const newLength = Math.max(1, Math.round(buffer.length / ratio));
  const result = new Float32Array(newLength);

  // Clean integer decimation (e.g. 48kHz -> 16kHz): symmetric box filter
  if (Math.abs(ratio - Math.round(ratio)) < 1e-4 && ratio >= 2) {
    const step = Math.round(ratio);
    for (let i = 0; i < newLength; i++) {
      const start = i * step;
      const end = Math.min(buffer.length, start + step);
      let sum = 0;
      let count = 0;
      for (let j = start; j < end; j++) {
        sum += buffer[j];
        count++;
      }
      result[i] = count > 0 ? sum / count : 0;
    }
    return result;
  }

  // Non-integer rates (e.g. 44.1kHz -> 16kHz): anti-aliased Lanczos-3 resampling
  const a = 3;
  const sinc = (x: number) => {
    if (Math.abs(x) < 1e-6) return 1;
    const pix = Math.PI * x;
    return Math.sin(pix) / pix;
  };
  const lanczos = (x: number) => {
    const ax = Math.abs(x);
    if (ax >= a) return 0;
    return sinc(x) * sinc(x / a);
  };

  for (let i = 0; i < newLength; i++) {
    const center = i * ratio;
    const left = Math.max(0, Math.floor(center - a * ratio));
    const right = Math.min(buffer.length - 1, Math.ceil(center + a * ratio));
    let sum = 0;
    let weightSum = 0;
    for (let j = left; j <= right; j++) {
      const w = lanczos((j - center) / ratio);
      sum += buffer[j] * w;
      weightSum += w;
    }
    result[i] =
      weightSum > 1e-6
        ? sum / weightSum
        : buffer[Math.min(buffer.length - 1, Math.round(center))];
  }
  return result;
}

/**
 * First-order ~55Hz high-pass + DC-blocking filter to remove low-frequency rumble
 * and microphone DC bias while preserving full vocal warmth.
 */
export function applySpeechHighPassFilter(
  samples: Float32Array,
  sampleRate: number
): Float32Array {
  if (samples.length === 0) return samples;
  const cutoffHz = 55;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / Math.max(1, sampleRate);
  const alpha = rc / (rc + dt);

  const out = new Float32Array(samples.length);
  let prevIn = samples[0];
  let prevOut = 0;
  out[0] = 0;
  for (let i = 1; i < samples.length; i++) {
    const cur = samples[i];
    prevOut = alpha * (prevOut + cur - prevIn);
    out[i] = prevOut;
    prevIn = cur;
  }
  return out;
}

/**
 * Soft-knee gain conditioning for quiet audio segments without clipping peaks.
 */
export function normalizeSpeechDynamics(samples: Float32Array): Float32Array {
  if (samples.length === 0) return samples;
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    const abs = v < 0 ? -v : v;
    if (abs > peak) peak = abs;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  if (rms < 0.0004 || peak < 1e-5) {
    return samples;
  }

  // Boost quiet voices toward healthy ~0.10 RMS while capping gain and peak at 0.88
  const targetRms = 0.1;
  const desiredGain = rms < targetRms ? Math.min(3.2, targetRms / rms) : 1.0;
  const maxSafeGain = 0.88 / peak;
  const gain = Math.min(desiredGain, maxSafeGain);

  if (gain <= 1.05) {
    return samples;
  }

  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-0.95, Math.min(0.95, samples[i] * gain));
  }
  return out;
}

export function float32ToBase64Pcm16(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return uint8ToBase64(new Uint8Array(int16.buffer));
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export interface AudioPcmChunk {
  index: number;
  startSec: number;
  endSec: number;
  speechStartSec: number;
  speechEndSec: number;
  pcmPacketsBase64: string[];
  rawPacketsBase64: string[];
  hasAudioSignal: boolean;
}

export async function sliceAudioFileIntoLiveChunks(
  file: File,
  chunkDurationSec = 15,
  samplesPerPacket = 2048 // 128ms per 16kHz PCM packet (matches live mic cadence)
): Promise<{ totalDurationMs: number; chunks: AudioPcmChunk[] }> {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  const ctx = new AudioCtx();

  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    const totalDurationSec = decoded.duration;
    const totalDurationMs = Math.round(totalDurationSec * 1000);
    const srcRate = decoded.sampleRate;
    const numChannels = decoded.numberOfChannels;

    // Mix down to mono Float32Array
    const rawMono = new Float32Array(decoded.length);
    for (let ch = 0; ch < numChannels; ch++) {
      const chData = decoded.getChannelData(ch);
      for (let i = 0; i < decoded.length; i++) {
        rawMono[i] += chData[i] / numChannels;
      }
    }

    // Apply ~55Hz high-pass / DC-blocking filter cleanly across whole track
    const mono = applySpeechHighPassFilter(rawMono, srcRate);

    const samplesPerChunk = Math.floor(chunkDurationSec * srcRate);
    const snapRadiusSamples = Math.floor(0.45 * srcRate);
    const frameWindowSamples = Math.max(1, Math.floor(0.025 * srcRate));
    const minChunkSamples = Math.floor(2 * srcRate);
    const leadInSamples = Math.floor(0.55 * srcRate);
    const silentPadPacket = float32ToBase64Pcm16(
      new Float32Array(samplesPerPacket)
    );

    const findQuietestCut = (nominalSample: number): number => {
      const searchStart = Math.max(
        minChunkSamples,
        nominalSample - snapRadiusSamples
      );
      const searchEnd = Math.min(
        mono.length - frameWindowSamples,
        nominalSample + snapRadiusSamples
      );
      if (searchEnd <= searchStart) {
        return Math.min(mono.length, nominalSample);
      }

      let bestSample = nominalSample;
      let bestEnergy = Infinity;
      const step = Math.max(1, Math.floor(frameWindowSamples / 2));

      for (let pos = searchStart; pos <= searchEnd; pos += step) {
        let energy = 0;
        for (let k = 0; k < frameWindowSamples; k++) {
          const s = mono[pos + k];
          energy += s * s;
        }
        if (energy < bestEnergy) {
          bestEnergy = energy;
          bestSample = pos + Math.floor(frameWindowSamples / 2);
        }
      }
      return Math.min(mono.length, bestSample);
    };

    const chunks: AudioPcmChunk[] = [];
    let index = 0;
    let startSample = 0;

    const packetize = (samples: Float32Array, hasSignal: boolean): string[] => {
      const ds = downsampleBuffer(samples, srcRate, 16000);
      const pkts: string[] = [];
      // 256ms silent VAD warm-up lead-in so opening words at 0.00s never clip
      if (hasSignal && ds.length > 0) {
        pkts.push(silentPadPacket, silentPadPacket);
      }
      for (let p = 0; p < ds.length; p += samplesPerPacket) {
        const endIdx = Math.min(ds.length, p + samplesPerPacket);
        pkts.push(float32ToBase64Pcm16(ds.subarray(p, endIdx)));
      }
      // 256ms trailing digital silence flush so final words commit cleanly
      if (hasSignal && pkts.length > 2) {
        pkts.push(silentPadPacket, silentPadPacket);
      }
      return pkts;
    };

    while (startSample < mono.length) {
      const nominalEnd = (index + 1) * samplesPerChunk;
      const endSample =
        nominalEnd >= mono.length - Math.floor(0.8 * srcRate)
          ? mono.length
          : findQuietestCut(nominalEnd);

      if (index > 0 && endSample - startSample < srcRate * 0.25) {
        break;
      }

      // Compute canonical speech envelope inside [startSample, endSample]
      const canonicalSlice = mono.subarray(startSample, endSample);
      let canonSumSq = 0;
      for (let i = 0; i < canonicalSlice.length; i++) {
        canonSumSq += canonicalSlice[i] * canonicalSlice[i];
      }
      const canonRms = Math.sqrt(
        canonSumSq / Math.max(1, canonicalSlice.length)
      );
      const hasAudioSignal = canonRms > 0.0001;

      const startSec = Number((startSample / srcRate).toFixed(2));
      const endSec = Number((endSample / srcRate).toFixed(2));

      // Locate actual vocal onset/offset within the 15s segment for tighter caption sync
      const win50Ms = Math.max(1, Math.floor(0.05 * srcRate));
      const activityThreshold = Math.max(0.004, canonRms * 0.35);
      let firstActiveSample = -1;
      let lastActiveSample = -1;
      for (let pos = 0; pos + win50Ms <= canonicalSlice.length; pos += win50Ms) {
        let wSum = 0;
        for (let k = 0; k < win50Ms; k++) {
          const s = canonicalSlice[pos + k];
          wSum += s * s;
        }
        const wRms = Math.sqrt(wSum / win50Ms);
        if (wRms >= activityThreshold) {
          if (firstActiveSample === -1) firstActiveSample = pos;
          lastActiveSample = pos + win50Ms;
        }
      }

      const speechStartSec =
        firstActiveSample >= 0
          ? Number(
              Math.max(
                startSec,
                startSec + firstActiveSample / srcRate - 0.2
              ).toFixed(2)
            )
          : startSec;
      const speechEndSec =
        lastActiveSample > firstActiveSample
          ? Number(
              Math.min(
                endSec,
                startSec + lastActiveSample / srcRate + 0.25
              ).toFixed(2)
            )
          : endSec;

      // Add 0.55s acoustic lead-in overlap for chunks > 0 so boundary syllables never clip
      const streamStartSample =
        index > 0 ? Math.max(0, startSample - leadInSamples) : startSample;
      const streamSlice = mono.subarray(streamStartSample, endSample);
      const rawSlice = rawMono.subarray(streamStartSample, endSample);

      const pcmPacketsBase64 = packetize(
        normalizeSpeechDynamics(streamSlice),
        hasAudioSignal
      );
      const rawPacketsBase64 = packetize(rawSlice, hasAudioSignal);

      chunks.push({
        index,
        startSec,
        endSec,
        speechStartSec:
          speechEndSec - speechStartSec >= 0.8 ? speechStartSec : startSec,
        speechEndSec:
          speechEndSec - speechStartSec >= 0.8 ? speechEndSec : endSec,
        pcmPacketsBase64,
        rawPacketsBase64,
        hasAudioSignal,
      });

      startSample = endSample;
      index++;
    }

    return { totalDurationMs, chunks };
  } finally {
    await ctx.close().catch(() => {});
  }
}

export function cleanTranscriptArtifacts(text: string): string {
  let cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";

  // Remove stray spaces before punctuation
  cleaned = cleaned.replace(/\s+([.,!?;:።፣፤፧。，？！])/g, "$1");

  // Collapse pathological 3+ consecutive identical phrase/word loops from silence/noise
  cleaned = cleaned.replace(
    /\b([^\s]{1,24}(?:\s+[^\s]{1,24}){0,2})(?:\s+\1){2,}\b/giu,
    "$1"
  );

  return cleaned.trim();
}

const EDGE_PUNCT_RE =
  /^[\s.,!?;:'"()[\]«»‹›„“”‘’።፣፤፧。，？！]+|[\s.,!?;:'"()[\]«»‹›„“”‘’።፣፤፧。，？！]+$/gu;

function normalizeToken(tok: string): string {
  return tok.replace(EDGE_PUNCT_RE, "").toLowerCase();
}

/**
 * Removes duplicated words/characters at the start of `currentText` that already
 * appeared at the end of `prevText` due to the 0.60s acoustic overlap lead-in.
 */
export function stitchChunkBoundary(
  prevText: string,
  currentText: string
): string {
  const prevClean = prevText.trim();
  const curClean = currentText.trim();
  if (!prevClean || !curClean) return curClean;

  const prevWords = prevClean.split(/\s+/).filter(Boolean);
  const curWords = curClean.split(/\s+/).filter(Boolean);

  if (prevWords.length > 0 && curWords.length > 0) {
    const maxK = Math.min(10, prevWords.length, curWords.length);
    for (let k = maxK; k >= 1; k--) {
      let matched = true;
      for (let j = 0; j < k; j++) {
        const a = normalizeToken(prevWords[prevWords.length - k + j]);
        const b = normalizeToken(curWords[j]);
        if (!a || !b || a !== b) {
          matched = false;
          break;
        }
      }
      if (matched) {
        if (k >= 2 || normalizeToken(curWords[0]).length >= 5) {
          const remaining = curWords.slice(k).join(" ").trim();
          return remaining;
        }
      }
    }
  }

  // Fallback for spaceless CJK/Japanese text overlap
  if (!/\s/.test(prevClean) && !/\s/.test(curClean)) {
    const maxChars = Math.min(16, prevClean.length, curClean.length);
    for (let c = maxChars; c >= 3; c--) {
      if (prevClean.slice(-c) === curClean.slice(0, c)) {
        return curClean.slice(c).trim();
      }
    }
  }

  return curClean;
}

export function detectScriptFamily(text: string): string | null {
  const counts: Record<string, number> = {
    ethiopic: (text.match(/[\u1200-\u137F]/g) ?? []).length,
    devanagari: (text.match(/[\u0900-\u097F]/g) ?? []).length,
    arabic: (text.match(/[\u0600-\u06FF]/g) ?? []).length,
    japanese: (text.match(/[\u3040-\u30FF]/g) ?? []).length,
    korean: (text.match(/[\uAC00-\uD7AF]/g) ?? []).length,
    cjk: (text.match(/[\u4E00-\u9FFF]/g) ?? []).length,
    cyrillic: (text.match(/[\u0400-\u04FF]/g) ?? []).length,
    latin: (text.match(/[A-Za-z]/g) ?? []).length,
  };
  let bestFamily: string | null = null;
  let bestCount = 0;
  for (const [family, count] of Object.entries(counts)) {
    if (count > bestCount) {
      bestCount = count;
      bestFamily = family;
    }
  }
  return bestFamily;
}

export function hasMixedLatinWithNonLatin(text: string): boolean {
  const dominant = detectScriptFamily(text);
  if (!dominant || dominant === "latin") return false;
  const latinChars = (text.match(/[A-Za-z]/g) ?? []).length;
  return latinChars >= 4;
}

function buildFeatureSet(text: string): Set<string> {
  const features = new Set<string>();
  const words = text
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
  for (const w of words) features.add(`w:${w}`);
  const compact = text.replace(/\s+/g, "").toLowerCase();
  for (let i = 0; i + 3 <= compact.length; i++) {
    features.add(`g:${compact.slice(i, i + 3)}`);
  }
  return features;
}

/**
 * Reconciles 1-4 independent worker transcripts produced on the SAME 15s segment
 * to reject truncated partial passes or isolated hallucinations and pick the fullest,
 * highest-consensus transcript.
 */
export function reconcileFocusedTranscripts(
  passes: Array<{ text: string; lang?: string; isSmart?: boolean }>,
  preferredScript?: string | null
): { text: string; lang?: string } {
  const valid = passes
    .map((p) => ({ ...p, text: cleanTranscriptArtifacts(p.text) }))
    .filter((p) => p.text.length > 0);

  if (valid.length === 0) return { text: "" };
  if (valid.length === 1) return { text: valid[0].text, lang: valid[0].lang };

  const scriptPool = preferredScript
    ? valid.filter((p) => detectScriptFamily(p.text) === preferredScript)
    : [];
  const pool = scriptPool.length > 0 ? scriptPool : valid;
  if (pool.length === 1) return { text: pool[0].text, lang: pool[0].lang };

  const featureSets = pool.map((p) => buildFeatureSet(p.text));
  const supportScores = pool.map((_, idx) => {
    const mine = featureSets[idx];
    if (mine.size === 0) return 0;
    let supported = 0;
    for (const feat of mine) {
      for (let j = 0; j < pool.length; j++) {
        if (j !== idx && featureSets[j].has(feat)) {
          supported++;
          break;
        }
      }
    }
    return supported / mine.size;
  });

  const nonOutlierIndices = pool
    .map((_, i) => i)
    .filter((i) => supportScores[i] >= 0.25);
  const maxLen = Math.max(
    1,
    ...(nonOutlierIndices.length > 0
      ? nonOutlierIndices.map((i) => pool[i].text.length)
      : pool.map((p) => p.text.length))
  );

  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < pool.length; i++) {
    const coverage = Math.min(1, pool[i].text.length / maxLen);
    const mixedPenalty = hasMixedLatinWithNonLatin(pool[i].text) ? 0.12 : 0;
    const smartBonus = pool[i].isSmart ? 0.02 : 0;
    const score =
      supportScores[i] * 0.52 + coverage * 0.48 + smartBonus - mixedPenalty;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  const chosen = pool[bestIdx];
  return {
    text: chosen.text,
    lang: chosen.lang ?? pool.find((p) => p.lang)?.lang,
  };
}

export function scriptFamilyToBcp47(family: string | null): string | null {
  switch (family) {
    case "ethiopic":
      return "am-ET";
    case "devanagari":
      return "hi-IN";
    case "arabic":
      return "ar-SA";
    case "japanese":
      return "ja-JP";
    case "korean":
      return "ko-KR";
    case "cjk":
      return "zh-CN";
    default:
      return null;
  }
}

export function bcp47ToScriptFamily(code?: string | null): string | null {
  if (!code || code === "auto") return null;
  const base = code.toLowerCase().split("-")[0];
  switch (base) {
    case "am":
    case "ti":
      return "ethiopic";
    case "hi":
      return "devanagari";
    case "ar":
      return "arabic";
    case "ja":
      return "japanese";
    case "ko":
      return "korean";
    case "zh":
      return "cjk";
    case "en":
    case "es":
    case "fr":
    case "de":
    case "it":
    case "pt":
      return "latin";
    default:
      return null;
  }
}

export function splitTextIntoTimedCues(
  text: string,
  chunkStartMs: number,
  chunkEndMs: number
): Array<{ text: string; startMs: number; endMs: number }> {
  const cleaned = text.trim();
  if (!cleaned) return [];

  const rawParts = cleaned
    .split(/(?<=[.!?።፧。？！])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const phrases: string[] = [];
  for (const part of rawParts) {
    if (part.length <= 95) {
      phrases.push(part);
    } else {
      const words = part.split(/\s+/);
      let current = "";
      for (const w of words) {
        if ((current + " " + w).trim().length > 80 && current) {
          phrases.push(current.trim());
          current = w;
        } else {
          current = current ? `${current} ${w}` : w;
        }
      }
      if (current.trim()) phrases.push(current.trim());
    }
  }

  const totalChars = phrases.reduce((sum, p) => sum + p.length, 0) || 1;
  const durationMs = Math.max(800, chunkEndMs - chunkStartMs);
  let cursor = chunkStartMs;

  return phrases.map((phrase, idx) => {
    const share = (phrase.length / totalChars) * durationMs;
    const startMs = Math.round(cursor);
    const endMs =
      idx === phrases.length - 1
        ? Math.round(chunkEndMs)
        : Math.round(cursor + share);
    cursor += share;
    return { text: phrase, startMs, endMs };
  });
}

export const AUDIO_WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(2048);
    this._offset = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];
    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._offset++] = channel[i];
      if (this._offset >= this._buffer.length) {
        this.port.postMessage(this._buffer.slice(0));
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
`;

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

export function formatTimestampLabel(ms: number): string {
  return formatDuration(ms);
}

export function formatSpeakerDisplay(
  speakerId: string,
  speakerNames: Record<string, string>
): string {
  if (speakerNames[speakerId]) {
    return speakerNames[speakerId];
  }
  const match = speakerId.match(/(\d+)$/);
  if (match) {
    return `Speaker ${match[1]}`;
  }
  if (speakerId === "default" || !speakerId) {
    return "Speaker 1";
  }
  return speakerId;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function formatSrtTime(ms: number): string {
  const totalMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

export function buildExportContent(
  session: TranscriptionSession,
  format: "txt" | "md" | "srt" | "json"
): { content: string; mimeType: string; extension: string } {
  const showSpeakers =
    session.config.diarization || Object.keys(session.speakerNames).length > 1;

  if (format === "txt") {
    const lines = session.segments.map((seg) => {
      const ts = `[${formatTimestampLabel(seg.timestampMs)}]`;
      const spk = showSpeakers
        ? `${formatSpeakerDisplay(seg.speakerId, session.speakerNames)}: `
        : "";
      return `${ts} ${spk}${seg.text}`;
    });
    return {
      content: lines.join("\n\n"),
      mimeType: "text/plain;charset=utf-8",
      extension: "txt",
    };
  }

  if (format === "md") {
    const header = `# ${session.title}\n\nRecorded ${new Date(session.createdAt).toLocaleString()} · Duration ${formatDuration(session.durationMs)}\n\n---\n\n`;
    const body = session.segments
      .map((seg) => {
        const ts = `**${formatTimestampLabel(seg.timestampMs)}**`;
        const spk = showSpeakers
          ? ` **${formatSpeakerDisplay(seg.speakerId, session.speakerNames)}**`
          : "";
        return `${ts}${spk}\n${seg.text}`;
      })
      .join("\n\n");
    const notesBlock = session.notes?.summary
      ? `\n\n---\n\n## Summary\n\n${session.notes.summary}`
      : "";
    return {
      content: header + body + notesBlock,
      mimeType: "text/markdown;charset=utf-8",
      extension: "md",
    };
  }

  if (format === "srt") {
    const entries = session.segments.map((seg, idx) => {
      const next = session.segments[idx + 1];
      const startMs = seg.timestampMs;
      const endMs =
        seg.endTimestampMs ??
        (next
          ? Math.max(startMs + 1000, next.timestampMs - 100)
          : startMs + Math.max(2000, countWords(seg.text) * 380));
      const spk = showSpeakers
        ? `${formatSpeakerDisplay(seg.speakerId, session.speakerNames)}: `
        : "";
      return `${idx + 1}\n${formatSrtTime(startMs)} --> ${formatSrtTime(endMs)}\n${spk}${seg.text}`;
    });
    return {
      content: entries.join("\n\n"),
      mimeType: "application/x-subrip;charset=utf-8",
      extension: "srt",
    };
  }

  return {
    content: JSON.stringify(session, null, 2),
    mimeType: "application/json;charset=utf-8",
    extension: "json",
  };
}
