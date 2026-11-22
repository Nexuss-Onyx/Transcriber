import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AudioLines,
  AudioWaveform,
  Check,
  Copy,
  Download,
  FileAudio,
  FileCode,
  FileJson,
  FileText,
  Loader2,
  Mic,
  Moon,
  PanelLeft,
  Pause,
  Play,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Square,
  Subtitles,
  Sun,
  X,
} from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { TranscriptStream } from "./components/TranscriptStream";
import { NotesPanel, UploadAudioModal } from "./components/NotesPanel";
import { WaveformVisualizer } from "./components/WaveformVisualizer";
import { AudioPlayerStage } from "./components/AudioPlayerStage";
import {
  type ConnectionState,
  type LiveRefinementStatus,
  type SessionNotes,
  type TranscriptSegment,
  type TranscriptionConfig,
  type TranscriptionSession,
  type UploadedChunkProgress,
  type WordTiming,
} from "./types/transcribe";
import {
  AUDIO_WORKLET_SOURCE,
  bcp47ToScriptFamily,
  buildExportContent,
  cleanTranscriptArtifacts,
  createStreamingSpeechConditioner,
  detectScriptFamily,
  downsampleBuffer,
  float32ToBase64Pcm16,
  formatDuration,
  hasMixedLatinWithNonLatin,
  reconcileFocusedTranscripts,
  scriptFamilyToBcp47,
  sliceAudioFileIntoLiveChunks,
  splitTextIntoTimedCues,
  stitchChunkBoundary,
} from "./utils/audioCapture";
import {
  WORKERS_PER_WAVE,
  getWaveCount,
  pickNextWaveSegment,
  shouldInterruptWaveOnSeek,
} from "./utils/waveScheduler";
import {
  LIVE_SAMPLE_RATE,
  LIVE_WINDOW_SAMPLES,
  LIVE_WINDOW_SECONDS,
  type LiveHalfSlice,
  type SlicedLiveWindow,
  appendAndExtractLiveWindows,
  concatFloat32Arrays,
  mergeWindowRefinedSegments,
  sliceLiveWindowIntoHalves,
} from "./utils/liveRefiner";
import {
  LIVE_LM_INTERVAL_MS,
  type StructuredWorkerWindow,
  applyLmRefinedChunksToSegments,
  applyLmRefinedWindowsToSegments,
  buildPriorContextSnippet,
  collectDueRefinementWindows,
  upsertBackwardWorkerObservations,
  upsertLiveHqWorkerObservation,
  upsertLiveWorkerObservation,
  upsertUploadWorkerObservations,
} from "./utils/structuredRefine";

const STORAGE_KEY = "transcribe_live_sessions_v1";
const THEME_KEY = "transcribe_live_theme_v1";

function isFatalConfigErrorMessage(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("api_key_invalid") ||
    lower.includes("invalid gemini_api_key") ||
    lower.includes("permission denied") ||
    lower.includes("not configured")
  );
}

function createDefaultConfig(): TranscriptionConfig {
  return {
    mode: "VERBATIM",
    languageCode: "am-ET",
    diarization: false,
    wordTimestamp: false,
    customVocabulary: [],
  };
}

function createEmptySession(config?: TranscriptionConfig): TranscriptionSession {
  const now = Date.now();
  return {
    id: `sess_${now}_${Math.random().toString(36).slice(2, 7)}`,
    title: `Session ${new Date(now).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    })} ${new Date(now).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    })}`,
    createdAt: now,
    updatedAt: now,
    durationMs: 0,
    segments: [],
    speakerNames: {},
    detectedLanguages: [],
    config: config ? { ...config } : createDefaultConfig(),
  };
}

function loadInitialSessions(): TranscriptionSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as TranscriptionSession[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {
    // ignore storage errors
  }
  return [createEmptySession()];
}

interface ActiveUploadedAudio {
  sessionId: string;
  url: string;
  fileName: string;
  durationMs: number;
}

