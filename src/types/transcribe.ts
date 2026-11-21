export type TranscriptionMode = "VERBATIM" | "SMART";

export interface WordTiming {
  word?: string;
  startOffset?: string;
  endOffset?: string;
  speakerLabel?: string;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  speakerId: string;
  languageCode?: string;
  timestampMs: number;
  endTimestampMs?: number;
  chunkIndex?: number;
  startOffset?: string;
  words?: WordTiming[];
  isEdited?: boolean;
}

export interface TranscriptionConfig {
  mode: TranscriptionMode;
  languageCode: string; // "auto" or BCP-47 code e.g. "en-US"
  diarization: boolean;
  wordTimestamp: boolean;
  customVocabulary: string[];
}

export interface SessionNotes {
  summary?: string;
  actions?: string;
  polish?: string;
  updatedAt?: number;
}

export interface UploadedChunkProgress {
  totalChunks: number;
  completedChunks: number;
  completedChunkIndices: number[];
  activeChunkIndices: number[];
  workerCount?: number;
  isBuffering?: boolean;
  chunkDurationSec: number;
  isProcessing: boolean;
  isPaused?: boolean;
  isAudioEnded?: boolean;
  error?: string | null;
}

export interface TranscriptionSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  durationMs: number;
  segments: TranscriptSegment[];
  speakerNames: Record<string, string>;
  detectedLanguages: string[];
  config: TranscriptionConfig;
  notes?: SessionNotes;
}

export type ConnectionState =
  | "idle"
  | "connecting"
  | "listening"
  | "paused"
  | "stopping"
  | "error";

export interface LanguageOption {
  code: string;
  label: string;
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { code: "auto", label: "Auto-detect language" },
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "am-ET", label: "Amharic" },
  { code: "es-ES", label: "Spanish" },
  { code: "fr-FR", label: "French" },
  { code: "de-DE", label: "German" },
  { code: "it-IT", label: "Italian" },
  { code: "pt-BR", label: "Portuguese (Brazil)" },
  { code: "ja-JP", label: "Japanese" },
  { code: "ko-KR", label: "Korean" },
  { code: "zh-CN", label: "Mandarin Chinese" },
  { code: "hi-IN", label: "Hindi" },
  { code: "ar-SA", label: "Arabic" },
];
