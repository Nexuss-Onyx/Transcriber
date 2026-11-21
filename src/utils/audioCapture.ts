import type { TranscriptionSession } from "../types/transcribe";

export function downsampleBuffer(
  buffer: Float32Array,
  inputSampleRate: number,
  targetSampleRate = 16000
): Float32Array {
  if (inputSampleRate === targetSampleRate) {
    return buffer;
  }
  const ratio = inputSampleRate / targetSampleRate;
  const newLength = Math.max(1, Math.round(buffer.length / ratio));
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(buffer.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += buffer[j];
      count++;
    }
    result[i] =
      count > 0 ? sum / count : buffer[Math.min(start, buffer.length - 1)];
  }
  return result;
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
  pcmPacketsBase64: string[];
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
    const mono = new Float32Array(decoded.length);
    for (let ch = 0; ch < numChannels; ch++) {
      const chData = decoded.getChannelData(ch);
      for (let i = 0; i < decoded.length; i++) {
        mono[i] += chData[i] / numChannels;
      }
    }

    const samplesPerChunk = Math.floor(chunkDurationSec * srcRate);
    const snapRadiusSamples = Math.floor(0.45 * srcRate);
    const frameWindowSamples = Math.max(1, Math.floor(0.025 * srcRate));
    const minChunkSamples = Math.floor(2 * srcRate);

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

    while (startSample < mono.length) {
      const nominalEnd = (index + 1) * samplesPerChunk;
      const endSample =
        nominalEnd >= mono.length - Math.floor(0.8 * srcRate)
          ? mono.length
          : findQuietestCut(nominalEnd);

      if (index > 0 && endSample - startSample < srcRate * 0.25) {
        break;
      }

      const slice = mono.subarray(startSample, endSample);
      const downsampled = downsampleBuffer(slice, srcRate, 16000);

      // Compute RMS energy to detect digital silence
      let sumSq = 0;
      for (let i = 0; i < downsampled.length; i++) {
        sumSq += downsampled[i] * downsampled[i];
      }
      const rms = Math.sqrt(sumSq / Math.max(1, downsampled.length));

      const pcmPacketsBase64: string[] = [];
      for (let p = 0; p < downsampled.length; p += samplesPerPacket) {
        const endIdx = Math.min(downsampled.length, p + samplesPerPacket);
        pcmPacketsBase64.push(
          float32ToBase64Pcm16(downsampled.subarray(p, endIdx))
        );
      }

      chunks.push({
        index,
        startSec: Number((startSample / srcRate).toFixed(2)),
        endSec: Number((endSample / srcRate).toFixed(2)),
        pcmPacketsBase64,
        hasAudioSignal: rms > 0.0001,
      });

      startSample = endSample;
      index++;
    }

    return { totalDurationMs, chunks };
  } finally {
    await ctx.close().catch(() => {});
  }
}

export function detectScriptFamily(text: string): string | null {
  if (/[\u1200-\u137F]/.test(text)) return "ethiopic";
  if (/[\u0900-\u097F]/.test(text)) return "devanagari";
  if (/[\u0600-\u06FF]/.test(text)) return "arabic";
  if (/[\u3040-\u30FF]/.test(text)) return "japanese";
  if (/[\uAC00-\uD7AF]/.test(text)) return "korean";
  if (/[\u4E00-\u9FFF]/.test(text)) return "cjk";
  if (/[\u0400-\u04FF]/.test(text)) return "cyrillic";
  if (/[A-Za-z]/.test(text)) return "latin";
  return null;
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
  const durationMs = Math.max(1000, chunkEndMs - chunkStartMs);
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