export default function App() {
  const [sessions, setSessions] = useState<TranscriptionSession[]>(
    loadInitialSessions
  );
  const [activeSessionId, setActiveSessionId] = useState<string>(
    () => loadInitialSessions()[0].id
  );
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [interimText, setInterimText] = useState("");
  const [interimSpeaker, setInterimSpeaker] = useState("");
  const [interimLanguage, setInterimLanguage] = useState("");
  const [liveDurationMs, setLiveDurationMs] = useState(0);

  const [activeTab, setActiveTab] = useState<"transcript" | "notes">(
    "transcript"
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);

  // Uploaded audio & 15s live YouTube-style player state
  const [uploadedAudio, setUploadedAudio] = useState<ActiveUploadedAudio | null>(
    null
  );
  const [chunkProgress, setChunkProgress] =
    useState<UploadedChunkProgress | null>(null);
  const [playbackTimeMs, setPlaybackTimeMs] = useState(0);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const isAudioPlayingRef = useRef(false);
  const audioPlaybackEndedRef = useRef(false);
  const isPreBufferingRef = useRef(false);
  const uploadSeekSeqRef = useRef(0);

  useEffect(() => {
    isAudioPlayingRef.current = isAudioPlaying;
  }, [isAudioPlaying]);

  const [isDark, setIsDark] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "light") return false;
      return true;
    } catch {
      return true;
    }
  });

  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);

  // Refs for audio/WebSocket lifecycle without stale closures
  const wsRef = useRef<WebSocket | null>(null);
  const wsHqRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null);
  const workletUrlRef = useRef<string | null>(null);
  const isPausedRef = useRef(false);
  const activeSessionIdRef = useRef(activeSessionId);
  const liveTimerRef = useRef<number | null>(null);
  const runStartRef = useRef<number>(0);
  const accumulatedMsRef = useRef<number>(0);
  const lastSegmentTimeRef = useRef<number>(0);

  // Live 1 + 4 backward refinement worker state & pipeline refs
  const [liveRefinementStatus, setLiveRefinementStatus] =
    useState<LiveRefinementStatus | null>(null);
  const liveRefineAbortRef = useRef<AbortController | null>(null);
  const liveSessionRunRef = useRef(0);
  const liveRecordingActiveRef = useRef(false);
  const livePipelineRef = useRef<{
    runId: number;
    chunks: Float32Array[];
    count: number;
    windowIndex: number;
    totalRecordedSamples: number;
    recordingStartOffsetMs: number;
    prevTailSamples: Float32Array | null;
    refiningWindowsCount: number;
    refinedWindowsCount: number;
    liveWorkerStatus: "connecting" | "connected" | "reconnecting" | "dropped";
    lastUiSyncAt: number;
    rawHalfTexts: Record<number, string>;
    lockedAutoLang: string | null;
    lockedScriptFamily: string | null;
    targetSessionId: string;
    configSnapshot: TranscriptionConfig;
    reconnectTimer: number | null;
    reconnectAttempts: number;
    isStopping: boolean;
    structuredWindows: Map<number, StructuredWorkerWindow>;
    inFlightBackwardPromises: Set<Promise<void>>;
    lmIntervalTimer: number | null;
    lmActivePromise: Promise<void> | null;
  }>({
    runId: 0,
    chunks: [],
    count: 0,
    windowIndex: 0,
    totalRecordedSamples: 0,
    recordingStartOffsetMs: 0,
    prevTailSamples: null,
    refiningWindowsCount: 0,
    refinedWindowsCount: 0,
    liveWorkerStatus: "connecting",
    lastUiSyncAt: 0,
    rawHalfTexts: {},
    lockedAutoLang: null,
    lockedScriptFamily: null,
    targetSessionId: "",
    configSnapshot: createDefaultConfig(),
    reconnectTimer: null,
    reconnectAttempts: 0,
    isStopping: false,
    structuredWindows: new Map(),
    inFlightBackwardPromises: new Set(),
    lmIntervalTimer: null,
    lmActivePromise: null,
  });

  const sessionsRef = useRef<TranscriptionSession[]>(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    try {
      localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
    } catch {
      // ignore
    }
  }, [isDark]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    } catch {
      // ignore quota errors
    }
  }, [sessions]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? sessions[0],
    [sessions, activeSessionId]
  );

  useEffect(() => {
    if (!sessions.some((s) => s.id === activeSessionId) && sessions[0]) {
      setActiveSessionId(sessions[0].id);
    }
  }, [sessions, activeSessionId]);

  const refreshAudioDevices = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === "audioinput");
      setAudioDevices(inputs);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refreshAudioDevices();
  }, [refreshAudioDevices]);

  const updateSessionById = useCallback(
    (
      id: string,
      updater: (prev: TranscriptionSession) => TranscriptionSession
    ) => {
      setSessions((prevList) =>
        prevList.map((s) => (s.id === id ? updater(s) : s))
      );
    },
    []
  );

  const syncLiveRefinementUI = useCallback((force = false) => {
    const lp = livePipelineRef.current;
    if (lp.runId !== liveSessionRunRef.current) return;
    if (!liveRecordingActiveRef.current && lp.refiningWindowsCount === 0) {
      setLiveRefinementStatus(null);
      return;
    }
    const now = Date.now();
    if (!force && now - lp.lastUiSyncAt < 180) return;
    lp.lastUiSyncAt = now;
    setLiveRefinementStatus({
      windowIndex: lp.windowIndex,
      bufferElapsedMs: Math.round((lp.count / LIVE_SAMPLE_RATE) * 1000),
      bufferDurationMs: LIVE_WINDOW_SECONDS * 1000,
      refiningWindowsCount: lp.refiningWindowsCount,
      refinedWindowsCount: lp.refinedWindowsCount,
      liveWorkerStatus: lp.liveWorkerStatus,
    });
  }, []);

  const runLmRefinementPass = useCallback(
    async (
      runId: number,
      targetSessionId: string,
      signal: AbortSignal,
      forceFlush = false
    ) => {
      const lp = livePipelineRef.current;
      if (lp.runId !== runId || signal.aborted) return;

      if (lp.lmActivePromise) {
        if (!forceFlush) return;
        await lp.lmActivePromise.catch(() => {});
        if (lp.runId !== runId || signal.aborted) return;
      }

      const executePass = async () => {
        const due = collectDueRefinementWindows(lp.structuredWindows);
        if (due.length === 0) return;

        const targetSess = sessionsRef.current.find(
          (s) => s.id === targetSessionId
        );
        const priorContext = buildPriorContextSnippet(
          targetSess?.segments ?? [],
          due[0].windowIndex,
          600
        );

        try {
          const res = await fetch("/api/refine-transcript", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              windows: due,
              priorContext,
              languageCode: lp.configSnapshot.languageCode,
              customVocabulary: lp.configSnapshot.customVocabulary,
              scope: "live_6w",
            }),
            signal,
          });
          if (!res.ok) return;

          const data = (await res.json()) as {
            refinedWindows?: Array<{
              windowIndex: number;
              refinedText: string;
              detectedLanguage?: string;
            }>;
          };

          if (
            signal.aborted ||
            lp.runId !== runId ||
            !Array.isArray(data.refinedWindows) ||
            data.refinedWindows.length === 0
          ) {
            return;
          }

          for (const item of data.refinedWindows) {
            const winEntry = lp.structuredWindows.get(item.windowIndex);
            if (winEntry) {
              winEntry.lmRefined = true;
            }
          }

          const fallbackLang =
            lp.lockedAutoLang ??
            (lp.configSnapshot.languageCode === "auto"
              ? undefined
              : lp.configSnapshot.languageCode);

          const detectedFromLm = data.refinedWindows
            .map((w) => w.detectedLanguage)
            .filter((l): l is string => Boolean(l));

          updateSessionById(targetSessionId, (s) => {
            let mergedLangs = s.detectedLanguages;
            for (const nl of detectedFromLm) {
              if (!mergedLangs.includes(nl)) {
                mergedLangs = [...mergedLangs, nl];
              }
            }
            return {
              ...s,
              segments: applyLmRefinedWindowsToSegments(
                s.segments,
                lp.structuredWindows,
                data.refinedWindows!,
                fallbackLang
              ),
              detectedLanguages: mergedLangs,
              updatedAt: Date.now(),
            };
          });
        } catch {
          // Stay silent under the hood; keep windows queued for next minute pass
        }
      };

      const task = executePass().finally(() => {
        if (lp.lmActivePromise === task) {
          lp.lmActivePromise = null;
        }
      });
      lp.lmActivePromise = task;
      await task;
    },
    [updateSessionById]
  );

  const refineLiveWindow = useCallback(
    async (
      sliced: SlicedLiveWindow,
      runId: number,
      targetSessionId: string,
      configSnapshot: TranscriptionConfig,
      signal: AbortSignal
    ) => {
      const lp = livePipelineRef.current;
      if (lp.runId === runId) {
        lp.refiningWindowsCount += 1;
        syncLiveRefinementUI(true);
      }

      try {
        if (signal.aborted) return;

        if (!sliced.hasAudioSignal) {
          if (lp.runId === runId) {
            upsertBackwardWorkerObservations(
              lp.structuredWindows,
              sliced.windowIndex,
              sliced.windowStartMs,
              sliced.windowEndMs,
              {}
            );
          }
          return;
        }

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsEndpoint = `${protocol}//${window.location.host}/ws/transcribe`;

        const runBackwardSinglePass = async (
          half: LiveHalfSlice,
          useRaw: boolean,
          mode: "VERBATIM" | "SMART",
          intervalMs: number,
          langHint: string | null,
          prevSourceText?: string
        ): Promise<{
          text: string;
          lang?: string;
          isSmart: boolean;
          fatalError?: string;
        }> => {
          const packets = useRaw
            ? half.rawPacketsBase64
            : half.pcmPacketsBase64;
          if (!half.hasAudioSignal || packets.length === 0 || signal.aborted) {
            return { text: "", isSmart: mode === "SMART" };
          }

          const executeAttempt = (hint: string | null) =>
            new Promise<{
              text: string;
              lang?: string;
              isSmart: boolean;
              passError?: string;
              fatalError?: string;
            }>((resolve) => {
              const ws = new WebSocket(wsEndpoint);
              const finalParts: string[] = [];
              let latestInterim = "";
              let detectedLang: string | undefined;
              let settled = false;
              let passError: string | undefined;
              let idleTimer: number | null = null;
              let maxTimer: number | null = null;

              const cleanup = () => {
                if (idleTimer !== null) window.clearTimeout(idleTimer);
                if (maxTimer !== null) window.clearTimeout(maxTimer);
                signal.removeEventListener("abort", onAbort);
                try {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "stop" }));
                  }
                } catch {
                  // ignore
                }
                setTimeout(() => {
                  try {
                    ws.close();
                  } catch {
                    // ignore
                  }
                }, 120);
              };

              const finish = () => {
                if (settled) return;
                settled = true;
                cleanup();
                const cleaned = cleanTranscriptArtifacts(
                  finalParts.length > 0 ? finalParts.join(" ") : latestInterim
                );
                resolve({
                  text: cleaned,
                  lang: detectedLang,
                  isSmart: mode === "SMART",
                  passError,
                  fatalError:
                    passError && isFatalConfigErrorMessage(passError)
                      ? passError
                      : undefined,
                });
              };

              const resetIdle = (ms = 2500) => {
                if (idleTimer !== null) window.clearTimeout(idleTimer);
                idleTimer = window.setTimeout(finish, ms);
              };

              const onAbort = () => finish();
              signal.addEventListener("abort", onAbort, { once: true });

              ws.onopen = () => {
                ws.send(
                  JSON.stringify({
                    type: "start",
                    mode,
                    languageCodes: hint ? [hint] : [],
                    customVocabulary: configSnapshot.customVocabulary,
                    ...(mode === "SMART" && prevSourceText
                      ? { sourceText: prevSourceText }
                      : {}),
                  })
                );
              };

              ws.onmessage = async (event) => {
                let msg: {
                  type: string;
                  text?: string;
                  languageCode?: string;
                  message?: string;
                };
                try {
                  msg = JSON.parse(String(event.data));
                } catch {
                  return;
                }

                if (msg.type === "ready") {
                  maxTimer = window.setTimeout(
                    finish,
                    packets.length * intervalMs + 9000
                  );
                  for (let p = 0; p < packets.length; p++) {
                    if (
                      settled ||
                      signal.aborted ||
                      ws.readyState !== WebSocket.OPEN
                    ) {
                      break;
                    }
                    ws.send(
                      JSON.stringify({ type: "audio", data: packets[p] })
                    );
                    await new Promise((r) => setTimeout(r, intervalMs));
                  }
                  if (
                    !settled &&
                    !signal.aborted &&
                    ws.readyState === WebSocket.OPEN
                  ) {
                    ws.send(JSON.stringify({ type: "audioStreamEnd" }));
                    resetIdle(2500);
                  } else {
                    finish();
                  }
                  return;
                }

                if (msg.type === "interim") {
                  if (msg.text) latestInterim = msg.text;
                  resetIdle(2500);
                  return;
                }

                if (msg.type === "transcript") {
                  const t = (msg.text ?? "").trim();
                  if (t) {
                    finalParts.push(t);
                    latestInterim = "";
                  }
                  if (msg.languageCode) detectedLang = msg.languageCode;
                  resetIdle(2500);
                  return;
                }

                if (msg.type === "turnComplete" || msg.type === "closed") {
                  finish();
                  return;
                }

                if (msg.type === "error") {
                  passError = msg.message || "Backward worker error.";
                  finish();
                }
              };

              ws.onerror = () => {
                passError = "Backward worker WebSocket failed.";
                finish();
              };

              ws.onclose = () => {
                finish();
              };
            });

          const first = await executeAttempt(langHint);
          if (first.fatalError || signal.aborted) {
            return first;
          }
          if (!first.text && first.passError) {
            // 1 automatic resilient retry on transient socket drop
            const fallbackHint =
              langHint && configSnapshot.languageCode === "auto"
                ? null
                : langHint;
            return await executeAttempt(fallbackHint);
          }
          return first;
        };

        const activeHalves = sliced.halves.filter((h) => h.hasAudioSignal);
        if (activeHalves.length === 0) return;

        // 4 independent backward workers run concurrently at exact 1.0x 128ms cadence
        // (2 on first 5s + 2 on later 5s: 1 high-quality conditioned + 1 raw wave per half)
        const contrastMode: "VERBATIM" | "SMART" =
          configSnapshot.mode === "SMART" ? "VERBATIM" : "SMART";

        const halfPairOutputs = await Promise.all(
          activeHalves.map(async (half) => {
            const prevIdx = half.halfIndex - 1;
            const prevText =
              prevIdx >= 0 && lp.runId === runId && lp.rawHalfTexts[prevIdx]
                ? lp.rawHalfTexts[prevIdx].slice(-220)
                : undefined;
            const langSnapshot = lp.runId === runId ? lp.lockedAutoLang : null;

            const workers = await Promise.all([
              // Worker A (High-quality conditioned speech wave, configured mode, true 128ms pace)
              runBackwardSinglePass(
                half,
                false,
                configSnapshot.mode,
                128,
                langSnapshot,
                prevText
              ),
              // Worker B (Raw input wave, contrasting mode, true 128ms pace)
              runBackwardSinglePass(
                half,
                true,
                contrastMode,
                128,
                langSnapshot,
                prevText
              ),
            ]);
            return { half, workers };
          })
        );

        if (signal.aborted) return;

        const fatalRes = halfPairOutputs
          .flatMap((hp) => hp.workers)
          .find((w) => w.fatalError);
        if (fatalRes?.fatalError) {
          setErrorMessage(fatalRes.fatalError);
          return;
        }

        const refinedWindowSegments: TranscriptSegment[] = [];
        const newLangs: string[] = [];

        for (const { half, workers } of halfPairOutputs) {
          if (signal.aborted) return;

          const activeScriptLock =
            lp.runId === runId
              ? lp.lockedScriptFamily
              : configSnapshot.languageCode === "auto"
                ? null
                : bcp47ToScriptFamily(configSnapshot.languageCode);

          let reconciled = reconcileFocusedTranscripts(
            workers.map((w) => ({
              text: w.text,
              lang: w.lang,
              isSmart: w.isSmart,
            })),
            activeScriptLock
          );

          const domScript = reconciled.text
            ? detectScriptFamily(reconciled.text)
            : null;
          if (
            lp.runId === runId &&
            configSnapshot.languageCode === "auto" &&
            reconciled.text &&
            !lp.lockedScriptFamily &&
            !hasMixedLatinWithNonLatin(reconciled.text)
          ) {
            lp.lockedScriptFamily = domScript;
            lp.lockedAutoLang =
              reconciled.lang ?? scriptFamilyToBcp47(domScript) ?? null;
          }

          const effectiveScriptLock =
            lp.runId === runId ? lp.lockedScriptFamily : activeScriptLock;
          const effectiveLangLock =
            lp.runId === runId ? lp.lockedAutoLang : null;

          const driftedOffNonLatin =
            Boolean(effectiveScriptLock) &&
            effectiveScriptLock !== "latin" &&
            Boolean(reconciled.text) &&
            (hasMixedLatinWithNonLatin(reconciled.text) ||
              detectScriptFamily(reconciled.text) !== effectiveScriptLock);

          if (effectiveLangLock && reconciled.text && driftedOffNonLatin) {
            const verifyPass = await runBackwardSinglePass(
              half,
              false,
              configSnapshot.mode,
              104,
              effectiveLangLock
            );
            if (!signal.aborted && verifyPass.text) {
              const verifiedRec = reconcileFocusedTranscripts(
                [
                  ...workers.map((w) => ({
                    text: w.text,
                    lang: w.lang,
                    isSmart: w.isSmart,
                  })),
                  {
                    text: verifyPass.text,
                    lang: verifyPass.lang,
                    isSmart: verifyPass.isSmart,
                  },
                ],
                effectiveScriptLock
              );
              if (
                verifiedRec.text &&
                detectScriptFamily(verifiedRec.text) === effectiveScriptLock &&
                !hasMixedLatinWithNonLatin(verifiedRec.text)
              ) {
                reconciled = verifiedRec;
              } else if (
                detectScriptFamily(verifyPass.text) === effectiveScriptLock &&
                !hasMixedLatinWithNonLatin(verifyPass.text)
              ) {
                reconciled = {
                  text: verifyPass.text,
                  lang: verifyPass.lang ?? effectiveLangLock,
                };
              }
            }
          }

          if (!reconciled.text) continue;

          // Boundary stitch with immediately preceding half/window
          let prevRaw = "";
          if (lp.runId === runId) {
            for (let p = half.halfIndex - 1; p >= 0; p--) {
              if (lp.rawHalfTexts[p]) {
                prevRaw = lp.rawHalfTexts[p];
                break;
              }
            }
          }
          const stitched = cleanTranscriptArtifacts(
            prevRaw ? stitchChunkBoundary(prevRaw, reconciled.text) : reconciled.text
          );
          if (!stitched) continue;

          if (lp.runId === runId) {
            lp.rawHalfTexts[half.halfIndex] = stitched;
          }

          const cues = splitTextIntoTimedCues(
            stitched,
            half.startMs,
            Math.max(half.startMs + 500, half.endMs)
          );
          const segLang =
            reconciled.lang ??
            effectiveLangLock ??
            (configSnapshot.languageCode === "auto"
              ? undefined
              : configSnapshot.languageCode);
          if (segLang && !newLangs.includes(segLang)) {
            newLangs.push(segLang);
          }

          cues.forEach((cue, cueIdx) => {
            refinedWindowSegments.push({
              id: `seg_live_ref_${sliced.windowIndex}_${half.halfIndex}_${cueIdx}_${Date.now()}`,
              text: cue.text,
              speakerId: "spk_1",
              languageCode: segLang,
              timestampMs: cue.startMs,
              endTimestampMs: cue.endMs,
              liveWindowIndex: sliced.windowIndex,
              liveHalfIndex: half.halfIndex,
              isProvisional: true,
              isRefined: false,
            });
          });
        }

        if (signal.aborted) return;

        // Preserve all 4 backward worker outputs independently alongside Worker 1
        // without discarding or letting one worker override another.
        if (lp.runId === runId) {
          const half0Pair = halfPairOutputs.find((hp) => hp.half.halfIndex === 0);
          const half1Pair = halfPairOutputs.find((hp) => hp.half.halfIndex === 1);
          upsertBackwardWorkerObservations(
            lp.structuredWindows,
            sliced.windowIndex,
            sliced.windowStartMs,
            sliced.windowEndMs,
            {
              firstHalfPrimary: half0Pair?.workers[0]?.text ?? "",
              firstHalfContrast: half0Pair?.workers[1]?.text ?? "",
              secondHalfPrimary: half1Pair?.workers[0]?.text ?? "",
              secondHalfContrast: half1Pair?.workers[1]?.text ?? "",
            }
          );
        }

        updateSessionById(targetSessionId, (s) => {
          let mergedLangs = s.detectedLanguages;
          for (const nl of newLangs) {
            if (!mergedLangs.includes(nl)) {
              mergedLangs = [...mergedLangs, nl];
            }
          }

          // Do not overwrite Worker 1's provisional stream with backward workers;
          // wait for the 1-minute LM pass unless Worker 1 dropped with zero text.
          const hasWorker1OrEditedText = s.segments.some(
            (seg) =>
              seg.liveWindowIndex === sliced.windowIndex &&
              seg.text.trim().length > 0
          );

          const nextSegments = hasWorker1OrEditedText
            ? s.segments
            : mergeWindowRefinedSegments(s.segments, {
                windowIndex: sliced.windowIndex,
                windowStartMs: sliced.windowStartMs,
                windowEndMs: sliced.windowEndMs,
                refinedSegments: refinedWindowSegments,
              });

          return {
            ...s,
            segments: nextSegments,
            detectedLanguages: mergedLangs,
            durationMs: Math.max(s.durationMs, sliced.windowEndMs),
            updatedAt: Date.now(),
          };
        });
      } finally {
        if (lp.runId === runId) {
          lp.refiningWindowsCount = Math.max(0, lp.refiningWindowsCount - 1);
          if (!signal.aborted) {
            lp.refinedWindowsCount += 1;
          }
          syncLiveRefinementUI(true);
        }
      }
    },
    [syncLiveRefinementUI, updateSessionById]
  );

  const cleanupAudioPipeline = useCallback(() => {
    if (liveTimerRef.current !== null) {
      window.clearInterval(liveTimerRef.current);
      liveTimerRef.current = null;
    }
    if (workletNodeRef.current) {
      try {
        workletNodeRef.current.port.onmessage = null;
        workletNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      workletNodeRef.current = null;
    }
    if (scriptNodeRef.current) {
      try {
        scriptNodeRef.current.onaudioprocess = null;
        scriptNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      scriptNodeRef.current = null;
    }
    if (workletUrlRef.current) {
      URL.revokeObjectURL(workletUrlRef.current);
      workletUrlRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      try {
        void audioCtxRef.current.close();
      } catch {
        // ignore
      }
      audioCtxRef.current = null;
    }
    setAnalyserNode(null);
  }, []);

  const stopRecording = useCallback(() => {
    const lp = livePipelineRef.current;
    const stopRunId = lp.runId;
    liveRecordingActiveRef.current = false;
    lp.isStopping = true;

    if (lp.reconnectTimer !== null) {
      window.clearTimeout(lp.reconnectTimer);
      lp.reconnectTimer = null;
    }
    if (lp.lmIntervalTimer !== null) {
      window.clearInterval(lp.lmIntervalTimer);
      lp.lmIntervalTimer = null;
    }

    const targetSessionId = lp.targetSessionId || activeSessionIdRef.current;
    const totalElapsed = Math.max(
      accumulatedMsRef.current +
        (!isPausedRef.current && runStartRef.current > 0
          ? Date.now() - runStartRef.current
          : 0),
      lp.recordingStartOffsetMs +
        Math.round((lp.totalRecordedSamples / LIVE_SAMPLE_RATE) * 1000)
    );

    updateSessionById(targetSessionId, (s) => ({
      ...s,
      durationMs: Math.max(s.durationMs, totalElapsed),
      updatedAt: Date.now(),
    }));

    setConnectionState("stopping");
    isPausedRef.current = false;

    for (const liveSock of [wsRef.current, wsHqRef.current]) {
      if (!liveSock) continue;
      if (liveSock.readyState === WebSocket.OPEN) {
        try {
          liveSock.send(JSON.stringify({ type: "stop" }));
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            liveSock.close();
          } catch {
            // ignore
          }
        }, 300);
      } else {
        try {
          liveSock.close();
        } catch {
          // ignore
        }
      }
    }
    wsRef.current = null;
    wsHqRef.current = null;

    cleanupAudioPipeline();

    // Flush any remaining recorded partial window (>= 0.25s) to backward workers on Stop
    const leftoverCount = lp.count;
    const minTailSamples = Math.floor(LIVE_SAMPLE_RATE * 0.25);
    if (
      leftoverCount >= minTailSamples &&
      liveRefineAbortRef.current &&
      !liveRefineAbortRef.current.signal.aborted
    ) {
      const leftoverSamples = concatFloat32Arrays(lp.chunks);
      lp.chunks = [];
      lp.count = 0;
      const tailWinIdx = lp.windowIndex;
      const tailWinStartMs =
        lp.recordingStartOffsetMs + tailWinIdx * LIVE_WINDOW_SECONDS * 1000;
      lp.windowIndex = tailWinIdx + 1;

      const slicedTail = sliceLiveWindowIntoHalves({
        windowSamples: leftoverSamples,
        prevTailSamples: lp.prevTailSamples,
        windowIndex: tailWinIdx,
        windowStartMs: tailWinStartMs,
      });
      lp.prevTailSamples = slicedTail.tailSamples;
      const tailPromise = refineLiveWindow(
        slicedTail,
        lp.runId,
        targetSessionId,
        lp.configSnapshot,
        liveRefineAbortRef.current.signal
      );
      lp.inFlightBackwardPromises.add(tailPromise);
      void tailPromise.finally(() => {
        lp.inFlightBackwardPromises.delete(tailPromise);
      });
    } else {
      lp.chunks = [];
      lp.count = 0;
    }

    // Wait for all active backward workers on this run, then flush final LM pass silently
    const abortSignal = liveRefineAbortRef.current?.signal;
    const pendingBackward = Array.from(lp.inFlightBackwardPromises);
    if (abortSignal && !abortSignal.aborted) {
      void Promise.allSettled(pendingBackward).then(() => {
        if (lp.runId === stopRunId && !abortSignal.aborted) {
          return runLmRefinementPass(
            stopRunId,
            targetSessionId,
            abortSignal,
            true
          );
        }
      });
    }

    setInterimText("");
    setInterimSpeaker("");
    setInterimLanguage("");
    setConnectionState("idle");
    syncLiveRefinementUI(true);
  }, [
    cleanupAudioPipeline,
    refineLiveWindow,
    runLmRefinementPass,
    syncLiveRefinementUI,
    updateSessionById,
  ]);

  useEffect(() => {
    return () => {
      liveRecordingActiveRef.current = false;
      const lp = livePipelineRef.current;
      if (lp.reconnectTimer !== null) {
        window.clearTimeout(lp.reconnectTimer);
        lp.reconnectTimer = null;
      }
      if (lp.lmIntervalTimer !== null) {
        window.clearInterval(lp.lmIntervalTimer);
        lp.lmIntervalTimer = null;
      }
      lp.lmActivePromise = null;
      cleanupAudioPipeline();
      uploadAbortRef.current?.abort();
      liveRefineAbortRef.current?.abort();
      for (const sock of [wsRef.current, wsHqRef.current]) {
        if (sock) {
          try {
            sock.close();
          } catch {
            // ignore
          }
        }
      }
    };
  }, [cleanupAudioPipeline]);

  const detachUploadedAudio = useCallback(() => {
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
    audioPlaybackEndedRef.current = false;
    isAudioPlayingRef.current = false;
    isPreBufferingRef.current = false;
    setUploadedAudio((prev) => {
      if (prev?.url) {
        URL.revokeObjectURL(prev.url);
      }
      return null;
    });
    setChunkProgress(null);
    setPlaybackTimeMs(0);
    setIsAudioPlaying(false);
    setInterimText("");
    setInterimSpeaker("");
    setInterimLanguage("");
  }, []);

  const startRecording = useCallback(async () => {
    if (
      connectionState === "connecting" ||
      connectionState === "listening" ||
      connectionState === "paused"
    ) {
      return;
    }

    setErrorMessage(null);
    setConnectionState("connecting");
    setActiveTab("transcript");
    isPausedRef.current = false;

    const currentSess = activeSession;
    const targetSessionId = currentSess.id;
    const cfgSnapshot: TranscriptionConfig = {
      ...currentSess.config,
      customVocabulary: [...currentSess.config.customVocabulary],
    };
    accumulatedMsRef.current = currentSess.durationMs;
    setLiveDurationMs(currentSess.durationMs);

    liveRefineAbortRef.current?.abort();
    const refineController = new AbortController();
    liveRefineAbortRef.current = refineController;
    const runId = ++liveSessionRunRef.current;

    if (livePipelineRef.current.reconnectTimer !== null) {
      window.clearTimeout(livePipelineRef.current.reconnectTimer);
    }
    if (livePipelineRef.current.lmIntervalTimer !== null) {
      window.clearInterval(livePipelineRef.current.lmIntervalTimer);
    }

    livePipelineRef.current = {
      runId,
      chunks: [],
      count: 0,
      windowIndex: 0,
      totalRecordedSamples: 0,
      recordingStartOffsetMs: currentSess.durationMs,
      prevTailSamples: null,
      refiningWindowsCount: 0,
      refinedWindowsCount: 0,
      liveWorkerStatus: "connecting",
      lastUiSyncAt: 0,
      rawHalfTexts: {},
      lockedAutoLang:
        cfgSnapshot.languageCode === "auto" ? null : cfgSnapshot.languageCode,
      lockedScriptFamily:
        cfgSnapshot.languageCode === "auto"
          ? null
          : bcp47ToScriptFamily(cfgSnapshot.languageCode),
      targetSessionId,
      configSnapshot: cfgSnapshot,
      reconnectTimer: null,
      reconnectAttempts: 0,
      isStopping: false,
      structuredWindows: new Map(),
      inFlightBackwardPromises: new Set(),
      lmIntervalTimer: null,
      lmActivePromise: null,
    };

    // Run under-the-hood LM multi-worker synthesis once every 60 seconds
    livePipelineRef.current.lmIntervalTimer = window.setInterval(() => {
      if (
        !isPausedRef.current &&
        liveRecordingActiveRef.current &&
        !refineController.signal.aborted
      ) {
        void runLmRefinementPass(
          runId,
          targetSessionId,
          refineController.signal,
          false
        );
      }
    }, LIVE_LM_INTERVAL_MS);

    liveRecordingActiveRef.current = true;
    syncLiveRefinementUI(true);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "Microphone access is not supported in this browser context."
        );
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: { ideal: false },
            autoGainControl: { ideal: false },
          },
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
            channelCount: 1,
            echoCancellation: true,
          },
        });
      }
      streamRef.current = stream;
      void refreshAudioDevices();

      // Prefer hardware native sample rate so downsampleBuffer performs clean 3:1 anti-aliased decimation
      let audioCtx: AudioContext;
      try {
        audioCtx = new AudioContext();
      } catch {
        audioCtx = new AudioContext({ sampleRate: LIVE_SAMPLE_RATE });
      }
      audioCtxRef.current = audioCtx;
      if (audioCtx.state === "suspended") {
        await audioCtx.resume();
      }

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);
      setAnalyserNode(analyser);

      const silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;
      silentGain.connect(audioCtx.destination);

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsEndpoint = `${protocol}//${window.location.host}/ws/transcribe`;
      let rotatingSocket = false;
      let micStartedListening = false;
      const hqStreamConditioner =
        createStreamingSpeechConditioner(LIVE_SAMPLE_RATE);

      const ensureMicListeningState = () => {
        if (
          micStartedListening ||
          !liveRecordingActiveRef.current ||
          livePipelineRef.current.runId !== runId ||
          livePipelineRef.current.isStopping
        ) {
          return;
        }
        micStartedListening = true;
        setConnectionState("listening");
        if (runStartRef.current === 0) {
          runStartRef.current = Date.now();
        }
        if (liveTimerRef.current === null) {
          liveTimerRef.current = window.setInterval(() => {
            if (!isPausedRef.current && runStartRef.current > 0) {
              const elapsed =
                accumulatedMsRef.current + (Date.now() - runStartRef.current);
              setLiveDurationMs(elapsed);
            }
          }, 250);
        }
      };

      const sendPcmChunk = (float32: Float32Array) => {
        if (isPausedRef.current) return;
        const lp = livePipelineRef.current;
        if (!liveRecordingActiveRef.current || lp.runId !== runId) return;

        ensureMicListeningState();

        const downsampled = downsampleBuffer(
          float32,
          audioCtx.sampleRate,
          LIVE_SAMPLE_RATE
        );

        // 1A) Forward raw un-conditioned wave to Real-Time Raw Worker
        const activeWs = wsRef.current;
        if (activeWs && activeWs.readyState === WebSocket.OPEN) {
          const rawBase64 = float32ToBase64Pcm16(downsampled);
          activeWs.send(JSON.stringify({ type: "audio", data: rawBase64 }));
        }

        // 1B) Forward click-free 55Hz HPF + RMS-leveled High-Quality wave to Real-Time HQ Worker
        const activeHqWs = wsHqRef.current;
        if (activeHqWs && activeHqWs.readyState === WebSocket.OPEN) {
          const hqWave = hqStreamConditioner(downsampled);
          const hqBase64 = float32ToBase64Pcm16(hqWave);
          activeHqWs.send(JSON.stringify({ type: "audio", data: hqBase64 }));
        }

        // 2) Buffer into the rolling 10-second live window; once 10s is reached,
        //    drop the consumed 10s buffer, start recording the next 10s window,
        //    and fire the 4 independent backward workers (2+2 on first 5s + later 5s)
        lp.totalRecordedSamples += downsampled.length;
        const extracted = appendAndExtractLiveWindows(
          lp.chunks,
          lp.count,
          downsampled,
          LIVE_WINDOW_SAMPLES
        );
        lp.chunks = extracted.remainingChunks;
        lp.count = extracted.remainingCount;

        for (const completedWindowSamples of extracted.completedWindows) {
          const winIdx = lp.windowIndex;
          const winStartMs =
            lp.recordingStartOffsetMs + winIdx * LIVE_WINDOW_SECONDS * 1000;
          lp.windowIndex = winIdx + 1;

          const sliced = sliceLiveWindowIntoHalves({
            windowSamples: completedWindowSamples,
            prevTailSamples: lp.prevTailSamples,
            windowIndex: winIdx,
            windowStartMs: winStartMs,
          });
          lp.prevTailSamples = sliced.tailSamples;

          const winPromise = refineLiveWindow(
            sliced,
            runId,
            targetSessionId,
            cfgSnapshot,
            refineController.signal
          );
          lp.inFlightBackwardPromises.add(winPromise);
          void winPromise.finally(() => {
            lp.inFlightBackwardPromises.delete(winPromise);
          });
        }

        syncLiveRefinementUI(extracted.completedWindows.length > 0);
      };

      const attachHqLiveSocket = () => {
        const lp = livePipelineRef.current;
        if (
          !liveRecordingActiveRef.current ||
          lp.runId !== runId ||
          lp.isStopping
        ) {
          return;
        }
        const prevHqWs = wsHqRef.current;
        const hqWs = new WebSocket(wsEndpoint);
        wsHqRef.current = hqWs;
        const hqMode: "VERBATIM" | "SMART" =
          cfgSnapshot.mode === "SMART" ? "VERBATIM" : "SMART";

        hqWs.onopen = () => {
          hqWs.send(
            JSON.stringify({
              type: "start",
              mode: hqMode,
              languageCodes:
                cfgSnapshot.languageCode === "auto"
                  ? []
                  : [cfgSnapshot.languageCode],
              customVocabulary: cfgSnapshot.customVocabulary,
            })
          );
        };

        hqWs.onmessage = (event) => {
          if (lp.runId !== runId || lp.isStopping) return;
          let msg: {
            type: string;
            text?: string;
            languageCode?: string;
          };
          try {
            msg = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (msg.type === "ready" && prevHqWs && prevHqWs !== hqWs) {
            try {
              if (prevHqWs.readyState === WebSocket.OPEN) {
                prevHqWs.send(JSON.stringify({ type: "stop" }));
              }
              prevHqWs.close();
            } catch {
              // ignore
            }
            return;
          }
          if (msg.type === "transcript") {
            const cleanText = cleanTranscriptArtifacts(msg.text ?? "");
            if (!cleanText) return;
            const currentElapsed =
              lp.recordingStartOffsetMs +
              Math.round((lp.totalRecordedSamples / LIVE_SAMPLE_RATE) * 1000);
            const liveWinIdx = Math.floor(
              lp.totalRecordedSamples / LIVE_WINDOW_SAMPLES
            );
            const winStartMs =
              lp.recordingStartOffsetMs +
              liveWinIdx * LIVE_WINDOW_SECONDS * 1000;
            const winEndMs = winStartMs + LIVE_WINDOW_SECONDS * 1000;
            upsertLiveHqWorkerObservation(
              lp.structuredWindows,
              liveWinIdx,
              winStartMs,
              winEndMs,
              cleanText
            );

            // If Worker 1A dropped, seamlessly show Worker 1B's real-time HQ draft
            if (lp.liveWorkerStatus === "dropped") {
              updateSessionById(targetSessionId, (s) => {
                if (
                  lp.structuredWindows.get(liveWinIdx)?.lmRefined ||
                  s.segments.some(
                    (seg) =>
                      seg.liveWindowIndex === liveWinIdx && Boolean(seg.isRefined)
                  )
                ) {
                  return s;
                }
                return {
                  ...s,
                  segments: [
                    ...s.segments,
                    {
                      id: `seg_hq_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                      text: cleanText,
                      speakerId: "spk_1",
                      languageCode: msg.languageCode,
                      timestampMs: currentElapsed,
                      liveWindowIndex: liveWinIdx,
                      isProvisional: true,
                    },
                  ],
                  durationMs: Math.max(s.durationMs, currentElapsed),
                  updatedAt: Date.now(),
                };
              });
            }
          } else if (
            msg.type === "goAway" &&
            wsHqRef.current === hqWs &&
            liveRecordingActiveRef.current &&
            !lp.isStopping
          ) {
            attachHqLiveSocket();
          }
        };

        hqWs.onclose = () => {
          if (wsHqRef.current === hqWs) {
            wsHqRef.current = null;
          }
        };
      };

      const attachMicSocket = (isReplacement: boolean) => {
        const lp = livePipelineRef.current;
        if (
          !liveRecordingActiveRef.current ||
          lp.runId !== runId ||
          lp.isStopping
        ) {
          return;
        }

        const ws = new WebSocket(wsEndpoint);
        if (!isReplacement || !wsRef.current) {
          wsRef.current = ws;
        }

        const handleNonFatalLiveDrop = () => {
          if (
            !liveRecordingActiveRef.current ||
            lp.runId !== runId ||
            lp.isStopping
          ) {
            return;
          }
          ensureMicListeningState();
          if (wsRef.current === ws) {
            wsRef.current = null;
          }
          setInterimText("");

          // Resiliency rule: if live worker drops, never abort mic capture or 4 backward workers!
          if (lp.reconnectAttempts < 3) {
            lp.reconnectAttempts += 1;
            lp.liveWorkerStatus = "reconnecting";
            syncLiveRefinementUI(true);
            if (lp.reconnectTimer !== null) {
              window.clearTimeout(lp.reconnectTimer);
            }
            lp.reconnectTimer = window.setTimeout(() => {
              lp.reconnectTimer = null;
              attachMicSocket(true);
            }, 900 * lp.reconnectAttempts);
          } else {
            lp.liveWorkerStatus = "dropped";
            syncLiveRefinementUI(true);
          }
        };

        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: "start",
              mode: cfgSnapshot.mode,
              languageCodes:
                cfgSnapshot.languageCode === "auto"
                  ? []
                  : [cfgSnapshot.languageCode],
              customVocabulary: cfgSnapshot.customVocabulary,
            })
          );
        };

        ws.onmessage = (event) => {
          if (lp.runId !== runId || lp.isStopping) return;
          let msg: {
            type: string;
            text?: string;
            finished?: boolean;
            languageCode?: string;
            speakerLabel?: string;
            startOffset?: string;
            words?: WordTiming[];
            message?: string;
          };
          try {
            msg = JSON.parse(String(event.data));
          } catch {
            return;
          }

          if (msg.type === "ready") {
            lp.liveWorkerStatus = "connected";
            lp.reconnectAttempts = 0;
            if (isReplacement) {
              const previousWs = wsRef.current;
              wsRef.current = ws;
              rotatingSocket = false;
              syncLiveRefinementUI(true);
              if (previousWs && previousWs !== ws) {
                try {
                  if (previousWs.readyState === WebSocket.OPEN) {
                    previousWs.send(JSON.stringify({ type: "stop" }));
                  }
                } catch {
                  // ignore
                }
                setTimeout(() => {
                  try {
                    previousWs.close();
                  } catch {
                    // ignore
                  }
                }, 250);
              }
              return;
            }

            ensureMicListeningState();
            syncLiveRefinementUI(true);
            return;
          }

          if (
            msg.type === "goAway" &&
            !rotatingSocket &&
            wsRef.current === ws
          ) {
            rotatingSocket = true;
            attachMicSocket(true);
            return;
          }

          if (msg.type === "interim") {
            setInterimText(msg.text ?? "");
            if (msg.speakerLabel) setInterimSpeaker(msg.speakerLabel);
            if (msg.languageCode) setInterimLanguage(msg.languageCode);
            return;
          }

          if (msg.type === "transcript") {
            const cleanText = cleanTranscriptArtifacts(msg.text ?? "");
            setInterimText("");
            if (!cleanText) return;

            const currentElapsed =
              lp.recordingStartOffsetMs +
              Math.round((lp.totalRecordedSamples / LIVE_SAMPLE_RATE) * 1000);
            const liveWinIdx = Math.floor(
              lp.totalRecordedSamples / LIVE_WINDOW_SAMPLES
            );

            // Preserve Worker 1A's independent real-time transcription in structured store
            if (lp.runId === runId) {
              const winStartMs =
                lp.recordingStartOffsetMs +
                liveWinIdx * LIVE_WINDOW_SECONDS * 1000;
              const winEndMs = winStartMs + LIVE_WINDOW_SECONDS * 1000;
              upsertLiveWorkerObservation(
                lp.structuredWindows,
                liveWinIdx,
                winStartMs,
                winEndMs,
                cleanText
              );
            }

            const speakerId = msg.speakerLabel || "spk_1";
            const lang = msg.languageCode;
            const now = Date.now();

            updateSessionById(targetSessionId, (s) => {
              // If the 1-minute LM pass already refined this window, don't inject stale drafts
              const windowAlreadyRefined =
                Boolean(lp.structuredWindows.get(liveWinIdx)?.lmRefined) ||
                s.segments.some(
                  (seg) =>
                    seg.liveWindowIndex === liveWinIdx && Boolean(seg.isRefined)
                );
              if (windowAlreadyRefined) {
                return s;
              }

              const lastSeg = s.segments[s.segments.length - 1];
              const shouldMerge =
                lastSeg &&
                lastSeg.isProvisional &&
                !lastSeg.isRefined &&
                !lastSeg.isEdited &&
                lastSeg.liveWindowIndex === liveWinIdx &&
                lastSeg.speakerId === speakerId &&
                now - lastSegmentTimeRef.current < 2400 &&
                !/[.!?።፧。？！]$/.test(lastSeg.text.trim()) &&
                !msg.words?.length;

              const updatedLanguages =
                lang && !s.detectedLanguages.includes(lang)
                  ? [...s.detectedLanguages, lang]
                  : s.detectedLanguages;

              if (shouldMerge) {
                const mergedText = cleanTranscriptArtifacts(
                  `${lastSeg.text} ${cleanText}`
                );
                const nextSegments = s.segments.slice(0, -1).concat({
                  ...lastSeg,
                  text: mergedText,
                  languageCode: lang ?? lastSeg.languageCode,
                });
                return {
                  ...s,
                  segments: nextSegments,
                  detectedLanguages: updatedLanguages,
                  durationMs: Math.max(s.durationMs, currentElapsed),
                  updatedAt: now,
                };
              }

              const newSeg: TranscriptSegment = {
                id: `seg_${now}_${Math.random().toString(36).slice(2, 6)}`,
                text: cleanText,
                speakerId,
                languageCode: lang,
                timestampMs: currentElapsed,
                liveWindowIndex: liveWinIdx,
                isProvisional: true,
                startOffset: msg.startOffset,
                words: msg.words,
              };

              return {
                ...s,
                segments: [...s.segments, newSeg],
                detectedLanguages: updatedLanguages,
                durationMs: Math.max(s.durationMs, currentElapsed),
                updatedAt: now,
              };
            });

            lastSegmentTimeRef.current = now;
            return;
          }

          if (msg.type === "error") {
            const errMsg = msg.message || "Transcription connection error.";
            if (isFatalConfigErrorMessage(errMsg)) {
              liveRecordingActiveRef.current = false;
              lp.isStopping = true;
              refineController.abort();
              setErrorMessage(errMsg);
              cleanupAudioPipeline();
              setConnectionState("error");
              syncLiveRefinementUI(true);
              for (const sock of [wsRef.current, wsHqRef.current]) {
                if (sock) {
                  try {
                    sock.close();
                  } catch {
                    // ignore
                  }
                }
              }
              wsRef.current = null;
              wsHqRef.current = null;
              return;
            }
            if (isReplacement && wsRef.current !== ws) {
              rotatingSocket = false;
            }
            handleNonFatalLiveDrop();
            return;
          }

          if (msg.type === "closed") {
            if (isReplacement && wsRef.current !== ws) {
              rotatingSocket = false;
              return;
            }
            handleNonFatalLiveDrop();
          }
        };

        ws.onerror = () => {
          if (isReplacement && wsRef.current !== ws) {
            rotatingSocket = false;
            return;
          }
          handleNonFatalLiveDrop();
        };

        ws.onclose = () => {
          if (isReplacement && wsRef.current !== ws) {
            rotatingSocket = false;
            return;
          }
          handleNonFatalLiveDrop();
        };
      };

      attachMicSocket(false);
      attachHqLiveSocket();

      let workletAttached = false;
      if (audioCtx.audioWorklet) {
        try {
          const blob = new Blob([AUDIO_WORKLET_SOURCE], {
            type: "application/javascript",
          });
          const workletUrl = URL.createObjectURL(blob);
          workletUrlRef.current = workletUrl;
          await audioCtx.audioWorklet.addModule(workletUrl);
          const workletNode = new AudioWorkletNode(
            audioCtx,
            "pcm-capture-processor"
          );
          workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
            sendPcmChunk(event.data);
          };
          source.connect(workletNode);
          workletNode.connect(silentGain);
          workletNodeRef.current = workletNode;
          workletAttached = true;
        } catch {
          workletAttached = false;
        }
      }

      if (!workletAttached) {
        const scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
        scriptNode.onaudioprocess = (e) => {
          const channel = e.inputBuffer.getChannelData(0);
          sendPcmChunk(new Float32Array(channel));
        };
        source.connect(scriptNode);
        scriptNode.connect(silentGain);
        scriptNodeRef.current = scriptNode;
      }
    } catch (err) {
      liveRecordingActiveRef.current = false;
      livePipelineRef.current.isStopping = true;
      refineController.abort();
      const msg =
        err instanceof Error
          ? err.name === "NotAllowedError"
            ? "Microphone permission was denied. Please allow microphone access in your browser settings."
            : err.message
          : "Could not start microphone capture.";
      setErrorMessage(msg);
      cleanupAudioPipeline();
      setConnectionState("idle");
      syncLiveRefinementUI(true);
    }
  }, [
    activeSession,
    cleanupAudioPipeline,
    connectionState,
    refineLiveWindow,
    refreshAudioDevices,
    runLmRefinementPass,
    selectedDeviceId,
    syncLiveRefinementUI,
    updateSessionById,
  ]);

  const togglePause = useCallback(() => {
    if (connectionState === "listening") {
      isPausedRef.current = true;
      accumulatedMsRef.current +=
        runStartRef.current > 0 ? Date.now() - runStartRef.current : 0;
      runStartRef.current = 0;
      setLiveDurationMs(accumulatedMsRef.current);
      for (const sock of [wsRef.current, wsHqRef.current]) {
        if (sock && sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ type: "audioStreamEnd" }));
        }
      }
      setConnectionState("paused");
    } else if (connectionState === "paused") {
      isPausedRef.current = false;
      runStartRef.current = Date.now();
      setConnectionState("listening");
    }
  }, [connectionState]);

  // 15-second Chunked Audio Upload + Live YouTube-Style Synced Captions
  const handleStartLiveChunkedUpload = useCallback(
    async (file: File, autoPlay: boolean) => {
      detachUploadedAudio();
      setErrorMessage(null);
      setActiveTab("transcript");

      const abortController = new AbortController();
      uploadAbortRef.current = abortController;

      const cleanTitle = file.name.replace(/\.[^/.]+$/, "") || "Uploaded Audio";
      const cfg = activeSession.config;
      const newSession: TranscriptionSession = {
        ...createEmptySession(cfg),
        title: cleanTitle,
      };

      setSessions((prev) => [newSession, ...prev]);
      setActiveSessionId(newSession.id);

      const objectUrl = URL.createObjectURL(file);
      setUploadedAudio({
        sessionId: newSession.id,
        url: objectUrl,
        fileName: file.name,
        durationMs: 0,
      });

      try {
        isPreBufferingRef.current = true;
        setChunkProgress({
          totalChunks: 0,
          completedChunks: 0,
          completedChunkIndices: [],
          activeChunkIndices: [],
          waveCount: 1,
          workerCount: WORKERS_PER_WAVE,
          readyWorkers: 0,
          preRollStage: "segmenting",
          isBuffering: true,
          chunkDurationSec: 15,
          isProcessing: true,
          isPaused: false,
          isAudioEnded: false,
        });

        const { totalDurationMs, chunks } = await sliceAudioFileIntoLiveChunks(
          file,
          15,
          2048
        );

        if (abortController.signal.aborted) return;

        updateSessionById(newSession.id, (s) => ({
          ...s,
          durationMs: totalDurationMs,
        }));
        setUploadedAudio((prev) =>
          prev && prev.sessionId === newSession.id
            ? { ...prev, durationMs: totalDurationMs }
            : prev
        );

        const waveCount = getWaveCount(chunks.length);
        const workerCount = waveCount * WORKERS_PER_WAVE;
        isPreBufferingRef.current = chunks.length > 0;
        let preRollCompleted = chunks.length === 0;
        let readyWorkerCount = 0;
        let allWorkersReady = false;
        let preRollStage: "segmenting" | "connecting" | "transcribing" =
          "connecting";

        setChunkProgress({
          totalChunks: chunks.length,
          completedChunks: 0,
          completedChunkIndices: [],
          activeChunkIndices: [],
          waveCount,
          workerCount,
          readyWorkers: 0,
          preRollStage,
          isBuffering: isPreBufferingRef.current,
          chunkDurationSec: 15,
          isProcessing: true,
          isPaused: false,
          isAudioEnded: false,
        });

        let lockedAutoLang: string | null =
          cfg.languageCode === "auto" ? null : cfg.languageCode;
        let lockedScriptFamily: string | null =
          cfg.languageCode === "auto"
            ? null
            : bcp47ToScriptFamily(cfg.languageCode);

        // Isolated Live WebSocket session helper (1 independent session per pass)
        const openLiveWs = (
          langHint: string | null,
          sourceContext?: string,
          overrideMode?: "VERBATIM" | "SMART"
        ) =>
          new Promise<{
            ws: WebSocket;
            setChunkHandlers: (handlers: {
              onInterim: (text: string) => void;
              onTranscript: (text: string, lang?: string) => void;
              onTurnComplete: () => void;
              onClose: (code?: number) => void;
              onError: (msg: string) => void;
            }) => void;
          }>((resolve, reject) => {
            const protocol =
              window.location.protocol === "https:" ? "wss:" : "ws:";
            const ws = new WebSocket(
              `${protocol}//${window.location.host}/ws/transcribe`
            );
            const effectiveMode = overrideMode ?? cfg.mode;
            let handlers = {
              onInterim: (_t: string) => {},
              onTranscript: (_t: string, _l?: string) => {},
              onTurnComplete: () => {},
              onClose: (_code?: number) => {},
              onError: (_m: string) => {},
            };
            let settled = false;

            const onAbort = () => {
              try {
                ws.close();
              } catch {
                // ignore
              }
            };
            abortController.signal.addEventListener("abort", onAbort, {
              once: true,
            });

            ws.onopen = () => {
              ws.send(
                JSON.stringify({
                  type: "start",
                  mode: effectiveMode,
                  languageCodes: langHint ? [langHint] : [],
                  customVocabulary: cfg.customVocabulary,
                  ...(effectiveMode === "SMART" && sourceContext
                    ? { sourceText: sourceContext }
                    : {}),
                })
              );
            };

            ws.onmessage = (event) => {
              let msg: {
                type: string;
                text?: string;
                languageCode?: string;
                code?: number;
                message?: string;
              };
              try {
                msg = JSON.parse(String(event.data));
              } catch {
                return;
              }

              if (msg.type === "ready" && !settled) {
                settled = true;
                resolve({
                  ws,
                  setChunkHandlers: (next) => {
                    handlers = next;
                  },
                });
                return;
              }
              if (msg.type === "interim") {
                handlers.onInterim(msg.text ?? "");
                return;
              }
              if (msg.type === "transcript") {
                handlers.onTranscript(msg.text ?? "", msg.languageCode);
                return;
              }
              if (msg.type === "turnComplete") {
                handlers.onTurnComplete();
                return;
              }
              if (msg.type === "closed") {
                handlers.onClose(msg.code);
                return;
              }
              if (msg.type === "error") {
                const errMsg = msg.message || "Live transcription error.";
                if (!settled) {
                  settled = true;
                  reject(new Error(errMsg));
                } else {
                  handlers.onError(errMsg);
                }
              }
            };

            ws.onclose = (ev) => {
              if (!settled) {
                settled = true;
                reject(
                  new Error("Transcription WebSocket closed before ready.")
                );
              } else {
                handlers.onClose(ev.code);
              }
            };

            ws.onerror = () => {
              const errMsg = "WebSocket connection to transcription server failed.";
              if (!settled) {
                settled = true;
                reject(new Error(errMsg));
              } else {
                handlers.onError(errMsg);
              }
            };
          });

        const closeLiveConn = (
          conn: Awaited<ReturnType<typeof openLiveWs>> | null
        ) => {
          if (!conn) return;
          try {
            if (conn.ws.readyState === WebSocket.OPEN) {
              conn.ws.send(JSON.stringify({ type: "stop" }));
            }
          } catch {
            // ignore
          }
          setTimeout(() => {
            try {
              conn.ws.close();
            } catch {
              // ignore
            }
          }, 150);
        };

        const retryCounts: number[] = chunks.map(() => 0);
        const rawChunkTexts: string[] = chunks.map(() => "");
        const rawChunkLangs: Array<string | undefined> = chunks.map(
          () => undefined
        );
        const rawChunkComplete: boolean[] = chunks.map(() => false);
        const rawChunkRatio: number[] = chunks.map(() => 1);
        const activeChunksSet = new Set<number>();
        const completedSet = new Set<number>();
        const uploadStructuredWindows = new Map<
          number,
          StructuredWorkerWindow
        >();
        let uploadLmInFlight: Promise<void> | null = null;
        let fatalError: string | null = null;

        const runUploadLmRefinementPass = async () => {
          if (abortController.signal.aborted) return;
          if (uploadLmInFlight) {
            await uploadLmInFlight.catch(() => {});
            if (abortController.signal.aborted) return;
          }

          const executeUploadPass = async () => {
            const due = collectDueRefinementWindows(uploadStructuredWindows);
            if (due.length === 0) return;

            const currentSess = sessionsRef.current.find(
              (s) => s.id === newSession.id
            );
            const priorContext = buildPriorContextSnippet(
              currentSess?.segments ?? [],
              due[0].windowIndex,
              600,
              "chunkIndex"
            );

            try {
              const res = await fetch("/api/refine-transcript", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  windows: due,
                  priorContext,
                  languageCode: cfg.languageCode,
                  customVocabulary: cfg.customVocabulary,
                  scope: "upload_5w",
                }),
                signal: abortController.signal,
              });
              if (!res.ok) return;

              const data = (await res.json()) as {
                refinedWindows?: Array<{
                  windowIndex: number;
                  refinedText: string;
                  detectedLanguage?: string;
                }>;
              };

              if (
                abortController.signal.aborted ||
                !Array.isArray(data.refinedWindows) ||
                data.refinedWindows.length === 0
              ) {
                return;
              }

              for (const item of data.refinedWindows) {
                const entry = uploadStructuredWindows.get(item.windowIndex);
                if (entry) {
                  entry.lmRefined = true;
                }
              }

              const fallbackLang =
                lockedAutoLang ??
                (cfg.languageCode === "auto" ? undefined : cfg.languageCode);

              const detectedFromLm = data.refinedWindows
                .map((w) => w.detectedLanguage)
                .filter((l): l is string => Boolean(l));

              updateSessionById(newSession.id, (s) => {
                let mergedLangs = s.detectedLanguages;
                for (const nl of detectedFromLm) {
                  if (!mergedLangs.includes(nl)) {
                    mergedLangs = [...mergedLangs, nl];
                  }
                }
                return {
                  ...s,
                  segments: applyLmRefinedChunksToSegments(
                    s.segments,
                    uploadStructuredWindows,
                    data.refinedWindows!,
                    fallbackLang
                  ),
                  detectedLanguages: mergedLangs,
                  updatedAt: Date.now(),
                };
              });
            } catch {
              // Silent under the hood; pending chunks stay queued for next minute/flush
            }
          };

          const task = executeUploadPass().finally(() => {
            if (uploadLmInFlight === task) {
              uploadLmInFlight = null;
            }
          });
          uploadLmInFlight = task;
          await task;
        };

        const findChunkAtSec = (sec: number) => {
          const found = chunks.findIndex(
            (c) => sec >= c.startSec && sec < c.endSec
          );
          if (found >= 0) return found;
          return Math.min(
            chunks.length - 1,
            Math.max(0, Math.floor(sec / 15))
          );
        };

        const commitStitchedChunk = (idx: number) => {
          const raw = rawChunkTexts[idx];
          if (!raw || abortController.signal.aborted) return;
          const chunkObj = chunks[idx];
          const prevRaw = idx > 0 ? rawChunkTexts[idx - 1] : "";
          const stitched = cleanTranscriptArtifacts(
            prevRaw ? stitchChunkBoundary(prevRaw, raw) : raw
          );
          if (!stitched) return;

          const startMs = Math.round(
            (rawChunkComplete[idx]
              ? chunkObj.speechStartSec
              : chunkObj.startSec) * 1000
          );
          const actualEndSec = rawChunkComplete[idx]
            ? chunkObj.speechEndSec
            : Math.min(
                chunkObj.endSec,
                chunkObj.startSec +
                  (chunkObj.endSec - chunkObj.startSec) * rawChunkRatio[idx]
              );
          const endMs = Math.max(startMs + 600, Math.round(actualEndSec * 1000));
          const cues = splitTextIntoTimedCues(stitched, startMs, endMs);
          const langCode = rawChunkLangs[idx] ?? lockedAutoLang ?? undefined;

          const newSegments: TranscriptSegment[] = cues.map((cue, cueIdx) => ({
            id: `seg_chunk_${idx}_${cueIdx}_${Date.now()}`,
            text: cue.text,
            speakerId: "spk_1",
            languageCode: langCode,
            timestampMs: cue.startMs,
            endTimestampMs: cue.endMs,
            chunkIndex: idx,
          }));

          updateSessionById(newSession.id, (s) => ({
            ...s,
            segments: [
              ...s.segments.filter((seg) => seg.chunkIndex !== idx),
              ...newSegments,
            ].sort((a, b) => a.timestampMs - b.timestampMs),
            detectedLanguages:
              rawChunkLangs[idx] &&
              !s.detectedLanguages.includes(rawChunkLangs[idx]!)
                ? [...s.detectedLanguages, rawChunkLangs[idx]!]
                : s.detectedLanguages,
            updatedAt: Date.now(),
          }));
        };

        const syncProgressUI = () => {
          if (abortController.signal.aborted) return;
          if (isAudioPlayingRef.current || audioPlaybackEndedRef.current) {
            isPreBufferingRef.current = false;
          }
          const bufferingNow = isPreBufferingRef.current;
          const pausedNow =
            !bufferingNow &&
            !isAudioPlayingRef.current &&
            !audioPlaybackEndedRef.current;
          setChunkProgress({
            totalChunks: chunks.length,
            completedChunks: completedSet.size,
            completedChunkIndices: Array.from(completedSet).sort(
              (a, b) => a - b
            ),
            activeChunkIndices: pausedNow
              ? []
              : Array.from(activeChunksSet).sort((a, b) => a - b),
            waveCount,
            workerCount,
            readyWorkers: readyWorkerCount,
            preRollStage,
            isBuffering: bufferingNow,
            chunkDurationSec: 15,
            isProcessing: completedSet.size < chunks.length && !fatalError,
            isPaused: pausedNow,
            isAudioEnded: audioPlaybackEndedRef.current,
            error: fatalError,
          });
        };

        const maybeStartAutoPlayback = async () => {
          if (
            preRollCompleted ||
            !isPreBufferingRef.current ||
            abortController.signal.aborted
          ) {
            return;
          }
          if (allWorkersReady && completedSet.has(0)) {
            preRollCompleted = true;
            isPreBufferingRef.current = false;
            if (autoPlay && audioElRef.current) {
              try {
                await audioElRef.current.play();
                audioPlaybackEndedRef.current = false;
                isAudioPlayingRef.current = true;
                setIsAudioPlaying(true);
              } catch {
                isAudioPlayingRef.current = false;
                setIsAudioPlaying(false);
              }
            } else {
              isAudioPlayingRef.current = false;
              setIsAudioPlaying(false);
            }
            syncProgressUI();
          }
        };

        const pickFocusedSegment = (): number | null =>
          pickNextWaveSegment({
            totalChunks: chunks.length,
            completed: completedSet,
            active: activeChunksSet,
            isPreBuffering: isPreBufferingRef.current,
            isPlaying: isAudioPlayingRef.current,
            isAudioEnded: audioPlaybackEndedRef.current,
            playheadChunkIdx: findChunkAtSec(
              audioElRef.current?.currentTime ?? 0
            ),
          });

        const isFatalConfigError = (msg: string) => {
          const lower = msg.toLowerCase();
          return (
            lower.includes("api_key_invalid") ||
            lower.includes("invalid gemini_api_key") ||
            lower.includes("permission denied") ||
            lower.includes("not configured")
          );
        };

        // Pre-warm all 5 focused workers for the single current segment wave
        const PASS_MODES: Array<"VERBATIM" | "SMART"> = [
          "VERBATIM",
          "SMART",
          "VERBATIM",
          "SMART",
          cfg.mode,
        ];
        let preWarmedWaves: Array<
          Array<Awaited<ReturnType<typeof openLiveWs>> | null>
        > = [];
        if (waveCount > 0) {
          preWarmedWaves = await Promise.all(
            Array.from({ length: waveCount }, () =>
              Promise.all(
                Array.from({ length: WORKERS_PER_WAVE }, async (_, idx) => {
                  const modeForPass = PASS_MODES[idx] ?? cfg.mode;
                  const conn = await openLiveWs(
                    lockedAutoLang,
                    undefined,
                    modeForPass
                  );
                  readyWorkerCount += 1;
                  syncProgressUI();
                  return conn;
                })
              )
            )
          );
        }

        if (abortController.signal.aborted) {
          preWarmedWaves.forEach((wave) =>
            wave.forEach((c) => closeLiveConn(c))
          );
          return;
        }

        allWorkersReady = true;
        preRollStage = "transcribing";
        syncProgressUI();

        interface WorkerPassSpec {
          passId: number;
          waveType: "raw" | "hq" | "clarified";
          mode: "VERBATIM" | "SMART";
          intervalMs: number;
        }

        // 5 parallel workers focused on the single current segment at true 1.0x (128ms) speed:
        // 2 Raw Input Wave workers (VERBATIM + SMART) + 3 High-Quality Conditioned Wave workers
        const PASS_SPECS: WorkerPassSpec[] = [
          { passId: 0, waveType: "raw", mode: "VERBATIM", intervalMs: 128 },
          { passId: 1, waveType: "raw", mode: "SMART", intervalMs: 128 },
          { passId: 2, waveType: "hq", mode: "VERBATIM", intervalMs: 128 },
          { passId: 3, waveType: "hq", mode: "SMART", intervalMs: 128 },
          { passId: 4, waveType: "clarified", mode: cfg.mode, intervalMs: 128 },
        ];

        const runSinglePassOnSegment = async (
          targetIdx: number,
          spec: WorkerPassSpec,
          preConn: Awaited<ReturnType<typeof openLiveWs>> | null,
          forcedLangHint?: string | null
        ) => {
          const chunk = chunks[targetIdx];
          const packets =
            spec.waveType === "raw"
              ? chunk.rawPacketsBase64
              : spec.waveType === "clarified"
                ? chunk.clarifiedPacketsBase64
                : chunk.pcmPacketsBase64;
          const startSeekSeq = uploadSeekSeqRef.current;

          let conn: Awaited<ReturnType<typeof openLiveWs>> | null = null;
          let interruptedByControl = false;
          let packetsSent = 0;
          let passError: string | null = null;
          let turnCompleteReceived = false;
          let closeCode: number | undefined;
          const finalParts: string[] = [];
          let latestInterim = "";
          let detectedLang: string | undefined;

          try {
            const langToUse =
              forcedLangHint !== undefined ? forcedLangHint : lockedAutoLang;
            const prevSourceText =
              spec.mode === "SMART" &&
              targetIdx > 0 &&
              rawChunkTexts[targetIdx - 1]
                ? rawChunkTexts[targetIdx - 1].slice(-220)
                : undefined;

            if (preConn && preConn.ws.readyState === WebSocket.OPEN) {
              conn = preConn;
            } else {
              if (preConn) closeLiveConn(preConn);
              try {
                conn = await openLiveWs(langToUse, prevSourceText, spec.mode);
              } catch (openErr) {
                if (
                  langToUse &&
                  cfg.languageCode === "auto" &&
                  !isFatalConfigError(
                    openErr instanceof Error
                      ? openErr.message
                      : String(openErr)
                  )
                ) {
                  lockedAutoLang = null;
                  conn = await openLiveWs(null, prevSourceText, spec.mode);
                } else {
                  throw openErr;
                }
              }
            }

            let onActivitySignal: (() => void) | null = null;
            let onFinishSignal: (() => void) | null = null;

            conn.setChunkHandlers({
              onInterim: (txt) => {
                latestInterim = txt;
                onActivitySignal?.();
                if (spec.passId === 0 && isAudioPlayingRef.current) {
                  const nowChunk = findChunkAtSec(
                    audioElRef.current?.currentTime ?? 0
                  );
                  if (nowChunk === targetIdx) {
                    setInterimText(txt);
                  }
                }
              },
              onTranscript: (txt, lang) => {
                const cleaned = txt.trim();
                if (cleaned) {
                  finalParts.push(cleaned);
                  latestInterim = "";
                  if (spec.passId === 0) {
                    const nowChunk = findChunkAtSec(
                      audioElRef.current?.currentTime ?? 0
                    );
                    if (nowChunk === targetIdx) {
                      setInterimText("");
                    }
                  }
                }
                if (lang) detectedLang = lang;
                onActivitySignal?.();
              },
              onTurnComplete: () => {
                turnCompleteReceived = true;
                onFinishSignal?.();
              },
              onClose: (code) => {
                closeCode = code;
                onFinishSignal?.();
              },
              onError: (errMsg) => {
                passError = errMsg;
                onFinishSignal?.();
              },
            });

            // Stream 128ms PCM frames at natural 112-118ms mic cadence (~1.1x)
            for (let p = 0; p < packets.length; p++) {
              if (abortController.signal.aborted || passError) break;
              if (
                !isPreBufferingRef.current &&
                !isAudioPlayingRef.current &&
                !audioPlaybackEndedRef.current
              ) {
                interruptedByControl = true;
                break;
              }
              if (uploadSeekSeqRef.current !== startSeekSeq) {
                const seekedChunk = findChunkAtSec(
                  audioElRef.current?.currentTime ?? 0
                );
                if (
                  shouldInterruptWaveOnSeek(targetIdx, seekedChunk, completedSet)
                ) {
                  interruptedByControl = true;
                  break;
                }
              }
              if (conn.ws.readyState !== WebSocket.OPEN) {
                passError =
                  passError || "Live connection closed mid-segment.";
                break;
              }

              conn.ws.send(
                JSON.stringify({
                  type: "audio",
                  data: packets[p],
                })
              );
              packetsSent++;
              await new Promise((r) => setTimeout(r, spec.intervalMs));
            }

            if (
              !abortController.signal.aborted &&
              !passError &&
              conn.ws.readyState === WebSocket.OPEN
            ) {
              conn.ws.send(JSON.stringify({ type: "audioStreamEnd" }));

              await new Promise<void>((resolve) => {
                let settled = false;
                const idleDelay = interruptedByControl ? 450 : 2500;
                const maxDelay = interruptedByControl ? 750 : 9000;
                let idleTimer = window.setTimeout(() => done(), idleDelay);
                const maxTimer = window.setTimeout(() => done(), maxDelay);

                const done = () => {
                  if (settled) return;
                  settled = true;
                  window.clearTimeout(idleTimer);
                  window.clearTimeout(maxTimer);
                  onActivitySignal = null;
                  onFinishSignal = null;
                  resolve();
                };

                onActivitySignal = () => {
                  if (settled) return;
                  window.clearTimeout(idleTimer);
                  idleTimer = window.setTimeout(() => done(), idleDelay);
                };

                onFinishSignal = () => done();
              });
            }
          } catch (err) {
            passError =
              err instanceof Error ? err.message : "Worker connection error.";
          } finally {
            closeLiveConn(conn);
            conn = null;
          }

          const rawText = cleanTranscriptArtifacts(
            finalParts.length > 0 ? finalParts.join(" ") : latestInterim
          );
          const streamedMostlyComplete =
            !interruptedByControl ||
            packetsSent >= Math.floor(packets.length * 0.9);

          return {
            text: rawText,
            lang: detectedLang,
            isSmart: spec.mode === "SMART",
            passError,
            turnCompleteReceived,
            closeCode,
            streamedMostlyComplete,
            packetsRatio: packetsSent / Math.max(1, packets.length),
          };
        };

        const runWaveLoop = async (waveId: number) => {
          while (
            !abortController.signal.aborted &&
            !fatalError &&
            completedSet.size < chunks.length
          ) {
            const shouldRun =
              isPreBufferingRef.current ||
              isAudioPlayingRef.current ||
              audioPlaybackEndedRef.current;

            if (!shouldRun) {
              if (waveId === 0) {
                setInterimText("");
                syncProgressUI();
              }
              await new Promise((r) => setTimeout(r, 150));
              continue;
            }

            const targetIdx = pickFocusedSegment();
            if (targetIdx === null) {
              await new Promise((r) => setTimeout(r, 150));
              continue;
            }

            const chunk = chunks[targetIdx];
            activeChunksSet.add(targetIdx);
            syncProgressUI();

            if (!chunk.hasAudioSignal || chunk.pcmPacketsBase64.length === 0) {
              activeChunksSet.delete(targetIdx);
              completedSet.add(targetIdx);
              await maybeStartAutoPlayback();
              syncProgressUI();
              continue;
            }

            // Use this wave's 3 pre-warmed connections on its very first segment
            const wavePreConns = preWarmedWaves[waveId] ?? [];
            const passPreConns = PASS_SPECS.map((_, idx) => {
              const c = wavePreConns[idx] ?? null;
              wavePreConns[idx] = null;
              return c;
            });

            // Run all 5 focused workers TOGETHER on this single current 15s segment
            const results = await Promise.all(
              PASS_SPECS.map((spec, idx) =>
                runSinglePassOnSegment(targetIdx, spec, passPreConns[idx])
              )
            );

            if (abortController.signal.aborted) {
              activeChunksSet.delete(targetIdx);
              break;
            }

            if (
              !isAudioPlayingRef.current ||
              findChunkAtSec(audioElRef.current?.currentTime ?? 0) === targetIdx
            ) {
              setInterimText("");
            }

            const fatal = results.find(
              (r) => r.passError && isFatalConfigError(r.passError)
            );
            if (fatal?.passError) {
              fatalError = fatal.passError;
              activeChunksSet.delete(targetIdx);
              syncProgressUI();
              break;
            }

            const allCompletedRatio = results.reduce(
              (maxR, r) => Math.max(maxR, r.packetsRatio),
              0
            );
            const anyMostlyComplete = results.some(
              (r) => r.streamedMostlyComplete
            );

            // Reconcile across all 5 workers on this current 15s segment
            let reconciled = reconcileFocusedTranscripts(
              results.map((r) => ({
                text: r.text,
                lang: r.lang,
                isSmart: r.isSmart,
              })),
              lockedScriptFamily
            );

            // Lock dominant script/language from earliest segment
            const domScript = reconciled.text
              ? detectScriptFamily(reconciled.text)
              : null;
            if (
              cfg.languageCode === "auto" &&
              reconciled.text &&
              !lockedScriptFamily &&
              (targetIdx === 0 ||
                (targetIdx === 1 && !hasMixedLatinWithNonLatin(reconciled.text)) ||
                completedSet.size === 0)
            ) {
              lockedScriptFamily = domScript;
              lockedAutoLang =
                reconciled.lang ?? scriptFamilyToBcp47(domScript) ?? null;
            }

            // If locked to a non-Latin language (e.g. Amharic am-ET) and this segment drifted to Latin or mixed Latin, run 1 focused locked-lang verification pass!
            const driftedOffNonLatin =
              Boolean(lockedScriptFamily) &&
              lockedScriptFamily !== "latin" &&
              Boolean(reconciled.text) &&
              (hasMixedLatinWithNonLatin(reconciled.text) ||
                detectScriptFamily(reconciled.text) !== lockedScriptFamily);

            let verifiedSupplement = "";
            if (
              lockedAutoLang &&
              reconciled.text &&
              (driftedOffNonLatin ||
                (targetIdx === 0 &&
                  cfg.languageCode === "auto" &&
                  hasMixedLatinWithNonLatin(reconciled.text)))
            ) {
              const verified = await runSinglePassOnSegment(
                targetIdx,
                {
                  passId: 2,
                  waveType: "hq",
                  mode: cfg.mode,
                  intervalMs: 128,
                },
                null,
                lockedAutoLang
              );
              if (verified.text) {
                verifiedSupplement = verified.text;
              }
              if (
                verified.text &&
                detectScriptFamily(verified.text) === lockedScriptFamily &&
                !hasMixedLatinWithNonLatin(verified.text)
              ) {
                reconciled = {
                  text: verified.text,
                  lang: verified.lang ?? lockedAutoLang,
                };
              }
            }

            if (reconciled.text && !abortController.signal.aborted) {
              rawChunkTexts[targetIdx] = reconciled.text;
              rawChunkLangs[targetIdx] = reconciled.lang;
              rawChunkComplete[targetIdx] = anyMostlyComplete;
              rawChunkRatio[targetIdx] = allCompletedRatio;

              const cStartMs = Math.round(
                (anyMostlyComplete ? chunk.speechStartSec : chunk.startSec) *
                  1000
              );
              const cActualEndSec = anyMostlyComplete
                ? chunk.speechEndSec
                : Math.min(
                    chunk.endSec,
                    chunk.startSec +
                      (chunk.endSec - chunk.startSec) * allCompletedRatio
                  );
              const cEndMs = Math.max(
                cStartMs + 600,
                Math.round(cActualEndSec * 1000)
              );

              upsertUploadWorkerObservations(
                uploadStructuredWindows,
                targetIdx,
                cStartMs,
                cEndMs,
                {
                  worker0RawPrimary: results[0]?.text ?? "",
                  worker1RawContrast: results[1]?.text ?? "",
                  worker2HqVerbatim: verifiedSupplement || (results[2]?.text ?? ""),
                  worker3HqSmart: results[3]?.text ?? "",
                  worker4HqClarified: results[4]?.text ?? "",
                }
              );

              commitStitchedChunk(targetIdx);
              if (
                targetIdx + 1 < chunks.length &&
                rawChunkTexts[targetIdx + 1]
              ) {
                commitStitchedChunk(targetIdx + 1);
              }
            }

            const abnormalDropWithoutText =
              !reconciled.text &&
              results.some(
                (r) =>
                  Boolean(r.passError) ||
                  (!r.turnCompleteReceived &&
                    r.closeCode !== undefined &&
                    r.closeCode !== 1000 &&
                    r.closeCode !== 1005)
              );

            activeChunksSet.delete(targetIdx);

            if (!anyMostlyComplete) {
              // Interrupted by pause/seek — retry this segment cleanly on resume
              syncProgressUI();
              continue;
            }

            if (abnormalDropWithoutText && retryCounts[targetIdx] < 1) {
              retryCounts[targetIdx] += 1;
              syncProgressUI();
              await new Promise((r) => setTimeout(r, 400));
              continue;
            }

            completedSet.add(targetIdx);
            await maybeStartAutoPlayback();
            syncProgressUI();
          }
        };

        const uploadLmTimer = window.setInterval(() => {
          void runUploadLmRefinementPass();
        }, LIVE_LM_INTERVAL_MS);

        try {
          if (waveCount > 0) {
            await Promise.all(
              Array.from({ length: waveCount }, (_, waveId) =>
                runWaveLoop(waveId)
              )
            );
          }
        } finally {
          window.clearInterval(uploadLmTimer);
          preWarmedWaves.forEach((wave) =>
            wave.forEach((c) => closeLiveConn(c))
          );
        }

        if (!fatalError && !abortController.signal.aborted) {
          await runUploadLmRefinementPass();
        }

        setInterimText("");

        if (fatalError && !abortController.signal.aborted) {
          throw new Error(fatalError);
        }

        if (!abortController.signal.aborted) {
          isPreBufferingRef.current = false;
          syncProgressUI();
        }
      } catch (err) {
        if (abortController.signal.aborted) return;
        isPreBufferingRef.current = false;
        setInterimText("");
        const msg =
          err instanceof Error
            ? err.message
            : "Failed to transcribe uploaded audio.";
        setErrorMessage(msg);
        setChunkProgress((prev) =>
          prev
            ? {
                ...prev,
                isProcessing: false,
                isBuffering: false,
                activeChunkIndices: [],
                error: msg,
              }
            : prev
        );
      }
    },
    [activeSession.config, detachUploadedAudio, updateSessionById]
  );

  const handleSeekAudioMs = useCallback((ms: number) => {
    if (isPreBufferingRef.current) return;
    const audio = audioElRef.current;
    if (!audio) return;
    uploadSeekSeqRef.current += 1;
    audioPlaybackEndedRef.current = false;
    isPreBufferingRef.current = false;
    setInterimText("");
    audio.currentTime = Math.max(0, ms / 1000);
    setPlaybackTimeMs(ms);
    if (audio.paused) {
      isAudioPlayingRef.current = true;
      setIsAudioPlaying(true);
      setChunkProgress((prev) =>
        prev ? { ...prev, isBuffering: false, isPaused: false } : prev
      );
      void audio.play().catch(() => {
        isAudioPlayingRef.current = false;
        setIsAudioPlaying(false);
      });
    }
  }, []);

  const handleStopAudio = useCallback(() => {
    if (isPreBufferingRef.current) return;
    const audio = audioElRef.current;
    uploadSeekSeqRef.current += 1;
    audioPlaybackEndedRef.current = false;
    isAudioPlayingRef.current = false;
    isPreBufferingRef.current = false;
    setIsAudioPlaying(false);
    setInterimText("");
    setChunkProgress((prev) =>
      prev
        ? {
            ...prev,
            isBuffering: false,
            activeChunkIndices: [],
            isPaused: true,
            isAudioEnded: false,
          }
        : prev
    );
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    setPlaybackTimeMs(0);
  }, []);

  // Keyboard shortcut: Space to toggle audio player or mic recording
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        tag === "BUTTON"
      ) {
        return;
      }
      e.preventDefault();
      if (uploadedAudio?.sessionId === activeSessionId && audioElRef.current) {
        if (isPreBufferingRef.current) return;
        if (audioElRef.current.paused) {
          void audioElRef.current.play().catch(() => {});
        } else {
          audioElRef.current.pause();
        }
        return;
      }
      if (connectionState === "idle" || connectionState === "error") {
        void startRecording();
      } else if (connectionState === "listening" || connectionState === "paused") {
        togglePause();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeSessionId,
    connectionState,
    startRecording,
    togglePause,
    uploadedAudio,
  ]);

  const handleNewSession = () => {
    if (isActiveLive) {
      stopRecording();
    }
    detachUploadedAudio();
    const fresh = createEmptySession(activeSession.config);
    setSessions((prev) => [fresh, ...prev]);
    setActiveSessionId(fresh.id);
    setLiveDurationMs(0);
    setErrorMessage(null);
    setActiveTab("transcript");
  };

  const handleDeleteSession = (id: string) => {
    if (livePipelineRef.current.targetSessionId === id) {
      if (isActiveLive) {
        stopRecording();
      }
      liveRefineAbortRef.current?.abort();
      livePipelineRef.current.refiningWindowsCount = 0;
      setLiveRefinementStatus(null);
    }
    if (uploadedAudio?.sessionId === id) {
      detachUploadedAudio();
    }
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (next.length === 0) {
        const fallback = createEmptySession();
        setActiveSessionId(fallback.id);
        return [fallback];
      }
      if (id === activeSessionId) {
        setActiveSessionId(next[0].id);
      }
      return next;
    });
  };

  const handleUpdateConfig = (partial: Partial<TranscriptionConfig>) => {
    updateSessionById(activeSession.id, (s) => ({
      ...s,
      config: { ...s.config, ...partial },
    }));
  };

  const handleUpdateSegmentText = (segmentId: string, newText: string) => {
    updateSessionById(activeSession.id, (s) => ({
      ...s,
      updatedAt: Date.now(),
      segments: s.segments.map((seg) =>
        seg.id === segmentId ? { ...seg, text: newText, isEdited: true } : seg
      ),
    }));
  };

  const handleSaveNotes = (notes: SessionNotes) => {
    updateSessionById(activeSession.id, (s) => ({
      ...s,
      updatedAt: Date.now(),
      notes,
    }));
  };

  const handleCopyAll = async () => {
    const { content } = buildExportContent(activeSession, "txt");
    if (!content) return;
    await navigator.clipboard.writeText(content);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1600);
  };

  const handleExport = (format: "txt" | "md" | "srt" | "json") => {
    const { content, mimeType, extension } = buildExportContent(
      activeSession,
      format
    );
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeName = (activeSession.title || "transcript")
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-");
    a.href = url;
    a.download = `${safeName}.${extension}`;
    a.click();
    URL.revokeObjectURL(url);
    setIsExportOpen(false);
  };

  const displayedDuration =
    connectionState === "listening" || connectionState === "paused"
      ? liveDurationMs
      : activeSession.durationMs;

  const isActiveLive =
    connectionState === "listening" ||
    connectionState === "paused" ||
    connectionState === "connecting";

  const hasPlayerForActiveSession =
    uploadedAudio !== null && uploadedAudio.sessionId === activeSession.id;

  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden bg-slate-100 text-slate-900 dark:bg-[#030816] dark:text-slate-100">
      {/* Ambient luminous sapphire arc radiating behind the centered glass stage (Reference 1) */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 overflow-hidden"
      >
        <div className="absolute bottom-[-220px] left-1/2 h-[540px] w-[540px] -translate-x-1/2 rounded-full border-[14px] border-sky-400/20 blur-md sm:bottom-[-180px] sm:h-[680px] sm:w-[680px] dark:border-[#3b82f6]/55 dark:shadow-[0_0_64px_12px_rgba(37,99,235,0.48)]" />
        <div className="absolute bottom-[-216px] left-1/2 h-[532px] w-[532px] -translate-x-1/2 rounded-full border-[2px] border-sky-200/25 sm:bottom-[-176px] sm:h-[672px] sm:w-[672px] dark:border-sky-200/50" />
        <div className="absolute bottom-[-120px] left-1/2 h-[380px] w-[620px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle_at_50%_55%,rgba(37,99,235,0.16),transparent_68%)] dark:bg-[radial-gradient(circle_at_50%_55%,rgba(37,99,235,0.42),transparent_68%)]" />
      </div>

      <Sidebar
        sessions={sessions}
        activeSessionId={activeSession.id}
        connectionState={connectionState}
        config={activeSession.config}
        isOpen={isDrawerOpen}
        audioDevices={audioDevices}
        selectedDeviceId={selectedDeviceId}
        onSelectDevice={setSelectedDeviceId}
        onClose={() => setIsDrawerOpen(false)}
        onSelectSession={(id) => {
          if (uploadedAudio && uploadedAudio.sessionId !== id) {
            detachUploadedAudio();
          }
          setActiveSessionId(id);
          setErrorMessage(null);
        }}
        onNewSession={handleNewSession}
        onDeleteSession={handleDeleteSession}
        onUpdateConfig={handleUpdateConfig}
        onOpenUploadModal={() => setIsUploadOpen(true)}
      />

      {/* Minimalist Icon-Only Top Bar */}
      <header className="relative z-20 flex h-14 shrink-0 items-center justify-between gap-2 px-3 sm:gap-4 sm:px-6">
        {/* Zone 1: Drawer, New Session, Upload */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setIsDrawerOpen(true)}
            aria-label="Open sessions and settings"
            title="Sessions & settings"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-300/70 bg-white/75 text-slate-700 backdrop-blur-md transition-colors hover:bg-white dark:border-white/12 dark:bg-white/[0.05] dark:text-slate-200 dark:hover:bg-white/15"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={isActiveLive}
            onClick={handleNewSession}
            aria-label="New session"
            title="New session"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-300/70 bg-white/75 text-slate-700 backdrop-blur-md transition-colors hover:bg-white disabled:opacity-40 dark:border-white/12 dark:bg-white/[0.05] dark:text-slate-200 dark:hover:bg-white/15"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {/* Zone 2: Transcript / Notes icon-only segmented switch */}
        <div className="flex items-center gap-1 rounded-full border border-slate-300/70 bg-white/75 p-1 backdrop-blur-md dark:border-white/12 dark:bg-white/[0.05]">
          <button
            type="button"
            onClick={() => setActiveTab("transcript")}
            aria-label="Transcript view"
            title="Transcript"
            className={`flex h-7 w-10 items-center justify-center rounded-full transition-colors ${
              activeTab === "transcript"
                ? "bg-sky-500 text-white shadow-xs"
                : "text-slate-500 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
            }`}
          >
            <AudioLines className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("notes")}
            aria-label="Notes view"
            title="Notes"
            className={`flex h-7 w-10 items-center justify-center rounded-full transition-colors ${
              activeTab === "notes"
                ? "bg-sky-500 text-white shadow-xs"
                : "text-slate-500 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Zone 3: Search, Copy, Export, Theme (icon-only) */}
        <div className="flex items-center gap-1.5 shrink-0">
          {isSearchOpen ? (
            <div className="flex items-center rounded-full border border-slate-300/80 bg-white/85 px-2.5 backdrop-blur-md dark:border-white/15 dark:bg-white/[0.08]">
              <Search className="h-3.5 w-3.5 text-slate-400" />
              <input
                type="text"
                autoFocus
                aria-label="Search transcript text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 w-24 bg-transparent px-2 text-xs text-slate-900 focus:outline-none sm:w-36 dark:text-white"
              />
              <button
                type="button"
                onClick={() => {
                  setSearchQuery("");
                  setIsSearchOpen(false);
                }}
                aria-label="Clear search"
                title="Clear search"
                className="text-slate-400 hover:text-slate-700 dark:hover:text-white"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsSearchOpen(true)}
              aria-label="Search transcript"
              title="Search"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-300/70 bg-white/75 text-slate-700 backdrop-blur-md transition-colors hover:bg-white dark:border-white/12 dark:bg-white/[0.05] dark:text-slate-200 dark:hover:bg-white/15"
            >
              <Search className="h-4 w-4" />
            </button>
          )}

          <button
            type="button"
            onClick={handleCopyAll}
            disabled={activeSession.segments.length === 0}
            aria-label="Copy transcript"
            title="Copy"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-300/70 bg-white/75 text-slate-700 backdrop-blur-md transition-colors hover:bg-white disabled:opacity-40 dark:border-white/12 dark:bg-white/[0.05] dark:text-slate-200 dark:hover:bg-white/15"
          >
            {copiedAll ? (
              <Check className="h-4 w-4 text-emerald-400" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </button>

          <div className="relative">
            <button
              type="button"
              disabled={activeSession.segments.length === 0}
              onClick={() => setIsExportOpen((o) => !o)}
              aria-label="Export transcript"
              title="Export"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-300/70 bg-white/75 text-slate-700 backdrop-blur-md transition-colors hover:bg-white disabled:opacity-40 dark:border-white/12 dark:bg-white/[0.05] dark:text-slate-200 dark:hover:bg-white/15"
            >
              <Download className="h-4 w-4" />
            </button>
            {isExportOpen && (
              <>
                <div
                  onClick={() => setIsExportOpen(false)}
                  className="fixed inset-0 z-20"
                />
                <div className="absolute right-0 z-30 mt-2 flex flex-col gap-1 rounded-2xl border border-slate-200/80 bg-white/95 p-1.5 shadow-xl backdrop-blur-xl dark:border-white/12 dark:bg-[#081229]/95">
                  {(
                    [
                      { id: "txt", label: "TXT", Icon: FileText },
                      { id: "md", label: "MD", Icon: FileCode },
                      { id: "srt", label: "SRT", Icon: Subtitles },
                      { id: "json", label: "JSON", Icon: FileJson },
                    ] as const
                  ).map(({ id, label, Icon }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => handleExport(id)}
                      aria-label={`Export ${label}`}
                      title={`Export .${id}`}
                      className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
                    >
                      <Icon className="h-4 w-4" />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => setIsDark((d) => !d)}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            title={isDark ? "Light mode" : "Dark mode"}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-300/70 bg-white/75 text-slate-700 backdrop-blur-md transition-colors hover:bg-white dark:border-white/12 dark:bg-white/[0.05] dark:text-slate-200 dark:hover:bg-white/15"
          >
            {isDark ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </button>
        </div>
      </header>

      {/* Main Centered Frosted Glass Stage + Docked Reference-2 Console */}
      <main className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center px-3 pb-4 pt-1 sm:px-6 sm:pb-6">
        <div className="relative flex min-h-0 w-full max-w-[640px] flex-1 flex-col overflow-hidden rounded-[28px] border border-slate-200/80 bg-white/85 shadow-xl backdrop-blur-2xl dark:border-white/[0.11] dark:bg-transparent dark:bg-gradient-to-b dark:from-[#08132d]/68 dark:via-[#050d22]/78 dark:to-[#0c2d85]/84 dark:shadow-[0_24px_80px_-12px_rgba(12,56,180,0.55)]">
          {/* Top-right contextual close button (Reference 1 corner orb) */}
          {(isActiveLive || hasPlayerForActiveSession || activeTab === "notes") && (
            <button
              type="button"
              onClick={() => {
                if (isActiveLive) {
                  stopRecording();
                } else if (hasPlayerForActiveSession) {
                  detachUploadedAudio();
                } else {
                  setActiveTab("transcript");
                }
              }}
              aria-label={
                isActiveLive
                  ? "Stop recording"
                  : hasPlayerForActiveSession
                    ? "Close audio player"
                    : "Close notes"
              }
              title={
                isActiveLive
                  ? "Stop"
                  : hasPlayerForActiveSession
                    ? "Close audio"
                    : "Transcript"
              }
              className="absolute right-3.5 top-3.5 z-20 flex h-8 w-8 items-center justify-center rounded-full border border-slate-300/60 bg-white/75 text-slate-600 backdrop-blur-md transition-colors hover:bg-white dark:border-white/15 dark:bg-white/10 dark:text-slate-200 dark:hover:bg-white/20"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}

          {/* Error banner */}
          {errorMessage && (
            <div className="flex items-center justify-between gap-3 border-b border-rose-500/25 bg-rose-500/10 px-5 py-2.5 text-xs text-rose-600 dark:text-rose-200">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{errorMessage}</span>
              </div>
              <button
                type="button"
                onClick={() => setErrorMessage(null)}
                aria-label="Dismiss error"
                className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-rose-500/15"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Synced Audio Player Stage when file uploaded */}
          {hasPlayerForActiveSession &&
            uploadedAudio &&
            activeTab === "transcript" && (
              <AudioPlayerStage
                audioUrl={uploadedAudio.url}
                audioRef={audioElRef}
                fileName={uploadedAudio.fileName}
                segments={activeSession.segments}
                interimText={interimText}
                currentTimeMs={playbackTimeMs}
                durationMs={uploadedAudio.durationMs || activeSession.durationMs}
                isPlaying={isAudioPlaying}
                chunkProgress={chunkProgress}
                onTimeUpdate={setPlaybackTimeMs}
                onDurationChange={(ms) =>
                  setUploadedAudio((prev) =>
                    prev ? { ...prev, durationMs: ms } : prev
                  )
                }
                onPlayStateChange={(playing, ended) => {
                  if (playing) {
                    audioPlaybackEndedRef.current = false;
                    isAudioPlayingRef.current = true;
                    isPreBufferingRef.current = false;
                    setIsAudioPlaying(true);
                    setChunkProgress((prev) =>
                      prev
                        ? { ...prev, isBuffering: false, isPaused: false }
                        : prev
                    );
                  } else if (ended) {
                    audioPlaybackEndedRef.current = true;
                    isAudioPlayingRef.current = false;
                    isPreBufferingRef.current = false;
                    setIsAudioPlaying(false);
                    setChunkProgress((prev) =>
                      prev
                        ? {
                            ...prev,
                            isBuffering: false,
                            isPaused: false,
                            isAudioEnded: true,
                          }
                        : prev
                    );
                  } else {
                    audioPlaybackEndedRef.current = false;
                    isAudioPlayingRef.current = false;
                    isPreBufferingRef.current = false;
                    setIsAudioPlaying(false);
                    setChunkProgress((prev) =>
                      prev
                        ? {
                            ...prev,
                            isBuffering: false,
                            isPaused: true,
                            activeChunkIndices: [],
                          }
                        : prev
                    );
                  }
                }}
                onSeekToMs={handleSeekAudioMs}
                onStopAudio={handleStopAudio}
                onCloseAudio={detachUploadedAudio}
              />
            )}

          {/* Transcript or Notes viewport */}
          {activeTab === "transcript" ? (
            <TranscriptStream
              session={activeSession}
              interimText={interimText}
              connectionState={connectionState}
              searchQuery={searchQuery}
              hasAudioPlayer={hasPlayerForActiveSession}
              playbackTimeMs={playbackTimeMs}
              isAudioPlaying={isAudioPlaying}
              chunkProgress={
                hasPlayerForActiveSession ? chunkProgress : null
              }
              onSeekAudioMs={handleSeekAudioMs}
              onUpdateSegmentText={handleUpdateSegmentText}
            />
          ) : (
            <NotesPanel session={activeSession} onSaveNotes={handleSaveNotes} />
          )}

          {/* Integrated Luminous Sine-Wave Visualizer (Reference 1) */}
          {activeTab === "transcript" && !hasPlayerForActiveSession && (
            <div className="shrink-0 px-5 pb-3 pt-1">
              <WaveformVisualizer
                analyser={analyserNode}
                state={connectionState}
                isDark={isDark}
              />
            </div>
          )}
        </div>

        {/* Reference-2 Inspired Docked Icon-Only Control Capsule */}
        <footer className="relative z-20 mt-3 w-full max-w-[490px] shrink-0">
          <div className="overflow-visible rounded-[28px] border border-slate-200/80 bg-white/95 shadow-[0_18px_45px_rgba(2,8,23,0.18)] backdrop-blur-2xl dark:border-white/12 dark:bg-[#07090e] dark:shadow-[0_20px_50px_rgba(0,0,0,0.75)]">
            {/* Upper glowing sapphire display strip with hairline rolling-10s / upload progress */}
            <div className="relative flex h-8 items-center justify-between overflow-hidden rounded-t-[27px] bg-gradient-to-r from-[#0ea5e9] via-[#1565ef] to-[#0838b5] px-5 text-white/90">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-[linear-gradient(125deg,rgba(255,255,255,0.28)_0%,rgba(255,255,255,0.08)_38%,transparent_42%)]"
              />
              {!hasPlayerForActiveSession && liveRefinementStatus && (
                <div
                  aria-hidden="true"
                  className="absolute inset-x-0 bottom-0 h-[2px] bg-black/20"
                >
                  <div
                    className={`h-full transition-all duration-200 ${
                      liveRefinementStatus.refiningWindowsCount > 0
                        ? "bg-emerald-300"
                        : "bg-white/90"
                    }`}
                    style={{
                      width: `${Math.min(
                        100,
                        Math.max(
                          0,
                          (liveRefinementStatus.bufferElapsedMs /
                            Math.max(1, liveRefinementStatus.bufferDurationMs)) *
                            100
                        )
                      )}%`,
                    }}
                  />
                </div>
              )}

              <div className="relative z-10 flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
                {connectionState === "listening" && (
                  <span
                    className={`h-1.5 w-1.5 rounded-full animate-pulse ${
                      liveRefinementStatus?.liveWorkerStatus === "dropped"
                        ? "bg-amber-300"
                        : "bg-white"
                    }`}
                  />
                )}
                {liveRefinementStatus &&
                  liveRefinementStatus.refiningWindowsCount > 0 && (
                    <Loader2 className="h-3 w-3 animate-spin text-emerald-200" />
                  )}
                {(displayedDuration > 0 ||
                  isActiveLive ||
                  hasPlayerForActiveSession) && (
                  <span>
                    {formatDuration(
                      hasPlayerForActiveSession
                        ? playbackTimeMs
                        : displayedDuration
                    )}
                  </span>
                )}
              </div>

              <div className="relative z-10 flex items-center gap-1.5">
                {hasPlayerForActiveSession && chunkProgress ? (
                  chunkProgress.isProcessing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-white/90" />
                  ) : null
                ) : activeSession.config.mode === "VERBATIM" ? (
                  <span
                    title={`Verbatim · ${activeSession.config.languageCode.toUpperCase()}`}
                    aria-label="Verbatim mode"
                  >
                    <AudioWaveform className="h-3.5 w-3.5 opacity-85" />
                  </span>
                ) : (
                  <span
                    title={`Smart clean · ${activeSession.config.languageCode.toUpperCase()}`}
                    aria-label="Smart clean mode"
                  >
                    <Sparkles className="h-3.5 w-3.5 opacity-85" />
                  </span>
                )}
              </div>
            </div>

            {/* Lower matte capsule housing with Left Capsule · Raised Center Orb · Right Capsule */}
            <div className="relative flex items-center justify-between px-4 py-2.5 sm:px-5">
              {/* Left Capsule Button (icon-only) */}
              {hasPlayerForActiveSession ? (
                <button
                  type="button"
                  disabled={Boolean(chunkProgress?.isBuffering)}
                  onClick={handleStopAudio}
                  aria-label="Stop audio"
                  title="Stop"
                  className="flex h-10 w-20 items-center justify-center rounded-full border border-slate-300/80 bg-slate-100/80 text-slate-700 transition-colors hover:border-sky-400/60 hover:bg-slate-200/70 disabled:opacity-40 sm:w-28 dark:border-white/25 dark:bg-white/[0.03] dark:text-slate-100 dark:hover:border-white/50 dark:hover:bg-white/[0.08]"
                >
                  <Square className="h-4 w-4 fill-current" />
                </button>
              ) : isActiveLive ? (
                <button
                  type="button"
                  onClick={togglePause}
                  aria-label={
                    connectionState === "paused"
                      ? "Resume recording"
                      : "Pause recording"
                  }
                  title={connectionState === "paused" ? "Resume" : "Pause"}
                  className="flex h-10 w-20 items-center justify-center rounded-full border border-slate-300/80 bg-slate-100/80 text-slate-700 transition-colors hover:border-sky-400/60 hover:bg-slate-200/70 sm:w-28 dark:border-white/25 dark:bg-white/[0.03] dark:text-slate-100 dark:hover:border-white/50 dark:hover:bg-white/[0.08]"
                >
                  {connectionState === "paused" ? (
                    <Play className="h-4 w-4 translate-x-[0.5px] fill-current" />
                  ) : (
                    <Pause className="h-4 w-4 fill-current" />
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsDrawerOpen(true)}
                  aria-label="Engine settings"
                  title="Settings"
                  className="flex h-10 w-20 items-center justify-center rounded-full border border-slate-300/80 bg-slate-100/80 text-slate-700 transition-colors hover:border-sky-400/60 hover:bg-slate-200/70 sm:w-28 dark:border-white/25 dark:bg-white/[0.03] dark:text-slate-100 dark:hover:border-white/50 dark:hover:bg-white/[0.08]"
                >
                  <SlidersHorizontal className="h-4 w-4" />
                </button>
              )}

              {/* Center Raised Circular Orb Button (Reference 2 Focal Anchor) */}
              <div className="relative -mt-6 flex items-center justify-center">
                {hasPlayerForActiveSession ? (
                  <button
                    type="button"
                    disabled={Boolean(chunkProgress?.isBuffering)}
                    onClick={() => {
                      if (isPreBufferingRef.current) return;
                      const audio = audioElRef.current;
                      if (!audio) return;
                      if (audio.paused) {
                        void audio.play();
                      } else {
                        audio.pause();
                      }
                    }}
                    aria-label={isAudioPlaying ? "Pause playback" : "Play playback"}
                    title={isAudioPlaying ? "Pause" : "Play"}
                    className="flex h-14 w-14 items-center justify-center rounded-full border-[4px] border-white bg-gradient-to-b from-[#22c3ff] via-[#126cf1] to-[#0838b5] text-white shadow-[0_0_26px_rgba(29,110,242,0.65)] transition-transform hover:scale-105 active:scale-95 disabled:opacity-45 dark:border-[#07090e]"
                  >
                    {isAudioPlaying ? (
                      <Pause className="h-5 w-5 fill-current" />
                    ) : (
                      <Play className="h-5 w-5 translate-x-[1px] fill-current" />
                    )}
                  </button>
                ) : isActiveLive ? (
                  <button
                    type="button"
                    onClick={stopRecording}
                    aria-label="Stop recording"
                    title="Stop recording"
                    className="flex h-14 w-14 items-center justify-center rounded-full border-[4px] border-white bg-white text-[#06122e] shadow-[0_0_30px_rgba(56,189,248,0.85)] transition-transform hover:scale-105 active:scale-95 dark:border-[#07090e]"
                  >
                    <Square className="h-5 w-5 fill-current" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={startRecording}
                    aria-label="Start recording"
                    title="Start recording"
                    className="flex h-14 w-14 items-center justify-center rounded-full border-[4px] border-white bg-gradient-to-b from-[#22c3ff] via-[#126cf1] to-[#0838b5] text-white shadow-[0_0_26px_rgba(29,110,242,0.65)] transition-transform hover:scale-105 active:scale-95 dark:border-[#07090e]"
                  >
                    <Mic className="h-5 w-5" />
                  </button>
                )}
              </div>

              {/* Right Capsule Button (icon-only) */}
              {hasPlayerForActiveSession ? (
                <button
                  type="button"
                  onClick={detachUploadedAudio}
                  aria-label="Close audio"
                  title="Close audio"
                  className="flex h-10 w-20 items-center justify-center rounded-full border border-slate-300/80 bg-slate-100/80 text-slate-700 transition-colors hover:border-sky-400/60 hover:bg-slate-200/70 sm:w-28 dark:border-white/25 dark:bg-white/[0.03] dark:text-slate-100 dark:hover:border-white/50 dark:hover:bg-white/[0.08]"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : isActiveLive ? (
                <button
                  type="button"
                  onClick={handleCopyAll}
                  disabled={activeSession.segments.length === 0}
                  aria-label="Copy transcript"
                  title="Copy transcript"
                  className="flex h-10 w-20 items-center justify-center rounded-full border border-slate-300/80 bg-slate-100/80 text-slate-700 transition-colors hover:border-sky-400/60 hover:bg-slate-200/70 disabled:opacity-40 sm:w-28 dark:border-white/25 dark:bg-white/[0.03] dark:text-slate-100 dark:hover:border-white/50 dark:hover:bg-white/[0.08]"
                >
                  {copiedAll ? (
                    <Check className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsUploadOpen(true)}
                  aria-label="Upload audio"
                  title="Upload audio"
                  className="flex h-10 w-20 items-center justify-center rounded-full border border-slate-300/80 bg-slate-100/80 text-slate-700 transition-colors hover:border-sky-400/60 hover:bg-slate-200/70 sm:w-28 dark:border-white/25 dark:bg-white/[0.03] dark:text-slate-100 dark:hover:border-white/50 dark:hover:bg-white/[0.08]"
                >
                  <FileAudio className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </footer>
      </main>

      <UploadAudioModal
        isOpen={isUploadOpen}
        onClose={() => setIsUploadOpen(false)}
        onStartLiveChunkedUpload={handleStartLiveChunkedUpload}
      />
    </div>
  );
}
