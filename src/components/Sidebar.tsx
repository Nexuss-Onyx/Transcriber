import { useState, type FormEvent } from "react";
import { Plus, Trash2, X, SlidersHorizontal, FileAudio } from "lucide-react";
import {
  LANGUAGE_OPTIONS,
  type ConnectionState,
  type TranscriptionConfig,
  type TranscriptionMode,
  type TranscriptionSession,
} from "../types/transcribe";
import { countWords, formatDuration } from "../utils/audioCapture";

interface SidebarProps {
  sessions: TranscriptionSession[];
  activeSessionId: string;
  connectionState: ConnectionState;
  config: TranscriptionConfig;
  isOpenMobile: boolean;
  onCloseMobile: () => void;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
  onUpdateConfig: (partial: Partial<TranscriptionConfig>) => void;
  onOpenUploadModal: () => void;
}

export function Sidebar({
  sessions,
  activeSessionId,
  connectionState,
  config,
  isOpenMobile,
  onCloseMobile,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onUpdateConfig,
  onOpenUploadModal,
}: SidebarProps) {
  const [vocabInput, setVocabInput] = useState("");
  const isRecording =
    connectionState === "listening" ||
    connectionState === "connecting" ||
    connectionState === "paused";

  const handleAddVocab = (e: FormEvent) => {
    e.preventDefault();
    const term = vocabInput.trim();
    if (!term) return;
    if (!config.customVocabulary.includes(term)) {
      onUpdateConfig({
        customVocabulary: [...config.customVocabulary, term],
      });
    }
    setVocabInput("");
  };

  const handleRemoveVocab = (term: string) => {
    onUpdateConfig({
      customVocabulary: config.customVocabulary.filter((t) => t !== term),
    });
  };

  const handleModeChange = (mode: TranscriptionMode) => {
    if (isRecording) return;
    onUpdateConfig({ mode });
  };

  return (
    <>
      {isOpenMobile && (
        <div
          onClick={onCloseMobile}
          className="fixed inset-0 z-30 bg-slate-950/40 backdrop-blur-[1px] lg:hidden"
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[276px] shrink-0 flex-col border-r border-slate-200 bg-white transition-transform duration-200 dark:border-slate-800 dark:bg-slate-900 lg:static lg:translate-x-0 ${
          isOpenMobile ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Brand header */}
        <div className="flex h-14 items-center justify-between border-b border-slate-200 px-4 dark:border-slate-800">
          <span className="font-display text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0">
            Transcribe Live
          </span>
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Close sidebar"
            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100 lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Primary session actions */}
        <div className="flex flex-col gap-2 border-b border-slate-200 p-3 dark:border-slate-800">
          <button
            type="button"
            onClick={() => {
              onNewSession();
              onCloseMobile();
            }}
            disabled={isRecording}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200 whitespace-nowrap shrink-0"
          >
            <Plus className="h-4 w-4" />
            <span>New Session</span>
          </button>
          <button
            type="button"
            onClick={() => {
              onOpenUploadModal();
              onCloseMobile();
            }}
            disabled={isRecording}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <FileAudio className="h-3.5 w-3.5" />
            <span>Transcribe Audio File</span>
          </button>
        </div>

        {/* Sessions list */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <div className="mb-2 px-1 text-xs font-medium text-slate-500 dark:text-slate-400">
            Recent Sessions
          </div>
          <div className="space-y-1">
            {sessions.map((s) => {
              const isActive = s.id === activeSessionId;
              const words = s.segments.reduce(
                (acc, seg) => acc + countWords(seg.text),
                0
              );
              const dateLabel = new Date(s.updatedAt).toLocaleDateString(
                undefined,
                { month: "short", day: "numeric" }
              );
              return (
                <div
                  key={s.id}
                  className={`group flex items-center justify-between rounded-lg px-2.5 py-2 transition-colors ${
                    isActive
                      ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-100"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (!isRecording) {
                        onSelectSession(s.id);
                        onCloseMobile();
                      }
                    }}
                    disabled={isRecording && !isActive}
                    className="min-w-0 flex-1 text-left focus-visible:outline-none"
                  >
                    <div className="truncate text-sm font-medium">
                      {s.title || "Untitled Session"}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                      <span>{dateLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatDuration(s.durationMs)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{words} words</span>
                    </div>
                  </button>
                  {sessions.length > 1 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isRecording || !isActive) {
                          onDeleteSession(s.id);
                        }
                      }}
                      disabled={isRecording && isActive}
                      aria-label={`Delete ${s.title}`}
                      className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-400 opacity-0 transition-opacity hover:bg-slate-200 hover:text-rose-600 group-hover:opacity-100 disabled:pointer-events-none dark:hover:bg-slate-700 dark:hover:text-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Engine configuration */}
        <div className="border-t border-slate-200 p-3.5 dark:border-slate-800">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
              <SlidersHorizontal className="h-3.5 w-3.5 text-slate-500" />
              <span>Engine Settings</span>
            </div>
            {isRecording && (
              <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
                Locked while live
              </span>
            )}
          </div>

          <div className="space-y-3">
            {/* Mode segmented control */}
            <div>
              <div className="mb-1.5 text-xs text-slate-500 dark:text-slate-400">
                Transcription Mode
              </div>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
                <button
                  type="button"
                  disabled={isRecording}
                  onClick={() => handleModeChange("VERBATIM")}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    config.mode === "VERBATIM"
                      ? "bg-white text-slate-900 shadow-xs dark:bg-slate-700 dark:text-slate-100"
                      : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                  } disabled:cursor-not-allowed`}
                >
                  Verbatim
                </button>
                <button
                  type="button"
                  disabled={isRecording}
                  onClick={() => handleModeChange("SMART")}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    config.mode === "SMART"
                      ? "bg-white text-slate-900 shadow-xs dark:bg-slate-700 dark:text-slate-100"
                      : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                  } disabled:cursor-not-allowed`}
                >
                  Smart Clean
                </button>
              </div>
            </div>

            {/* Language hint */}
            <div>
              <label
                htmlFor="language-select"
                className="mb-1 block text-xs text-slate-500 dark:text-slate-400"
              >
                Language
              </label>
              <select
                id="language-select"
                disabled={isRecording}
                value={config.languageCode}
                onChange={(e) =>
                  onUpdateConfig({ languageCode: e.target.value })
                }
                className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-800 focus:border-slate-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                {LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.code} value={opt.code}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {config.mode === "SMART" && (
              <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                Smart Clean removes filler words and formats speech into clean prose.
              </p>
            )}

            {/* Custom Vocabulary */}
            <div>
              <div className="mb-1 text-xs text-slate-500 dark:text-slate-400">
                Custom vocabulary
              </div>
              <form onSubmit={handleAddVocab} className="flex gap-1.5">
                <input
                  type="text"
                  value={vocabInput}
                  disabled={isRecording}
                  onChange={(e) => setVocabInput(e.target.value)}
                  placeholder="Add term or name..."
                  className="h-8 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                />
                <button
                  type="submit"
                  disabled={isRecording || !vocabInput.trim()}
                  className="h-8 rounded-md border border-slate-200 bg-slate-50 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 whitespace-nowrap shrink-0"
                >
                  Add
                </button>
              </form>
              {config.customVocabulary.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-x-2.5 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
                  {config.customVocabulary.map((term) => (
                    <span
                      key={term}
                      className="inline-flex items-center gap-1 underline decoration-slate-300 underline-offset-2 dark:decoration-slate-600"
                    >
                      <span>{term}</span>
                      {!isRecording && (
                        <button
                          type="button"
                          onClick={() => handleRemoveVocab(term)}
                          aria-label={`Remove ${term}`}
                          className="text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
