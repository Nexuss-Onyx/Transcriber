import { useState, type FormEvent } from "react";
import {
  AudioLines,
  AudioWaveform,
  FileAudio,
  Globe,
  Mic,
  Plus,
  Sparkles,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import {
  LANGUAGE_OPTIONS,
  type ConnectionState,
  type TranscriptionConfig,
  type TranscriptionMode,
  type TranscriptionSession,
} from "../types/transcribe";
import { formatDuration } from "../utils/audioCapture";

interface SidebarProps {
  sessions: TranscriptionSession[];
  activeSessionId: string;
  connectionState: ConnectionState;
  config: TranscriptionConfig;
  isOpen: boolean;
  audioDevices: MediaDeviceInfo[];
  selectedDeviceId: string;
  onSelectDevice: (deviceId: string) => void;
  onClose: () => void;
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
  isOpen,
  audioDevices,
  selectedDeviceId,
  onSelectDevice,
  onClose,
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
      {isOpen && (
        <div
          onClick={onClose}
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-xs transition-opacity"
        />
      )}
      <aside
        aria-hidden={!isOpen}
        className={`fixed inset-y-3 left-3 z-40 flex w-[236px] flex-col rounded-[24px] border border-slate-200/80 bg-white/90 text-slate-800 shadow-2xl backdrop-blur-2xl transition-transform duration-200 dark:border-white/12 dark:bg-[#081126]/92 dark:text-slate-100 ${
          isOpen
            ? "translate-x-0"
            : "-translate-x-[calc(100%+24px)] pointer-events-none"
        }`}
      >
        {/* Top icon-only action strip */}
        <div className="flex items-center justify-between border-b border-slate-200/70 px-3 py-3 dark:border-white/10">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                onNewSession();
                onClose();
              }}
              disabled={isRecording}
              aria-label="New session"
              title="New session"
              className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-300/80 bg-slate-900 text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/15 dark:bg-white/10 dark:hover:bg-white/20"
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                onOpenUploadModal();
                onClose();
              }}
              disabled={isRecording}
              aria-label="Upload audio"
              title="Upload audio"
              className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/15 dark:bg-white/[0.04] dark:text-slate-200 dark:hover:bg-white/15"
            >
              <FileAudio className="h-4 w-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            title="Close drawer"
            className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Sessions list (icon + numeric duration only) */}
        <div className="flex-1 overflow-y-auto px-2.5 py-2.5">
          <div className="space-y-1">
            {sessions.map((s) => {
              const isActive = s.id === activeSessionId;
              return (
                <div
                  key={s.id}
                  className={`group flex items-center justify-between rounded-2xl px-2.5 py-2 transition-colors ${
                    isActive
                      ? "bg-sky-500/12 text-sky-700 ring-1 ring-sky-500/30 dark:bg-sky-400/15 dark:text-sky-200 dark:ring-sky-400/25"
                      : "text-slate-600 hover:bg-slate-100/80 dark:text-slate-300 dark:hover:bg-white/[0.06]"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (!isRecording) {
                        onSelectSession(s.id);
                        onClose();
                      }
                    }}
                    disabled={isRecording && !isActive}
                    aria-label={`Select session ${s.id}`}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none"
                  >
                    <AudioLines className="h-4 w-4 shrink-0 opacity-75" />
                    <span className="font-mono text-xs tabular-nums opacity-85">
                      {formatDuration(s.durationMs)}
                    </span>
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
                      aria-label={`Delete session ${s.id}`}
                      title="Delete session"
                      className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 opacity-0 transition-opacity hover:bg-rose-500/15 hover:text-rose-500 group-hover:opacity-100 focus-visible:opacity-100 disabled:pointer-events-none"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Icon-driven engine controls */}
        <div className="space-y-2.5 border-t border-slate-200/70 p-3 dark:border-white/10">
          {/* Verbatim / Smart Clean icon switch */}
          <div className="grid grid-cols-2 gap-1 rounded-full border border-slate-200/80 bg-slate-100/80 p-1 dark:border-white/10 dark:bg-white/[0.04]">
            <button
              type="button"
              disabled={isRecording}
              onClick={() => handleModeChange("VERBATIM")}
              aria-label="Verbatim mode"
              title="Verbatim mode"
              className={`flex h-9 items-center justify-center rounded-full transition-colors ${
                config.mode === "VERBATIM"
                  ? "bg-white text-sky-600 shadow-xs dark:bg-sky-500/25 dark:text-sky-200"
                  : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white"
              } disabled:cursor-not-allowed`}
            >
              <AudioWaveform className="h-4 w-4" />
            </button>
            <button
              type="button"
              disabled={isRecording}
              onClick={() => handleModeChange("SMART")}
              aria-label="Smart clean mode"
              title="Smart clean mode"
              className={`flex h-9 items-center justify-center rounded-full transition-colors ${
                config.mode === "SMART"
                  ? "bg-white text-sky-600 shadow-xs dark:bg-sky-500/25 dark:text-sky-200"
                  : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white"
              } disabled:cursor-not-allowed`}
            >
              <Sparkles className="h-4 w-4" />
            </button>
          </div>

          {/* Language code selector (icon + compact ISO code) */}
          <div className="flex items-center gap-2 rounded-full border border-slate-200/80 bg-slate-100/70 px-3 dark:border-white/12 dark:bg-white/[0.04]">
            <Globe className="h-3.5 w-3.5 shrink-0 text-sky-500 dark:text-sky-300" />
            <select
              id="language-select"
              aria-label="Language"
              disabled={isRecording}
              value={config.languageCode}
              onChange={(e) =>
                onUpdateConfig({ languageCode: e.target.value })
              }
              className="h-9 w-full bg-transparent font-mono text-xs text-slate-800 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-100"
            >
              {LANGUAGE_OPTIONS.map((opt) => (
                <option
                  key={opt.code}
                  value={opt.code}
                  className="bg-white text-slate-900 dark:bg-[#081126] dark:text-slate-100"
                >
                  {opt.code.toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          {/* Mic device selector when available */}
          {audioDevices.length > 0 && (
            <div className="flex items-center gap-2 rounded-full border border-slate-200/80 bg-slate-100/70 px-3 dark:border-white/12 dark:bg-white/[0.04]">
              <Mic className="h-3.5 w-3.5 shrink-0 text-slate-500 dark:text-slate-300" />
              <select
                aria-label="Microphone input device"
                disabled={isRecording}
                value={selectedDeviceId}
                onChange={(e) => onSelectDevice(e.target.value)}
                className="h-9 w-full truncate bg-transparent font-mono text-xs text-slate-800 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-100"
              >
                <option
                  value=""
                  className="bg-white text-slate-900 dark:bg-[#081126] dark:text-slate-100"
                >
                  #0
                </option>
                {audioDevices.map((dev, i) => (
                  <option
                    key={dev.deviceId || i}
                    value={dev.deviceId}
                    className="bg-white text-slate-900 dark:bg-[#081126] dark:text-slate-100"
                  >
                    #{i + 1}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Custom vocabulary icon-only input */}
          <form onSubmit={handleAddVocab} className="flex items-center gap-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-slate-200/80 bg-slate-100/70 px-3 dark:border-white/12 dark:bg-white/[0.04]">
              <Tag className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <input
                type="text"
                aria-label="Custom vocabulary term"
                value={vocabInput}
                disabled={isRecording}
                onChange={(e) => setVocabInput(e.target.value)}
                className="h-9 min-w-0 flex-1 bg-transparent text-xs text-slate-800 focus:outline-none disabled:opacity-60 dark:text-slate-100"
              />
            </div>
            <button
              type="submit"
              aria-label="Add custom vocabulary term"
              title="Add custom vocabulary term"
              disabled={isRecording || !vocabInput.trim()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200/80 bg-slate-100/80 text-slate-700 hover:bg-slate-200 disabled:opacity-40 dark:border-white/12 dark:bg-white/[0.06] dark:text-slate-200 dark:hover:bg-white/15"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </form>

          {config.customVocabulary.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-0.5 text-xs text-slate-600 dark:text-slate-300">
              {config.customVocabulary.map((term) => (
                <span
                  key={term}
                  className="inline-flex items-center gap-1 rounded-full border border-slate-200/70 px-2 py-0.5 dark:border-white/15"
                >
                  <span className="max-w-[120px] truncate">{term}</span>
                  {!isRecording && (
                    <button
                      type="button"
                      onClick={() => handleRemoveVocab(term)}
                      aria-label={`Remove ${term}`}
                      className="text-slate-400 hover:text-rose-400"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
