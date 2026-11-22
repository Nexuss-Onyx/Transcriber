import type { TranscriptSegment } from "../types/transcribe";
import {
  cleanTranscriptArtifacts,
  splitTextIntoTimedCues,
} from "./audioCapture";

export const LIVE_LM_INTERVAL_MS = 60_000;

export interface StructuredWorkerOutputs {
  worker1LiveRealtime: string;
  worker6LiveHqRealtime?: string;
  worker2FirstHalfPrimary: string;
  worker3FirstHalfContrast: string;
  worker4SecondHalfPrimary: string;
  worker5SecondHalfContrast: string;
}

export interface StructuredWorkerWindow {
  windowIndex: number;
  startMs: number;
  endMs: number;
  workers: StructuredWorkerOutputs;
  backwardDone: boolean;
  lmRefined: boolean;
}

export interface RefinedWindowResult {
  windowIndex: number;
  refinedText: string;
  detectedLanguage?: string;
}

function emptyWorkerOutputs(): StructuredWorkerOutputs {
  return {
    worker1LiveRealtime: "",
    worker6LiveHqRealtime: "",
    worker2FirstHalfPrimary: "",
    worker3FirstHalfContrast: "",
    worker4SecondHalfPrimary: "",
    worker5SecondHalfContrast: "",
  };
}

/**
 * Records an utterance from Worker 1 (real-time voice stream) for `windowIndex`
 * without altering or overriding any backward workers.
 */
export function upsertLiveWorkerObservation(
  windows: Map<number, StructuredWorkerWindow>,
  windowIndex: number,
  startMs: number,
  endMs: number,
  textChunk: string
): StructuredWorkerWindow {
  const cleaned = cleanTranscriptArtifacts(textChunk);
  let entry = windows.get(windowIndex);
  if (!entry) {
    entry = {
      windowIndex,
      startMs,
      endMs,
      workers: emptyWorkerOutputs(),
      backwardDone: false,
      lmRefined: false,
    };
    windows.set(windowIndex, entry);
  } else {
    entry.endMs = Math.max(entry.endMs, endMs);
  }

  if (cleaned) {
    const prev = entry.workers.worker1LiveRealtime;
    if (!prev) {
      entry.workers.worker1LiveRealtime = cleaned;
    } else if (!prev.endsWith(cleaned)) {
      entry.workers.worker1LiveRealtime = cleanTranscriptArtifacts(
        `${prev} ${cleaned}`
      );
    }
  }
  return entry;
}

/**
 * Records an utterance from Live Worker 1B (real-time high-quality conditioned voice stream)
 * for `windowIndex` without altering Worker 1A or backward workers.
 */
export function upsertLiveHqWorkerObservation(
  windows: Map<number, StructuredWorkerWindow>,
  windowIndex: number,
  startMs: number,
  endMs: number,
  textChunk: string
): StructuredWorkerWindow {
  const cleaned = cleanTranscriptArtifacts(textChunk);
  let entry = windows.get(windowIndex);
  if (!entry) {
    entry = {
      windowIndex,
      startMs,
      endMs,
      workers: emptyWorkerOutputs(),
      backwardDone: false,
      lmRefined: false,
    };
    windows.set(windowIndex, entry);
  } else {
    entry.endMs = Math.max(entry.endMs, endMs);
  }

  if (cleaned) {
    const prev = entry.workers.worker6LiveHqRealtime ?? "";
    if (!prev) {
      entry.workers.worker6LiveHqRealtime = cleaned;
    } else if (!prev.endsWith(cleaned)) {
      entry.workers.worker6LiveHqRealtime = cleanTranscriptArtifacts(
        `${prev} ${cleaned}`
      );
    }
  }
  return entry;
}

/**
 * Records all 4 independent backward worker outputs for a completed 10s window
 * without discarding or overriding Worker 1 or each other.
 */
