import { useEffect, useState, type RefObject } from "react";
import {
  Captions,
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

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  };

  const skipBy = (deltaSec: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const nextMs = Math.max(
      0,
      Math.min(
        durationMs || audio.duration * 1000,
        (audio.currentTime + deltaSec) * 1000
      )
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
  const activeWorkerCount = chunkProgress?.activeChunkIndices.length ?? 0;
  const totalWorkers = chunkProgress?.workerCount ?? 5;
  const readyWorkers = chunkProgress?.readyWorkers ?? 0;
  const preRollStage = chunkProgress?.preRollStage ?? "transcribing";

  const statusText = !chunkProgress
    ? ""
    : isBuffering
      ? preRollStage === "segmenting"
        ? "Segmenting audio into 15s clips..."
        : preRollStage === "connecting"
          ? `Transcribing · Readying workers (${readyWorkers}/${totalWorkers})...`
          : `Transcribing first segment (${readyWorkers}/${totalWorkers} workers ready)`
      : chunkProgress.completedChunks >= chunkProgress.totalChunks &&
          chunkProgress.totalChunks > 0
        ? `${chunkProgress.completedChunks}/${chunkProgress.totalChunks} segments (15s) · Complete`
        : isPlaying
          ? `${chunkProgress.completedChunks}/${chunkProgress.totalChunks} segments (15s) · ${
              activeWorkerCount > 0
                ? `${activeWorkerCount} ${activeWorkerCount === 1 ? "worker" : "workers"} live`
                : "Live"
            }`
          : isCompletingAfterEnd
            ? `${chunkProgress.completedChunks}/${chunkProgress.totalChunks} segments (15s) · ${
                activeWorkerCount > 0
                  ? `${activeWorkerCount} ${activeWorkerCount === 1 ? "worker" : "workers"} finishing`
                  : "Completing..."
              }`
            : `${chunkProgress.completedChunks}/${chunkProgress.totalChunks} segments (15s) · Paused`;

  return (
    <div className="shrink-0 border-b border-slate-200 bg-slate-950 text-slate-100 dark:border-slate-800">
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

      <div className="mx-auto max-w-3xl px-4 py-3 sm:px-8">
        {/* Header strip */}
        <div className="mb-2.5 flex items-center justify-between gap-4 text-xs">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-slate-200">
              {fileName}
            </span>
            {chunkProgress && (
              <>
                <span aria-hidden="true" className="text-slate-600">
                  ·
                </span>
                <span className="flex items-center gap-1.5 text-slate-400 tabular-nums whitespace-nowrap shrink-0">
                  {(isPlaying || isCompletingAfterEnd || isBuffering) &&
                    chunkProgress.isProcessing && (
                      <Loader2 className="h-3 w-3 animate-spin text-rose-400" />
                    )}
                  <span>{statusText}</span>
                </span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={onCloseAudio}
            aria-label="Detach audio player"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* YouTube-style Live Caption Box */}
        {showCaptions && (
          <div className="mb-3 flex min-h-[68px] items-center justify-center rounded-lg border border-slate-800 bg-slate-900/90 px-5 py-3 text-center">
            {isBuffering && chunkProgress ? (
              <div className="flex items-center gap-2.5 text-xs text-slate-200">
                <Loader2 className="h-4 w-4 animate-spin text-rose-400" />
                <span>
                  {preRollStage === "segmenting"
                    ? "Transcribing · Segmenting audio into 15-second clips..."
                    : preRollStage === "connecting"
                      ? `Transcribing · Preparing ${totalWorkers} Live workers (${readyWorkers}/${totalWorkers} ready)...`
                      : `Transcribing first 15s segment (${readyWorkers}/${totalWorkers} workers active) · Audio will start automatically when ready...`}
                </span>
              </div>
            ) : activeSegment ? (
              <p className="max-w-2xl text-base font-medium leading-snug text-white sm:text-[17px]">
                <span className="rounded bg-black/75 px-2.5 py-1 box-decoration-clone">
                  {activeSegment.text}
                </span>
              </p>
            ) : showLiveInterimForCurrentChunk ? (
              <p className="max-w-2xl text-base font-medium leading-snug text-slate-200 sm:text-[17px]">
                <span className="rounded bg-black/65 px-2.5 py-1 box-decoration-clone">
                  {interimText.trim()}
                </span>
              </p>
            ) : !isCurrentChunkDone && isPlaying ? (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-rose-400" />
                <span>
                  Transcribing live ({formatDuration(activeChunkIndex * 15000)}{" "}
                  – {formatDuration((activeChunkIndex + 1) * 15000)})...
                </span>
              </div>
            ) : isCompletingAfterEnd && chunkProgress ? (
              <div className="flex items-center gap-2 text-xs text-slate-300">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" />
                <span>
                  Audio finished · Completing remaining 15s segments (
                  {chunkProgress.completedChunks}/{chunkProgress.totalChunks})...
                </span>
              </div>
            ) : !isPlaying && !isCurrentChunkDone ? (
              <p className="text-xs text-slate-400">
                Paused at {formatDuration(currentTimeMs)} · Press Play to
                continue audio and live transcription together
              </p>
            ) : (
              <p className="text-xs text-slate-500">
                No speech detected at {formatDuration(currentTimeMs)}
              </p>
            )}
          </div>
        )}

        {/* Scrubber with distinct 15-second completed segment blocks + playhead */}
        <div className="group relative mb-2.5">
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
            className={`relative h-2.5 w-full overflow-hidden rounded-full bg-slate-800 ${
              isBuffering ? "cursor-not-allowed opacity-75" : "cursor-pointer"
            }`}
          >
            {/* Active 15s chunk blocks currently being transcribed by live workers */}
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
                    className="absolute top-0 h-1.5 bg-amber-400/85 animate-pulse"
                  />
                );
              })}

            {/* Completed 15s chunk blocks (upper band, always visible even at 100% playhead) */}
            {chunkProgress &&
              chunkProgress.totalChunks > 0 &&
              chunkProgress.completedChunkIndices.map((idx) => {
                const startPct = (idx / chunkProgress.totalChunks) * 100;
                const widthPct = (1 / chunkProgress.totalChunks) * 100;
                return (
                  <div
                    key={idx}
                    style={{ left: `${startPct}%`, width: `${widthPct}%` }}
                    className="absolute top-0 h-1.5 bg-emerald-500/85"
                  />
                );
              })}

            {/* Active playhead bar (bottom track) */}
            <div
              className="absolute bottom-0 left-0 h-1 bg-rose-500 transition-[width] duration-100"
              style={{ width: `${progressPct}%` }}
            />

            {/* Crisp playhead cursor needle */}
            <div
              className="absolute inset-y-0 w-0.5 bg-white shadow-xs transition-[left] duration-100"
              style={{ left: `calc(${progressPct}% - 1px)` }}
            />

            {/* 15s segment tick dividers */}
            {chunkProgress &&
              chunkProgress.totalChunks > 1 &&
              Array.from({ length: chunkProgress.totalChunks - 1 }).map(
                (_, idx) => {
                  const tickPct = ((idx + 1) / chunkProgress.totalChunks) * 100;
                  return (
                    <div
                      key={idx}
                      style={{ left: `${tickPct}%` }}
                      className="absolute inset-y-0 w-px bg-slate-950/90"
                    />
                  );
                }
              )}
          </div>
        </div>

        {/* Transport Controls */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={isBuffering}
              onClick={togglePlay}
              aria-label={isPlaying ? "Pause audio and transcription" : "Play audio and transcription"}
              className="flex h-8 w-8 items-center justify-center rounded-md bg-white text-slate-950 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {isPlaying ? (
                <Pause className="h-4 w-4 fill-current" />
              ) : (
                <Play className="h-4 w-4 translate-x-[1px] fill-current" />
              )}
            </button>
            <button
              type="button"
              disabled={isBuffering}
              onClick={onStopAudio}
              aria-label="Stop audio and transcription"
              className="flex h-8 w-8 items-center justify-center rounded-md bg-slate-800 text-slate-200 transition-colors hover:bg-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
            <button
              type="button"
              disabled={isBuffering}
              onClick={() => skipBy(-5)}
              aria-label="Back 5 seconds"
              className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-slate-300 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>5s</span>
            </button>
            <button
              type="button"
              disabled={isBuffering}
              onClick={() => skipBy(15)}
              aria-label="Forward 15 seconds"
              className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-slate-300 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
            >
              <RotateCw className="h-3.5 w-3.5" />
              <span>15s</span>
            </button>
            <button
              type="button"
              onClick={() => setIsMuted((m) => !m)}
              aria-label={isMuted ? "Unmute" : "Mute"}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-300 hover:bg-slate-800 hover:text-white"
            >
              {isMuted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>
            <span className="ml-1 font-mono text-xs text-slate-400 tabular-nums">
              {formatDuration(currentTimeMs)} / {formatDuration(durationMs)}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={cycleSpeed}
              className="h-8 rounded-md px-2.5 font-mono text-xs text-slate-300 hover:bg-slate-800 hover:text-white tabular-nums whitespace-nowrap shrink-0"
            >
              {playbackRate}x
            </button>
            <button
              type="button"
              onClick={() => setShowCaptions((c) => !c)}
              aria-label="Toggle live captions"
              className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                showCaptions
                  ? "bg-slate-800 text-rose-400"
                  : "text-slate-400 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <Captions className="h-4 w-4" />
              <span>CC</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
