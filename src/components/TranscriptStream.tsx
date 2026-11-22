import { useEffect, useRef, useState } from "react";
import {
  Check,
  CheckCheck,
  CircleDot,
  Clock,
  Copy,
  Edit3,
  ListOrdered,
  Loader2,
  Pencil,
  SearchX,
  X,
} from "lucide-react";
import type {
  ConnectionState,
  TranscriptSegment,
  TranscriptionSession,
  UploadedChunkProgress,
} from "../types/transcribe";
import {
  formatSpeakerDisplay,
  formatTimestampLabel,
} from "../utils/audioCapture";

interface TranscriptStreamProps {
  session: TranscriptionSession;
  interimText: string;
  connectionState: ConnectionState;
  searchQuery: string;
  hasAudioPlayer: boolean;
  playbackTimeMs: number;
  isAudioPlaying: boolean;
  chunkProgress: UploadedChunkProgress | null;
  onSeekAudioMs?: (ms: number) => void;
  onUpdateSegmentText: (segmentId: string, newText: string) => void;
}

export function TranscriptStream({
  session,
  interimText,
  connectionState,
  searchQuery,
  hasAudioPlayer,
  playbackTimeMs,
  isAudioPlaying,
  chunkProgress,
  onSeekAudioMs,
  onUpdateSegmentText,
}: TranscriptStreamProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const activeSegRef = useRef<HTMLElement | null>(null);
  const [editingSegId, setEditingSegId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [copiedSegId, setCopiedSegId] = useState<string | null>(null);
  const [expandedWordsId, setExpandedWordsId] = useState<string | null>(null);

  const isListening = connectionState === "listening";

  const orderedSegments = [...session.segments].sort(
    (a, b) => a.timestampMs - b.timestampMs
  );

  const activePlaybackSegId = hasAudioPlayer
    ? orderedSegments.find((seg, idx) => {
        const next = orderedSegments[idx + 1];
        const end =
          seg.endTimestampMs ??
          (next ? next.timestampMs : session.durationMs || Infinity);
        return playbackTimeMs >= seg.timestampMs && playbackTimeMs < end;
      })?.id ?? null
    : null;

  useEffect(() => {
    if (isListening || interimText) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [session.segments.length, interimText, isListening]);

  useEffect(() => {
    if (isAudioPlaying && activePlaybackSegId && activeSegRef.current) {
      activeSegRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [activePlaybackSegId, isAudioPlaying]);

  const query = searchQuery.trim().toLowerCase();
  const visibleSegments = query
    ? orderedSegments.filter(
        (seg) =>
          seg.text.toLowerCase().includes(query) ||
          formatSpeakerDisplay(seg.speakerId, session.speakerNames)
            .toLowerCase()
            .includes(query)
      )
    : orderedSegments;

  const hasContent =
    session.segments.length > 0 ||
    interimText.trim().length > 0 ||
    Boolean(chunkProgress?.isProcessing);

  const handleCopySegment = async (seg: TranscriptSegment) => {
    try {
      await navigator.clipboard.writeText(seg.text);
      setCopiedSegId(seg.id);
      setTimeout(() => setCopiedSegId(null), 1500);
    } catch {
      // clipboard blocked
    }
  };

  const commitSegmentEdit = (segId: string) => {
    const cleaned = editingText.trim();
    if (cleaned) {
      onUpdateSegmentText(segId, cleaned);
    }
    setEditingSegId(null);
  };

  if (!hasContent) {
    return <div className="flex-1" aria-hidden="true" />;
  }

  return (
    <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-7">
      <div className="space-y-3.5">
        {query && visibleSegments.length === 0 && (
          <div className="flex justify-center py-8 text-slate-400 dark:text-slate-500">
            <SearchX className="h-5 w-5" />
          </div>
        )}

        {visibleSegments.map((seg, idx) => {
          const isEditingThis = editingSegId === seg.id;
          const isActiveCue = activePlaybackSegId === seg.id;
          const isLatestSeg = idx === visibleSegments.length - 1 && !interimText.trim();
          const showWords =
            expandedWordsId === seg.id && seg.words && seg.words.length > 0;

          return (
            <article
              key={seg.id}
              ref={isActiveCue ? activeSegRef : undefined}
              className={`group relative rounded-2xl px-3.5 py-2.5 transition-colors ${
                isActiveCue
                  ? "bg-sky-500/12 ring-1 ring-sky-400/25 dark:bg-sky-400/12"
                  : "hover:bg-slate-900/[0.03] dark:hover:bg-white/[0.04]"
              }`}
            >
              {/* Subtle icon-only metadata & hover actions */}
              <div className="mb-1 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-[11px] text-slate-400 dark:text-slate-400/75">
                  {hasAudioPlayer && onSeekAudioMs ? (
                    <button
                      type="button"
                      onClick={() => onSeekAudioMs(seg.timestampMs)}
                      aria-label={`Jump to ${formatTimestampLabel(seg.timestampMs)}`}
                      title={formatTimestampLabel(seg.timestampMs)}
                      className="flex items-center gap-1 font-mono tabular-nums transition-colors hover:text-sky-400"
                    >
                      <Clock className="h-3 w-3" />
                      <span>{formatTimestampLabel(seg.timestampMs)}</span>
                    </button>
                  ) : (
                    <span className="font-mono tabular-nums opacity-70">
                      {formatTimestampLabel(seg.timestampMs)}
                    </span>
                  )}

                  {seg.isEdited ? (
                    <span title="Edited" aria-label="Edited">
                      <Pencil className="h-3 w-3 text-slate-400" />
                    </span>
                  ) : seg.isRefined ? (
                    <span title="Refined" aria-label="Refined">
                      <CheckCheck className="h-3.5 w-3.5 text-emerald-400" />
                    </span>
                  ) : seg.isProvisional ? (
                    <span title="Live draft" aria-label="Live draft">
                      <CircleDot className="h-3 w-3 text-sky-400/80" />
                    </span>
                  ) : null}
                </div>

                <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  {seg.words && seg.words.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedWordsId(showWords ? null : seg.id)
                      }
                      aria-label="Toggle word timings"
                      title="Word timings"
                      className="flex h-7 w-7 items-center justify-center rounded-full text-slate-400 hover:bg-slate-200/70 hover:text-slate-800 dark:hover:bg-white/10 dark:hover:text-white"
                    >
                      <ListOrdered className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setEditingSegId(seg.id);
                      setEditingText(seg.text);
                    }}
                    aria-label="Edit segment"
                    title="Edit"
                    className="flex h-7 w-7 items-center justify-center rounded-full text-slate-400 hover:bg-slate-200/70 hover:text-slate-800 dark:hover:bg-white/10 dark:hover:text-white"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCopySegment(seg)}
                    aria-label="Copy segment"
                    title="Copy"
                    className="flex h-7 w-7 items-center justify-center rounded-full text-slate-400 hover:bg-slate-200/70 hover:text-slate-800 dark:hover:bg-white/10 dark:hover:text-white"
                  >
                    {copiedSegId === seg.id ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>

              {isEditingThis ? (
                <div className="mt-1 space-y-2">
                  <textarea
                    autoFocus
                    rows={3}
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        commitSegmentEdit(seg.id);
                      }
                      if (e.key === "Escape") setEditingSegId(null);
                    }}
                    className="w-full rounded-xl border border-slate-300 bg-white/90 p-2.5 text-[16px] leading-relaxed text-slate-900 focus:border-sky-400 focus:outline-none dark:border-white/15 dark:bg-[#060d20]/90 dark:text-white"
                  />
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => commitSegmentEdit(seg.id)}
                      aria-label="Save edit"
                      title="Save"
                      className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-500 text-white hover:bg-sky-400"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingSegId(null)}
                      aria-label="Cancel edit"
                      title="Cancel"
                      className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-white/10 hover:text-white"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ) : (
                <p
                  onClick={() => {
                    if (hasAudioPlayer && onSeekAudioMs) {
                      onSeekAudioMs(seg.timestampMs);
                    }
                  }}
                  className={`text-[17px] leading-[1.68] whitespace-pre-wrap transition-colors ${
                    hasAudioPlayer ? "cursor-pointer" : ""
                  } ${
                    isActiveCue || isLatestSeg
                      ? "font-medium text-slate-950 dark:text-white"
                      : "font-normal text-slate-700 dark:text-slate-200/80"
                  }`}
                >
                  {highlightMatch(seg.text, query)}
                </p>
              )}

              {showWords && seg.words && (
                <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 border-t border-slate-200/70 pt-2 font-mono text-[11px] text-slate-500 dark:border-white/10 dark:text-slate-400 tabular-nums">
                  {seg.words.map((w, wIdx) => (
                    <span key={`${seg.id}-w-${wIdx}`}>
                      {w.word}{" "}
                      {w.startOffset ? (
                        <span className="opacity-65">[{w.startOffset}]</span>
                      ) : null}
                    </span>
                  ))}
                </div>
              )}
            </article>
          );
        })}

        {/* Minimal icon-only loader while 2-wave upload segments are actively transcribing */}
        {chunkProgress?.isProcessing &&
          (isAudioPlaying ||
            Boolean(chunkProgress.isBuffering) ||
            (Boolean(chunkProgress.isAudioEnded) && !chunkProgress.isPaused)) &&
          (chunkProgress.activeChunkIndices.length > 0 ||
            Boolean(chunkProgress.isBuffering)) && (
            <div className="flex items-center px-3.5 py-2 text-sky-400">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}

        {/* Active streaming interim microphone transcription */}
        {interimText.trim() && (
          <div className="px-3.5 pt-1 pb-3">
            <p className="text-[17px] font-medium leading-[1.68] text-slate-900 dark:text-white">
              <span>{interimText}</span>
              <span className="ml-1 inline-block h-4 w-0.5 translate-y-0.5 bg-sky-400 align-baseline animate-pulse" />
            </p>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function highlightMatch(text: string, query: string) {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, idx) =>
    part.toLowerCase() === query ? (
      <mark
        key={idx}
        className="rounded-xs bg-sky-400/30 px-0.5 text-slate-950 dark:text-white"
      >
        {part}
      </mark>
    ) : (
      part
    )
  );
}