export function upsertBackwardWorkerObservations(
  windows: Map<number, StructuredWorkerWindow>,
  windowIndex: number,
  startMs: number,
  endMs: number,
  outputs: {
    firstHalfPrimary?: string;
    firstHalfContrast?: string;
    secondHalfPrimary?: string;
    secondHalfContrast?: string;
  }
): StructuredWorkerWindow {
  let entry = windows.get(windowIndex);
  if (!entry) {
    entry = {
      windowIndex,
      startMs,
      endMs,
      workers: emptyWorkerOutputs(),
      backwardDone: false,
      lmRefined: false,
    };
    windows.set(windowIndex, entry);
  } else {
    entry.startMs = Math.min(entry.startMs, startMs);
    entry.endMs = Math.max(entry.endMs, endMs);
  }

  entry.workers.worker2FirstHalfPrimary = cleanTranscriptArtifacts(
    outputs.firstHalfPrimary ?? entry.workers.worker2FirstHalfPrimary
  );
  entry.workers.worker3FirstHalfContrast = cleanTranscriptArtifacts(
    outputs.firstHalfContrast ?? entry.workers.worker3FirstHalfContrast
  );
  entry.workers.worker4SecondHalfPrimary = cleanTranscriptArtifacts(
    outputs.secondHalfPrimary ?? entry.workers.worker4SecondHalfPrimary
  );
  entry.workers.worker5SecondHalfContrast = cleanTranscriptArtifacts(
    outputs.secondHalfContrast ?? entry.workers.worker5SecondHalfContrast
  );
  entry.backwardDone = true;

  return entry;
}

/**
 * Records all 5 focused parallel worker outputs for an uploaded 15s segment
 * without allowing any worker to overwrite another prior to LM synthesis.
 */
export function upsertUploadWorkerObservations(
  windows: Map<number, StructuredWorkerWindow>,
  chunkIndex: number,
  startMs: number,
  endMs: number,
  outputs: {
    worker0RawPrimary?: string;
    worker1RawContrast?: string;
    worker2HqVerbatim?: string;
    worker3HqSmart?: string;
    worker4HqClarified?: string;
  }
): StructuredWorkerWindow {
  let entry = windows.get(chunkIndex);
  if (!entry) {
    entry = {
      windowIndex: chunkIndex,
      startMs,
      endMs,
      workers: emptyWorkerOutputs(),
      backwardDone: false,
      lmRefined: false,
    };
    windows.set(chunkIndex, entry);
  } else {
    entry.startMs = Math.min(entry.startMs, startMs);
    entry.endMs = Math.max(entry.endMs, endMs);
  }

  entry.workers.worker1LiveRealtime = cleanTranscriptArtifacts(
    outputs.worker0RawPrimary ?? entry.workers.worker1LiveRealtime
  );
  entry.workers.worker2FirstHalfPrimary = cleanTranscriptArtifacts(
    outputs.worker1RawContrast ?? entry.workers.worker2FirstHalfPrimary
  );
  entry.workers.worker3FirstHalfContrast = cleanTranscriptArtifacts(
    outputs.worker2HqVerbatim ?? entry.workers.worker3FirstHalfContrast
  );
  entry.workers.worker4SecondHalfPrimary = cleanTranscriptArtifacts(
    outputs.worker3HqSmart ?? entry.workers.worker4SecondHalfPrimary
  );
  entry.workers.worker5SecondHalfContrast = cleanTranscriptArtifacts(
    outputs.worker4HqClarified ?? entry.workers.worker5SecondHalfContrast
  );
  entry.backwardDone = true;

  return entry;
}

export function hasAnyWorkerOutput(entry: StructuredWorkerWindow): boolean {
  const w = entry.workers;
  return Boolean(
    w.worker1LiveRealtime ||
      w.worker6LiveHqRealtime ||
      w.worker2FirstHalfPrimary ||
      w.worker3FirstHalfContrast ||
      w.worker4SecondHalfPrimary ||
      w.worker5SecondHalfContrast
  );
}

/**
 * Collects windows that have completed all 5 workers and await the 1-minute LM pass.
 */
export function collectDueRefinementWindows(
  windows: Map<number, StructuredWorkerWindow>
): StructuredWorkerWindow[] {
  const due: StructuredWorkerWindow[] = [];
  for (const entry of windows.values()) {
    if (!entry.lmRefined && entry.backwardDone && hasAnyWorkerOutput(entry)) {
      due.push({
        ...entry,
        workers: { ...entry.workers },
      });
    }
  }
  due.sort((a, b) => a.windowIndex - b.windowIndex);
  return due;
}

/**
 * Extracts trailing already-transcribed context strictly before `beforeWindowIndex`
 * so the language model understands conversational flow without repeating prior text.
 */
export function buildPriorContextSnippet(
  segments: TranscriptSegment[],
  beforeWindowIndex: number,
  maxChars = 600,
  keyField: "liveWindowIndex" | "chunkIndex" = "liveWindowIndex"
): string {
  const prior = segments
    .filter((seg) => {
      const idx = seg[keyField];
      return (
        typeof idx === "number" &&
        idx < beforeWindowIndex &&
        seg.text.trim().length > 0
      );
    })
    .sort((a, b) => a.timestampMs - b.timestampMs)
    .map((seg) => seg.text.trim())
    .join(" ");

  if (prior.length <= maxChars) return prior;
  return prior.slice(-maxChars).trim();
}

