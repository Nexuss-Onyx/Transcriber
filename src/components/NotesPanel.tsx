import { useState, type ChangeEvent } from "react";
import { Check, Copy, FileAudio, Loader2, Sparkles, X } from "lucide-react";
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
    if (!fullTranscript.trim()) {
      setError("Record or upload a transcript first before generating notes.");
      return;
    }
    setError(null);
    setIsLoading(true);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: fullTranscript, task }),
      });
      const data = (await res.json()) as { result?: string; error?: string };
      if (!res.ok) {
        throw new Error(data.error || "Failed to generate analysis.");
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
    <div className="flex flex-1 flex-col overflow-y-auto px-4 py-6 sm:px-8">
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4 dark:border-slate-800">
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
            {(
              [
                { id: "summary", label: "Summary" },
                { id: "actions", label: "Action Items" },
                { id: "polish", label: "Clean Prose" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTask(tab.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  activeTask === tab.id
                    ? "bg-white text-slate-900 shadow-xs dark:bg-slate-700 dark:text-slate-100"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            {currentContent && (
              <button
                type="button"
                onClick={handleCopy}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
            )}
            <button
              type="button"
              disabled={isLoading || !fullTranscript.trim()}
              onClick={() => handleGenerate(activeTask)}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 text-xs font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200 whitespace-nowrap shrink-0"
            >
              {isLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              <span>{currentContent ? "Regenerate" : "Generate"}</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/50 dark:text-rose-200">
            {error}
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3 py-8">
            <div className="h-4 w-3/4 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
            <div className="h-4 w-full animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
            <div className="h-4 w-5/6 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
          </div>
        ) : currentContent ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-[15px] leading-[1.7] text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 whitespace-pre-wrap">
            {currentContent}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 px-6 py-12 text-center dark:border-slate-700 dark:bg-slate-900/40">
            <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
              No {activeTask === "actions" ? "action items" : activeTask}{" "}
              generated yet
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {fullTranscript.trim()
                ? "Click Generate above to synthesize notes from your current transcript."
                : "Capture live speech or upload an audio file first."}
            </p>
          </div>
        )}
      </div>
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
      setError("File size must be under 100 MB.");
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-[2px]">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
            Transcribe Audio Live (15s Segments)
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close upload modal"
            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Splits your MP3, WAV, M4A, WEBM, or OGG file into 15-second segments
          and streams synchronized YouTube-style captions live during playback.
        </p>

        <label className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center transition-colors hover:border-slate-400 hover:bg-slate-100/70 dark:border-slate-700 dark:bg-slate-800/50 dark:hover:border-slate-600">
          <FileAudio className="mb-2 h-6 w-6 text-slate-500 dark:text-slate-400" />
          <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
            {selectedFile ? selectedFile.name : "Choose an audio file"}
          </span>
          {selectedFile && (
            <span className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB
            </span>
          )}
          <input
            type="file"
            accept="audio/*"
            onChange={handleFileChange}
            className="hidden"
          />
        </label>

        <label className="mt-3.5 flex cursor-pointer items-center justify-between text-xs text-slate-700 dark:text-slate-300">
          <span>Auto-play audio with live captions once first 15s is ready</span>
          <input
            type="checkbox"
            checked={autoPlay}
            onChange={(e) => setAutoPlay(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 accent-rose-600"
          />
        </label>

        {error && (
          <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/50 dark:text-rose-200">
            {error}
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-lg px-4 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selectedFile}
            onClick={handleSubmit}
            className="flex h-9 items-center gap-2 rounded-lg bg-rose-600 px-4 text-xs font-medium text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <span>Start Live Captions</span>
          </button>
        </div>
      </div>
    </div>
  );
}
