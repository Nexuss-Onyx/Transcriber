import { useState, type ChangeEvent } from "react";
import {
  AlignLeft,
  Check,
  Copy,
  FileAudio,
  ListChecks,
  Loader2,
  PlayCircle,
  Sparkles,
  UploadCloud,
  Wand2,
  X,
} from "lucide-react";
import type { SessionNotes, TranscriptionSession } from "../types/transcribe";

interface NotesPanelProps {
  session: TranscriptionSession;
  onSaveNotes: (notes: SessionNotes) => void;
}

export function NotesPanel({ session, onSaveNotes }: NotesPanelProps) {
  const [activeTask, setActiveTask] = useState<"summary" | "actions" | "polish">(
    "summary"
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fullTranscript = session.segments
    .map((s) => {
      const spk = session.speakerNames[s.speakerId] || s.speakerId;
      return `${spk}: ${s.text}`;
    })
    .join("\n\n");

  const currentContent = session.notes?.[activeTask] ?? "";

  const handleGenerate = async (task: "summary" | "actions" | "polish") => {
    setActiveTask(task);
    if (!fullTranscript.trim()) return;
    setError(null);
    setIsLoading(true);
    try {
      const data = await (await import("../utils/geminiDirect")).analyzeTranscript({
        transcript: fullTranscript,
        task,
      });
      if (data.error) {
        throw new Error(data.error);
      }
      onSaveNotes({
        ...session.notes,
        [task]: data.result ?? "",
        updatedAt: Date.now(),
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to analyze transcript."
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!currentContent) return;
    await navigator.clipboard.writeText(currentContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-5 py-5 sm:px-7">
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-slate-200/70 pb-3 dark:border-white/10">
        <div className="flex items-center gap-1 rounded-full border border-slate-200/80 bg-slate-100/80 p-1 dark:border-white/10 dark:bg-white/[0.04]">
          {(
            [
              { id: "summary", label: "Summary", Icon: AlignLeft },
              { id: "actions", label: "Action items", Icon: ListChecks },
              { id: "polish", label: "Clean prose", Icon: Wand2 },
            ] as const
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTask(id)}
              aria-label={label}
              title={label}
              className={`flex h-8 w-10 items-center justify-center rounded-full transition-colors ${
                activeTask === id
                  ? "bg-white text-sky-600 shadow-xs dark:bg-sky-500/25 dark:text-sky-200"
                  : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          {currentContent && (
            <button
              type="button"
              onClick={handleCopy}
              aria-label="Copy notes"
              title="Copy"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200/80 bg-white text-slate-600 transition-colors hover:bg-slate-100 dark:border-white/12 dark:bg-white/[0.05] dark:text-slate-200 dark:hover:bg-white/15"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          <button
            type="button"
            disabled={isLoading || !fullTranscript.trim()}
            onClick={() => handleGenerate(activeTask)}
            aria-label="Generate notes"
            title="Generate"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-b from-sky-400 to-blue-600 text-white shadow-md shadow-blue-600/30 transition-transform hover:scale-105 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-300">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3 py-6">
          <div className="h-3.5 w-3/4 animate-pulse rounded-full bg-slate-200 dark:bg-white/10" />
          <div className="h-3.5 w-full animate-pulse rounded-full bg-slate-200 dark:bg-white/10" />
          <div className="h-3.5 w-5/6 animate-pulse rounded-full bg-slate-200 dark:bg-white/10" />
        </div>
      ) : currentContent ? (
        <div className="text-[15.5px] leading-[1.72] text-slate-800 dark:text-slate-100/90 whitespace-pre-wrap">
          {currentContent}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-slate-300 dark:text-white/15">
          <Sparkles className="h-8 w-8" />
        </div>
      )}
    </div>
  );
}

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onStartLiveChunkedUpload: (file: File, autoPlay: boolean) => void;
}

export function UploadAudioModal({
  isOpen,
  onClose,
  onStartLiveChunkedUpload,
}: UploadModalProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [autoPlay, setAutoPlay] = useState(true);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) {
      setError("100 MB max");
      return;
    }
    setError(null);
    setSelectedFile(file);
  };

  const handleSubmit = () => {
    if (!selectedFile) return;
    const fileToProcess = selectedFile;
    setSelectedFile(null);
    setError(null);
    onClose();
    onStartLiveChunkedUpload(fileToProcess, autoPlay);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-md">
      <div className="w-full max-w-sm rounded-[28px] border border-slate-200/80 bg-white/95 p-6 shadow-2xl backdrop-blur-2xl dark:border-white/15 dark:bg-[#091532]/92">
        <div className="flex items-center justify-between">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-sky-500/15 text-sky-400">
            <FileAudio className="h-4 w-4" />
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close upload modal"
            title="Close"
            className="flex h-9 w-9 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mt-5 flex cursor-pointer flex-col items-center justify-center rounded-[22px] border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center transition-colors hover:border-sky-400/60 hover:bg-sky-500/5 dark:border-white/20 dark:bg-white/[0.03] dark:hover:border-sky-400/60 dark:hover:bg-sky-400/[0.06]">
          <UploadCloud className="h-8 w-8 text-sky-400" />
          {selectedFile && (
            <span className="mt-3 max-w-full truncate font-mono text-xs text-slate-700 dark:text-slate-200">
              {selectedFile.name}
            </span>
          )}
          <input
            type="file"
            accept="audio/*"
            onChange={handleFileChange}
            className="hidden"
          />
        </label>

        {error && (
          <div className="mt-3 text-center font-mono text-xs text-rose-400">
            {error}
          </div>
        )}

        <div className="mt-5 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setAutoPlay((a) => !a)}
            aria-label="Toggle auto-play"
            aria-pressed={autoPlay}
            title="Toggle auto-play"
            className={`flex h-10 w-10 items-center justify-center rounded-full border transition-colors ${
              autoPlay
                ? "border-sky-400/50 bg-sky-500/15 text-sky-400"
                : "border-slate-300/70 text-slate-400 dark:border-white/15"
            }`}
          >
            <PlayCircle className="h-4 w-4" />
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              aria-label="Cancel upload"
              title="Cancel"
              className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-300/70 text-slate-500 hover:bg-slate-100 dark:border-white/15 dark:text-slate-300 dark:hover:bg-white/10"
            >
              <X className="h-4 w-4" />
            </button>
            <button
              type="button"
              disabled={!selectedFile}
              onClick={handleSubmit}
              aria-label="Start transcribing audio"
              title="Start"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-b from-sky-400 to-blue-600 text-white shadow-lg shadow-blue-600/35 transition-transform hover:scale-105 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Check className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