/**
 * Merges LM-refined window texts non-destructively into session segments:
 * user-edited segments (`isEdited`) are always preserved, and refined windows
 * replace only unedited provisional segments belonging to those window indices.
 */
export function applyLmRefinedWindowsToSegments(
  existingSegments: TranscriptSegment[],
  windowsByIndex: Map<number, StructuredWorkerWindow>,
  refinedResults: RefinedWindowResult[],
  fallbackLang?: string
): TranscriptSegment[] {
  const resultMap = new Map<number, RefinedWindowResult>();
  for (const res of refinedResults) {
    resultMap.set(res.windowIndex, res);
  }

  const keptSegments = existingSegments.filter((seg) => {
    if (seg.isEdited) return true;
    const winIdx = seg.liveWindowIndex;
    if (typeof winIdx !== "number") return true;
    return !resultMap.has(winIdx);
  });

  const additions: TranscriptSegment[] = [];
  for (const res of refinedResults) {
    const winMeta = windowsByIndex.get(res.windowIndex);
    if (!winMeta) continue;

    // Skip inserting if user manually edited a segment inside this window
    const hasEditedInWindow = existingSegments.some(
      (s) => s.liveWindowIndex === res.windowIndex && Boolean(s.isEdited)
    );
    if (hasEditedInWindow) continue;

    const cleaned = cleanTranscriptArtifacts(res.refinedText ?? "");
    if (!cleaned) continue;

    const startMs = winMeta.startMs;
    const endMs = Math.max(startMs + 500, winMeta.endMs);
    const cues = splitTextIntoTimedCues(cleaned, startMs, endMs);
    const lang = res.detectedLanguage || fallbackLang;

    cues.forEach((cue, cueIdx) => {
      additions.push({
        id: `seg_lm_${res.windowIndex}_${cueIdx}_${Date.now()}`,
        text: cue.text,
        speakerId: "spk_1",
        languageCode: lang,
        timestampMs: cue.startMs,
        endTimestampMs: cue.endMs,
        liveWindowIndex: res.windowIndex,
        isProvisional: false,
        isRefined: true,
      });
    });
  }

  return [...keptSegments, ...additions].sort(
    (a, b) => a.timestampMs - b.timestampMs
  );
}

/**
 * Same non-destructive LM merge for uploaded 15s chunked audio segments
 * keyed by `chunkIndex`, preserving manual edits and player sync boundaries.
 */
export function applyLmRefinedChunksToSegments(
  existingSegments: TranscriptSegment[],
  chunksByIndex: Map<number, StructuredWorkerWindow>,
  refinedResults: RefinedWindowResult[],
  fallbackLang?: string
): TranscriptSegment[] {
  const resultMap = new Map<number, RefinedWindowResult>();
  for (const res of refinedResults) {
    resultMap.set(res.windowIndex, res);
  }

  const keptSegments = existingSegments.filter((seg) => {
    if (seg.isEdited) return true;
    const chunkIdx = seg.chunkIndex;
    if (typeof chunkIdx !== "number") return true;
    return !resultMap.has(chunkIdx);
  });

  const additions: TranscriptSegment[] = [];
  for (const res of refinedResults) {
    const chunkMeta = chunksByIndex.get(res.windowIndex);
    if (!chunkMeta) continue;

    const hasEditedInChunk = existingSegments.some(
      (s) => s.chunkIndex === res.windowIndex && Boolean(s.isEdited)
    );
    if (hasEditedInChunk) continue;

    const cleaned = cleanTranscriptArtifacts(res.refinedText ?? "");
    if (!cleaned) continue;

    const startMs = chunkMeta.startMs;
    const endMs = Math.max(startMs + 600, chunkMeta.endMs);
    const cues = splitTextIntoTimedCues(cleaned, startMs, endMs);
    const lang = res.detectedLanguage || fallbackLang;

    cues.forEach((cue, cueIdx) => {
      additions.push({
        id: `seg_chunk_lm_${res.windowIndex}_${cueIdx}_${Date.now()}`,
        text: cue.text,
        speakerId: "spk_1",
        languageCode: lang,
        timestampMs: cue.startMs,
        endTimestampMs: cue.endMs,
        chunkIndex: res.windowIndex,
        isProvisional: false,
        isRefined: true,
      });
    });
  }

  return [...keptSegments, ...additions].sort(
    (a, b) => a.timestampMs - b.timestampMs
  );
}
