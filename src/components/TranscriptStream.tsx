import { useEffect, useRef, useState } from "react";
import { Check, Copy, Edit3, FileAudio, Loader2, Mic } from "lucide-react";
import type {
  ConnectionState,
  LiveRefinementStatus,
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
  interimSpeaker: string;
  interimLanguage: string;
  connectionState: ConnectionState;
  liveRefinementStatus?: LiveRefinementStatus | null;
  searchQuery: string;
  hasAudioPlayer: boolean;
  playbackTimeMs: number;
  isAudioPlaying: boolean;
  chunkProgress: UploadedChunkProgress | null;
  onSeekAudioMs?: (ms: number) => void;
  onStartRecording: () => void;
  onOpenUploadModal: () => void;
  onUpdateSegmentText: (segmentId: string, newText: string) => void;
  onRenameSpeaker: (speakerId: string, newName: string) => void;
}

export function TranscriptStream({
  session,
  interimText,
  interimSpeaker,
  interimLanguage,
  connectionState,
  liveRefinementStatus,
  searchQuery,
  hasAudioPlayer,
  playbackTimeMs,
  isAudioPlaying,
  chunkProgress,
  onSeekAudioMs,
  onStartRecording,
  onOpenUploadModal,
  onUpdateSegmentText,
  onRenameSpeaker,
}: TranscriptStreamProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const activeSegRef = useRef<HTMLElement | null>(null);
  const [editingSegId, setEditingSegId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [editingSpeakerId, setEditingSpeakerId] = useState<string | null>(null);
  const [speakerDraft, setSpeakerDraft] = useState("");
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

  const commitSpeakerRename = (speakerId: string) => {
    const cleaned = speakerDraft.trim();
    if (cleaned) {
      onRenameSpeaker(speakerId, cleaned);
    }
    setEditingSpeakerId(null);
  };

  if (!hasContent) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <div className="mx-auto max-w-md">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-700 shadow-xs dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
            <Mic className="h-6 w-6" />
          </div>
          <h2 className="font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 [text-wrap:balance]">
            Ready for live transcription
          </h2>
          <p className="mt-2.5 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
            Speak into your microphone for low-latency streaming speech-to-text,
            or upload an audio file to divide it into 15-second segments with
            live YouTube-style captions.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={onStartRecording}
              className="flex h-10 items-center gap-2 rounded-lg bg-rose-600 px-5 text-sm font-medium text-white transition-colors hover:bg-rose-700 whitespace-nowrap shrink-0"
            >
              <Mic className="h-4 w-4" />
              <span>Start Recording</span>
            </button>
            <button
              type="button"
              onClick={onOpenUploadModal}
              className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <FileAudio className="h-4 w-4" />
              <span>Upload Audio</span>
            </button>
          </div>
          <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
            Press Space anytime to start or pause when not editing text
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
      <div className="mx-auto max-w-3xl space-y-4">
        {query && visibleSegments.length === 0 && (
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
            No transcript segments match &ldquo;{searchQuery}&rdquo;.
          </div>
        )}

        {visibleSegments.map((seg) => {
          const speakerDisplay = formatSpeakerDisplay(
            seg.speakerId,
            session.speakerNames
          );
          const isEditingThis = editingSegId === seg.id;
          const isEditingSpeaker = editingSpeakerId === seg.speakerId;
          const isActiveCue = activePlaybackSegId === seg.id;
          const showWords =
            expandedWordsId === seg.id && seg.words && seg.words.length > 0;

          return (
            <article
              key={seg.id}
              ref={isActiveCue ? activeSegRef : undefined}
              className={`group rounded-lg border-b border-slate-200/70 px-3 py-3 transition-colors last:border-b-0 dark:border-slate-800/80 ${
                isActiveCue
                  ? "bg-rose-50/80 dark:bg-rose-950/30"
                  : "hover:bg-slate-100/50 dark:hover:bg-slate-900/50"
              }`}
            >
              {/* Unboxed typographic metadata header */}
              <div className="mb-1 flex items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  {hasAudioPlayer && onSeekAudioMs ? (
                    <button
                      type="button"
                      onClick={() => onSeekAudioMs(seg.timestampMs)}
                      title="Jump to timestamp"
                      className={`font-mono tabular-nums transition-colors hover:underline ${
                        isActiveCue
                          ? "font-semibold text-rose-600 dark:text-rose-400"
                          : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
                      }`}
                    >
                      {formatTimestampLabel(seg.timestampMs)}
                    </button>
                  ) : (
                    <span className="font-mono tabular-nums text-slate-600 dark:text-slate-400">
                      {formatTimestampLabel(seg.timestampMs)}
                    </span>
                  )}

                  <span aria-hidden="true">·</span>

                  {isEditingSpeaker ? (
                    <input
                      type="text"
                      autoFocus
                      value={speakerDraft}
                      onChange={(e) => setSpeakerDraft(e.target.value)}
                      onBlur={() => commitSpeakerRename(seg.speakerId)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitSpeakerRename(seg.speakerId);
                        if (e.key === "Escape") setEditingSpeakerId(null);
                      }}
                      className="h-6 w-32 rounded border border-slate-300 bg-white px-1.5 text-xs font-medium text-slate-900 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingSpeakerId(seg.speakerId);
                        setSpeakerDraft(speakerDisplay);
                      }}
                      title="Click to rename speaker"
                      className="font-medium text-slate-800 underline-offset-2 hover:underline dark:text-slate-200"
                    >
                      {speakerDisplay}
                    </button>
                  )}

                  {seg.languageCode && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">{seg.languageCode}</span>
                    </>
                  )}
                  {seg.isEdited ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>Edited</span>
                    </>
                  ) : seg.isRefined ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-emerald-600 dark:text-emerald-400">
                        Refined
                      </span>
                    </>
                  ) : seg.isProvisional ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-slate-400 dark:text-slate-500">
                        Draft
                      </span>
                    </>
                  ) : null}
                </div>

                <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  {seg.words && seg.words.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedWordsId(showWords ? null : seg.id)
                      }
                      className="rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200 whitespace-nowrap shrink-0"
                    >
                      {showWords ? "Hide timings" : "Word timings"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setEditingSegId(seg.id);
                      setEditingText(seg.text);
                    }}
                    aria-label="Edit segment"
                    className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCopySegment(seg)}
                    aria-label="Copy segment"
                    className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                  >
                    {copiedSegId === seg.id ? (
                      <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
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
                    className="w-full rounded-lg border border-slate-300 bg-white p-2.5 text-[15px] leading-relaxed text-slate-900 focus:border-slate-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => commitSegmentEdit(seg.id)}
                      className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingSegId(null)}
                      className="rounded-md px-2.5 py-1 text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                    >
                      Cancel
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
                  className={`text-[15.5px] leading-[1.7] whitespace-pre-wrap ${
                    hasAudioPlayer ? "cursor-pointer" : ""
                  } ${
                    isActiveCue
                      ? "font-medium text-slate-950 dark:text-white"
                      : "text-slate-900 dark:text-slate-100"
                  }`}
                >
                  {highlightMatch(seg.text, query)}
                </p>
              )}

              {showWords && seg.words && (
                <div className="mt-2.5 flex flex-wrap gap-x-2 gap-y-1 border-t border-slate-100 pt-2 font-mono text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400 tabular-nums">
                  {seg.words.map((w, idx) => (
                    <span key={`${seg.id}-w-${idx}`}>
                      {w.word}{" "}
                      {w.startOffset ? (
                        <span className="text-slate-400 dark:text-slate-500">
                          [{w.startOffset}]
                        </span>
                      ) : null}
                    </span>
                  ))}
                </div>
              )}
            </article>
          );
        })}

        {/* Active streaming 15s chunk upload indicator */}
        {chunkProgress?.isProcessing &&
          (isAudioPlaying ||
            Boolean(chunkProgress.isBuffering) ||
            (Boolean(chunkProgress.isAudioEnded) && !chunkProgress.isPaused)) &&
          (chunkProgress.activeChunkIndices.length > 0 ||
            Boolean(chunkProgress.isBuffering)) && (
            <div className="flex items-center gap-2.5 px-3 py-3 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-rose-500" />
              <span>
                {chunkProgress.isBuffering
                  ? chunkProgress.preRollStage === "segmenting"
                    ? "Transcribing · Segmenting audio into 15-second clips..."
                    : chunkProgress.preRollStage === "connecting"
                      ? `Transcribing · Preparing ${chunkProgress.waveCount ?? 2} waves (${chunkProgress.readyWorkers ?? 0}/${chunkProgress.workerCount ?? 6} Live workers ready)...`
                      : (chunkProgress.waveCount ?? 1) > 1
                        ? `2 waves transcribing segments 1 & 2 (${chunkProgress.readyWorkers ?? 0}/${chunkProgress.workerCount ?? 6} workers focused) · Playback opens once segment 1 is ready...`
                        : `Transcribing first 15s segment (${chunkProgress.readyWorkers ?? 0}/${chunkProgress.workerCount ?? 3} workers focused) · Playback opens once ready...`
                  : `${
                      chunkProgress.activeChunkIndices.length > 1
                        ? `${chunkProgress.waveCount ?? 2} waves (${chunkProgress.workerCount ?? 6} workers)`
                        : "3 workers"
                    } focusing on 15s segment${
                      chunkProgress.activeChunkIndices.length > 1 ? "s" : ""
                    } ${chunkProgress.activeChunkIndices
                      .map((i) => i + 1)
                      .join(" & ")} of ${chunkProgress.totalChunks}...`}
              </span>
            </div>
          )}

        {/* Active streaming interim microphone transcription */}
        {(interimText.trim() || isListening) && (
          <div className="px-3 pt-1 pb-6">
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span
                className={`font-medium ${
                  liveRefinementStatus?.liveWorkerStatus === "dropped"
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-rose-600 dark:text-rose-400"
                }`}
              >
                {liveRefinementStatus?.liveWorkerStatus === "dropped"
                  ? "Live Dropped · 4 Backward Active"
                  : liveRefinementStatus?.liveWorkerStatus === "reconnecting"
                    ? "Live Reconnecting"
                    : "Live"}
              </span>
              {interimSpeaker && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    {formatSpeakerDisplay(interimSpeaker, session.speakerNames)}
                  </span>
                </>
              )}
              {interimLanguage && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{interimLanguage}</span>
                </>
              )}
              {liveRefinementStatus && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-slate-400 dark:text-slate-500">
                    10s window #{liveRefinementStatus.windowIndex + 1} (
                    {(liveRefinementStatus.bufferElapsedMs / 1000).toFixed(1)}s/
                    {(liveRefinementStatus.bufferDurationMs / 1000).toFixed(0)}s)
                  </span>
                </>
              )}
            </div>
            <p className="text-[15.5px] leading-[1.7] text-slate-500 dark:text-slate-400">
              {interimText.trim() ? (
                <>
                  <span>{interimText}</span>
                  <span className="ml-1 inline-block h-4 w-0.5 translate-y-0.5 bg-rose-500 align-baseline animate-pulse" />
                </>
              ) : (
                <span className="italic text-slate-400 dark:text-slate-500">
                  {liveRefinementStatus?.liveWorkerStatus === "dropped"
                    ? "Live stream disconnected — 4 backward workers still buffering and refining 10s speech..."
                    : "Listening for speech..."}
                </span>
              )}
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
        className="rounded-xs bg-amber-200/80 px-0.5 text-slate-900 dark:bg-amber-500/30 dark:text-amber-100"
      >
        {part}
      </mark>
    ) : (
      part
    )
  );
}
