import { useEffect, useState, type RefObject } from "react";
import {
  Captions,
  FileAudio,
  Gauge,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type {
  TranscriptSegment,
  UploadedChunkProgress,
} from "../types/transcribe";
import { formatDuration } from "../utils/audioCapture";

interface AudioPlayerStageProps {
  audioUrl: string;
  audioRef: RefObject<HTMLAudioElement | null>;
  fileName: string;
  segments: TranscriptSegment[];
  interimText?: string;
  currentTimeMs: number;
  durationMs: number;
  maxPlaybackMs?: number | null;
  isPlaying: boolean;
  chunkProgress: UploadedChunkProgress | null;
  onTimeUpdate: (ms: number) => void;
  onDurationChange: (ms: number) => void;
  onPlayStateChange: (playing: boolean, ended?: boolean) => void;
  onSeekToMs: (ms: number) => void;
  onStopAudio: () => void;
  onCloseAudio: () => void;
}

export function AudioPlayerStage({
  audioUrl,
  audioRef,
  fileName,
  segments,
  interimText = "",
  currentTimeMs,
  durationMs,
  maxPlaybackMs,
  isPlaying,
  chunkProgress,
  onTimeUpdate,
  onDurationChange,
  onPlayStateChange,
  onSeekToMs,
  onStopAudio,
  onCloseAudio,
}: AudioPlayerStageProps) {
  const [showCaptions, setShowCaptions] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = playbackRate;
  }, [playbackRate, audioRef]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = isMuted;
  }, [isMuted, audioRef]);

  const orderedSegments = [...segments].sort(
    (a, b) => a.timestampMs - b.timestampMs
  );

  const activeSegment = orderedSegments.find((seg, idx) => {
    const next = orderedSegments[idx + 1];
    const end =
      seg.endTimestampMs ?? (next ? next.timestampMs : durationMs || Infinity);
    return currentTimeMs >= seg.timestampMs && currentTimeMs < end;
  });

  const chunkDurationSec = chunkProgress?.chunkDurationSec ?? 15;
  const activeChunkIndex = Math.floor(currentTimeMs / (chunkDurationSec * 1000));
  const completedSet = new Set(chunkProgress?.completedChunkIndices ?? []);
  const activeSet = new Set(chunkProgress?.activeChunkIndices ?? []);
  const isCurrentChunkDone = completedSet.has(activeChunkIndex);
  const isStreamingThisChunk =
    Boolean(chunkProgress?.isProcessing) &&
    activeSet.has(activeChunkIndex);

  const showLiveInterimForCurrentChunk =
    interimText.trim().length > 0 && isStreamingThisChunk;

  const effectiveLimitMs =
    typeof maxPlaybackMs === "number" && maxPlaybackMs > 0
      ? Math.min(maxPlaybackMs, durationMs || maxPlaybackMs)
      : durationMs;

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (
        typeof maxPlaybackMs === "number" &&
        maxPlaybackMs > 0 &&
        audio.currentTime * 1000 >= maxPlaybackMs - 150
      ) {
        audio.currentTime = 0;
        onTimeUpdate(0);
      }
      void audio.play();
    } else {
      audio.pause();
    }
  };

  const skipBy = (deltaSec: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const rawLimit = effectiveLimitMs || audio.duration * 1000;
    const nextMs = Math.max(
      0,
      Math.min(rawLimit, (audio.currentTime + deltaSec) * 1000)
    );
    onSeekToMs(nextMs);
  };

  const cycleSpeed = () => {
    const speeds = [1, 1.25, 1.5, 2, 0.75];
    const idx = speeds.indexOf(playbackRate);
    setPlaybackRate(speeds[(idx + 1) % speeds.length]);
  };

  const safeDuration = Math.max(durationMs, 1);
  const progressPct = Math.min(
    100,
    Math.max(0, (currentTimeMs / safeDuration) * 100)
  );

  const isCompletingAfterEnd =
    Boolean(chunkProgress?.isAudioEnded) &&
    Boolean(chunkProgress?.isProcessing) &&
    !chunkProgress?.isPaused;

  const isBuffering = Boolean(chunkProgress?.isBuffering);

  return (
    <div className="shrink-0 border-b border-slate-200/70 bg-slate-100/70 px-4 py-3 backdrop-blur-xl dark:border-white/10 dark:bg-[#061028]/70 sm:px-6">
      <audio
        ref={audioRef}
        src={audioUrl}
        onTimeUpdate={(e) =>
          onTimeUpdate(Math.round(e.currentTarget.currentTime * 1000))
        }
        onLoadedMetadata={(e) => {
          if (Number.isFinite(e.currentTarget.duration)) {
            onDurationChange(Math.round(e.currentTarget.duration * 1000));
          }
        }}
        onPlay={() => onPlayStateChange(true, false)}
        onPause={(e) => onPlayStateChange(false, e.currentTarget.ended)}
        onEnded={() => onPlayStateChange(false, true)}
      />

      {/* Top minimal row: file icon + status loader + close icon */}
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-slate-500 dark:text-slate-300">
          <span title={fileName} aria-label={fileName}>
            <FileAudio className="h-4 w-4 text-sky-500 dark:text-sky-400" />
          </span>
          {(isPlaying || isCompletingAfterEnd || isBuffering) &&
            chunkProgress?.isProcessing && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
            )}
          <span className="font-mono text-[11px] tabular-nums opacity-75">
            {formatDuration(currentTimeMs)} / {formatDuration(durationMs)}
          </span>
        </div>

        <button
          type="button"
          onClick={onCloseAudio}
          aria-label="Detach audio player"
          title="Close audio player"
          className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-200/70 hover:text-slate-800 dark:hover:bg-white/10 dark:hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Live spoken captions stage (shows only real transcribed words or calm loader) */}
      {showCaptions &&
        (activeSegment ||
          showLiveInterimForCurrentChunk ||
          isBuffering ||
          (!isCurrentChunkDone && isPlaying) ||
          isCompletingAfterEnd) && (
          <div className="mb-2.5 flex min-h-[52px] items-center justify-center rounded-2xl border border-slate-200/70 bg-white/60 px-4 py-2 text-center dark:border-white/10 dark:bg-[#040a1a]/75">
            {activeSegment ? (
              <p className="text-[15px] font-medium leading-snug text-slate-900 dark:text-white">
                {activeSegment.text}
              </p>
            ) : showLiveInterimForCurrentChunk ? (
              <p className="text-[15px] font-medium leading-snug text-slate-700 dark:text-slate-200">
                {interimText.trim()}
              </p>
            ) : (
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
            )}
          </div>
        )}

      {/* Scrubber with 15s segment completion indicators */}
      <div className="mb-2.5">
        <div
          onClick={(e) => {
            if (isBuffering) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = Math.max(
              0,
              Math.min(1, (e.clientX - rect.left) / rect.width)
            );
            onSeekToMs(Math.round(ratio * safeDuration));
          }}
          className={`relative h-2 w-full overflow-hidden rounded-full bg-slate-300/70 dark:bg-white/10 ${
            isBuffering ? "cursor-not-allowed opacity-70" : "cursor-pointer"
          }`}
        >
          {chunkProgress &&
            chunkProgress.totalChunks > 0 &&
            chunkProgress.activeChunkIndices.map((idx) => {
              if (completedSet.has(idx)) return null;
              const startPct = (idx / chunkProgress.totalChunks) * 100;
              const widthPct = (1 / chunkProgress.totalChunks) * 100;
              return (
                <div
                  key={`active-${idx}`}
                  style={{ left: `${startPct}%`, width: `${widthPct}%` }}
                  className="absolute top-0 h-1 bg-sky-400/80 animate-pulse"
                />
              );
            })}

          {chunkProgress &&
            chunkProgress.totalChunks > 0 &&
            chunkProgress.completedChunkIndices.map((idx) => {
              const startPct = (idx / chunkProgress.totalChunks) * 100;
              const widthPct = (1 / chunkProgress.totalChunks) * 100;
              return (
                <div
                  key={idx}
                  style={{ left: `${startPct}%`, width: `${widthPct}%` }}
                  className="absolute top-0 h-1 bg-emerald-400/85"
                />
              );
            })}

          <div
            className="absolute bottom-0 left-0 h-1 bg-sky-400 transition-[width] duration-100"
            style={{ width: `${progressPct}%` }}
          />
          <div
            className="absolute inset-y-0 w-0.5 bg-white transition-[left] duration-100"
            style={{ left: `calc(${progressPct}% - 1px)` }}
          />
        </div>
      </div>

      {/* Icon-only audio transport row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={isBuffering}
            onClick={togglePlay}
            aria-label={isPlaying ? "Pause audio" : "Play audio"}
            title={isPlaying ? "Pause" : "Play"}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-500 text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {isPlaying ? (
              <Pause className="h-3.5 w-3.5 fill-current" />
            ) : (
              <Play className="h-3.5 w-3.5 translate-x-[0.5px] fill-current" />
            )}
          </button>
          <button
            type="button"
            disabled={isBuffering}
            onClick={onStopAudio}
            aria-label="Stop audio"
            title="Stop"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-300/70 text-slate-600 transition-colors hover:bg-slate-200/70 disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/15 dark:text-slate-200 dark:hover:bg-white/10"
          >
            <Square className="h-3 w-3 fill-current" />
          </button>
          <button
            type="button"
            disabled={isBuffering}
            onClick={() => skipBy(-5)}
            aria-label="Back 5 seconds"
            title="Back 5s"
            className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-45 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={isBuffering}
            onClick={() => skipBy(15)}
            aria-label="Forward 15 seconds"
            title="Forward 15s"
            className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-45 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setIsMuted((m) => !m)}
            aria-label={isMuted ? "Unmute" : "Mute"}
            title={isMuted ? "Unmute" : "Mute"}
            className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
          >
            {isMuted ? (
              <VolumeX className="h-3.5 w-3.5" />
            ) : (
              <Volume2 className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={cycleSpeed}
            aria-label={`Playback speed ${playbackRate}x`}
            title={`Speed (${playbackRate}x)`}
            className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <Gauge className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setShowCaptions((c) => !c)}
            aria-label="Toggle live captions"
            title="Toggle captions"
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
              showCaptions
                ? "bg-sky-500/20 text-sky-400"
                : "text-slate-400 hover:bg-slate-200/70 dark:hover:bg-white/10"
            }`}
          >
            <Captions className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
