import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  Menu,
  Mic,
  Moon,
  Pause,
  Play,
  Search,
  Square,
  Sun,
  X,
} from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { TranscriptStream } from "./components/TranscriptStream";
import { NotesPanel, UploadAudioModal } from "./components/NotesPanel";
import { WaveformVisualizer } from "./components/WaveformVisualizer";
import { AudioPlayerStage } from "./components/AudioPlayerStage";
import {
  LANGUAGE_OPTIONS,
  type ConnectionState,
  type SessionNotes,
  type TranscriptSegment,
  type TranscriptionConfig,
  type TranscriptionSession,
  type UploadedChunkProgress,
  type WordTiming,
} from "./types/transcribe";
import {
  AUDIO_WORKLET_SOURCE,
  buildExportContent,
  cleanTranscriptArtifacts,
  countWords,
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

const STORAGE_KEY = "transcribe_live_sessions_v1";
const THEME_KEY = "transcribe_live_theme_v1";

function createDefaultConfig(): TranscriptionConfig {
  return {
    mode: "VERBATIM",
    languageCode: "auto",
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
  const [isSidebarOpenMobile, setIsSidebarOpenMobile] = useState(false);
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
      if (saved === "dark") return true;
      if (saved === "light") return false;
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
      return false;
    }
  });

  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);

  // Refs for audio/WebSocket lifecycle without stale closures
  const wsRef = useRef<WebSocket | null>(null);
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
    const targetSessionId = activeSessionIdRef.current;
    const totalElapsed =
      accumulatedMsRef.current +
      (!isPausedRef.current && runStartRef.current > 0
        ? Date.now() - runStartRef.current
        : 0);

    updateSessionById(targetSessionId, (s) => ({
      ...s,
      durationMs: Math.max(s.durationMs, totalElapsed),
      updatedAt: Date.now(),
    }));

    setConnectionState("stopping");
    isPausedRef.current = false;

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ type: "stop" }));
      } catch {
        // ignore
      }
      const closingWs = wsRef.current;
      wsRef.current = null;
      setTimeout(() => {
        try {
          closingWs.close();
        } catch {
          // ignore
        }
      }, 300);
    } else if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    }

    cleanupAudioPipeline();
    setInterimText("");
    setInterimSpeaker("");
    setInterimLanguage("");
    setConnectionState("idle");
  }, [cleanupAudioPipeline, updateSessionById]);

  useEffect(() => {
    return () => {
      cleanupAudioPipeline();
      uploadAbortRef.current?.abort();
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore
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
    accumulatedMsRef.current = currentSess.durationMs;
    setLiveDurationMs(currentSess.durationMs);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "Microphone access is not supported in this browser context."
        );
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      void refreshAudioDevices();

      const audioCtx = new AudioContext({ sampleRate: 16000 });
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

      const sendPcmChunk = (float32: Float32Array) => {
        if (isPausedRef.current) return;
        const activeWs = wsRef.current;
        if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
        const downsampled = downsampleBuffer(
          float32,
          audioCtx.sampleRate,
          16000
        );
        const base64 = float32ToBase64Pcm16(downsampled);
        activeWs.send(JSON.stringify({ type: "audio", data: base64 }));
      };

      const attachMicSocket = (isReplacement: boolean) => {
        const ws = new WebSocket(wsEndpoint);
        if (!isReplacement) {
          wsRef.current = ws;
        }

        ws.onopen = () => {
          const cfg = currentSess.config;
          ws.send(
            JSON.stringify({
              type: "start",
              mode: cfg.mode,
              languageCodes:
                cfg.languageCode === "auto" ? [] : [cfg.languageCode],
              customVocabulary: cfg.customVocabulary,
            })
          );
        };

        ws.onmessage = (event) => {
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
            if (isReplacement) {
              const previousWs = wsRef.current;
              wsRef.current = ws;
              rotatingSocket = false;
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

            setConnectionState("listening");
            runStartRef.current = Date.now();
            if (liveTimerRef.current === null) {
              liveTimerRef.current = window.setInterval(() => {
                if (!isPausedRef.current && runStartRef.current > 0) {
                  const elapsed =
                    accumulatedMsRef.current +
                    (Date.now() - runStartRef.current);
                  setLiveDurationMs(elapsed);
                }
              }, 250);
            }
            return;
          }

          if (msg.type === "goAway" && !rotatingSocket && wsRef.current === ws) {
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
              accumulatedMsRef.current +
              (!isPausedRef.current && runStartRef.current > 0
                ? Date.now() - runStartRef.current
                : 0);

            const speakerId = msg.speakerLabel || "spk_1";
            const lang = msg.languageCode;
            const now = Date.now();

            updateSessionById(targetSessionId, (s) => {
              const lastSeg = s.segments[s.segments.length - 1];
              const shouldMerge =
                lastSeg &&
                !lastSeg.isEdited &&
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
            if (isReplacement && wsRef.current !== ws) {
              rotatingSocket = false;
              return;
            }
            setErrorMessage(msg.message || "Transcription connection error.");
            cleanupAudioPipeline();
            setConnectionState("error");
            if (wsRef.current) {
              try {
                wsRef.current.close();
              } catch {
                // ignore
              }
              wsRef.current = null;
            }
            return;
          }

          if (msg.type === "closed") {
            if (wsRef.current === ws) {
              cleanupAudioPipeline();
              wsRef.current = null;
              setConnectionState("idle");
            }
          }
        };

        ws.onerror = () => {
          if (isReplacement && wsRef.current !== ws) {
            rotatingSocket = false;
            return;
          }
          setErrorMessage(
            "WebSocket connection failed. Please ensure the server is running."
          );
          cleanupAudioPipeline();
          setConnectionState("error");
        };
      };

      attachMicSocket(false);

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
      const msg =
        err instanceof Error
          ? err.name === "NotAllowedError"
            ? "Microphone permission was denied. Please allow microphone access in your browser settings."
            : err.message
          : "Could not start microphone capture.";
      setErrorMessage(msg);
      cleanupAudioPipeline();
      setConnectionState("idle");
    }
  }, [
    activeSession,
    cleanupAudioPipeline,
    connectionState,
    refreshAudioDevices,
    selectedDeviceId,
    updateSessionById,
  ]);

  const togglePause = useCallback(() => {
    if (connectionState === "listening") {
      isPausedRef.current = true;
      accumulatedMsRef.current +=
        runStartRef.current > 0 ? Date.now() - runStartRef.current : 0;
      runStartRef.current = 0;
      setLiveDurationMs(accumulatedMsRef.current);
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "audioStreamEnd" }));
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
          workerCount: 3,
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

        const workerCount = chunks.length > 0 ? 3 : 0;
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
        let lockedScriptFamily: string | null = null;

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
        let fatalError: string | null = null;

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

        /**
         * Strictly focuses on the current 15s segment (or at most 1 immediate next segment
         * while playing current audio) instead of jumping ahead across distant segments.
         */
        const pickFocusedSegment = (): number | null => {
          if (isPreBufferingRef.current) {
            return completedSet.has(0) ? null : 0;
          }
          if (isAudioPlayingRef.current) {
            const currentSec = audioElRef.current?.currentTime ?? 0;
            const playheadIdx = findChunkAtSec(currentSec);
            if (!completedSet.has(playheadIdx)) {
              return playheadIdx;
            }
            if (
              playheadIdx + 1 < chunks.length &&
              !completedSet.has(playheadIdx + 1)
            ) {
              return playheadIdx + 1;
            }
            return null;
          }
          if (audioPlaybackEndedRef.current) {
            for (let i = 0; i < chunks.length; i++) {
              if (!completedSet.has(i)) {
                return i;
              }
            }
          }
          return null;
        };

        const isFatalConfigError = (msg: string) => {
          const lower = msg.toLowerCase();
          return (
            lower.includes("api_key_invalid") ||
            lower.includes("invalid gemini_api_key") ||
            lower.includes("permission denied") ||
            lower.includes("not configured")
          );
        };

        // Pre-warm all 3 workers concurrently so all Live sessions are ready before transcribing
        let preWarmedConns: Array<Awaited<ReturnType<typeof openLiveWs>> | null> =
          [];
        if (workerCount > 0) {
          preWarmedConns = await Promise.all(
            Array.from({ length: workerCount }, async (_, idx) => {
              const modeForPass =
                idx === 2 ? "SMART" : cfg.mode;
              const conn = await openLiveWs(lockedAutoLang, undefined, modeForPass);
              readyWorkerCount += 1;
              syncProgressUI();
              return conn;
            })
          );
        }

        if (abortController.signal.aborted) {
          preWarmedConns.forEach((c) => closeLiveConn(c));
          return;
        }

        allWorkersReady = true;
        preRollStage = "transcribing";
        syncProgressUI();

        interface WorkerPassSpec {
          passId: number;
          useRaw: boolean;
          mode: "VERBATIM" | "SMART";
          intervalMs: number;
        }

        const PASS_SPECS: WorkerPassSpec[] = [
          { passId: 0, useRaw: true, mode: cfg.mode, intervalMs: 118 },
          { passId: 1, useRaw: false, mode: "VERBATIM", intervalMs: 112 },
          { passId: 2, useRaw: false, mode: "SMART", intervalMs: 115 },
        ];

        const runSinglePassOnSegment = async (
          targetIdx: number,
          spec: WorkerPassSpec,
          preConn: Awaited<ReturnType<typeof openLiveWs>> | null,
          forcedLangHint?: string | null
        ) => {
          const chunk = chunks[targetIdx];
          const packets = spec.useRaw
            ? chunk.rawPacketsBase64
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
                if (!completedSet.has(seekedChunk) && seekedChunk !== targetIdx) {
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
                const idleDelay = interruptedByControl ? 450 : 1500;
                const maxDelay = interruptedByControl ? 750 : 6000;
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

        try {
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
              setInterimText("");
              syncProgressUI();
              await new Promise((r) => setTimeout(r, 150));
              continue;
            }

            const targetIdx = pickFocusedSegment();
            if (targetIdx === null) {
              await new Promise((r) => setTimeout(r, 150));
              continue;
            }

            const chunk = chunks[targetIdx];
            activeChunksSet.clear();
            activeChunksSet.add(targetIdx);
            syncProgressUI();

            if (!chunk.hasAudioSignal || chunk.pcmPacketsBase64.length === 0) {
              activeChunksSet.delete(targetIdx);
              completedSet.add(targetIdx);
              await maybeStartAutoPlayback();
              syncProgressUI();
              continue;
            }

            // Use pre-warmed connections for Segment 0 on the very first run
            const passPreConns = PASS_SPECS.map((_, idx) => {
              const c = preWarmedConns[idx] ?? null;
              preWarmedConns[idx] = null;
              return c;
            });

            // Run all 3 focused workers TOGETHER on this exact 15s segment
            const results = await Promise.all(
              PASS_SPECS.map((spec, idx) =>
                runSinglePassOnSegment(targetIdx, spec, passPreConns[idx])
              )
            );

            if (abortController.signal.aborted) {
              activeChunksSet.delete(targetIdx);
              break;
            }

            setInterimText("");

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

            // Reconcile across all 3 workers on this 15s segment
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
              (targetIdx <= 1 || completedSet.size === 0)
            ) {
              lockedScriptFamily = domScript;
              lockedAutoLang =
                reconciled.lang ?? scriptFamilyToBcp47(domScript) ?? null;
            }

            // If Segment 0 mixed Latin + non-Latin (e.g. English intro inside Amharic), run 1 focused locked-lang verification pass before playback opens!
            if (
              targetIdx === 0 &&
              cfg.languageCode === "auto" &&
              lockedAutoLang &&
              reconciled.text &&
              hasMixedLatinWithNonLatin(reconciled.text)
            ) {
              const verified = await runSinglePassOnSegment(
                0,
                { passId: 0, useRaw: false, mode: cfg.mode, intervalMs: 115 },
                null,
                lockedAutoLang
              );
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
        } finally {
          preWarmedConns.forEach((c) => closeLiveConn(c));
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
    detachUploadedAudio();
    const fresh = createEmptySession(activeSession.config);
    setSessions((prev) => [fresh, ...prev]);
    setActiveSessionId(fresh.id);
    setLiveDurationMs(0);
    setErrorMessage(null);
    setActiveTab("transcript");
  };

  const handleDeleteSession = (id: string) => {
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

  const handleRenameSpeaker = (speakerId: string, newName: string) => {
    updateSessionById(activeSession.id, (s) => ({
      ...s,
      updatedAt: Date.now(),
      speakerNames: { ...s.speakerNames, [speakerId]: newName },
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

  const totalWords = useMemo(
    () =>
      activeSession.segments.reduce(
        (sum, seg) => sum + countWords(seg.text),
        0
      ) + countWords(interimText),
    [activeSession.segments, interimText]
  );

  const displayedDuration =
    connectionState === "listening" || connectionState === "paused"
      ? liveDurationMs
      : activeSession.durationMs;

  const activeLanguageLabel =
    activeSession.detectedLanguages[0] ||
    LANGUAGE_OPTIONS.find((l) => l.code === activeSession.config.languageCode)
      ?.label ||
    "Auto-detect";

  const isActiveLive =
    connectionState === "listening" ||
    connectionState === "paused" ||
    connectionState === "connecting";

  const hasPlayerForActiveSession =
    uploadedAudio !== null && uploadedAudio.sessionId === activeSession.id;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSession.id}
        connectionState={connectionState}
        config={activeSession.config}
        isOpenMobile={isSidebarOpenMobile}
        onCloseMobile={() => setIsSidebarOpenMobile(false)}
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

      <main className="flex min-w-0 flex-1 flex-col">
        {/* Top workspace bar (3-zone layout) */}
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-slate-900 sm:px-6">
          {/* Zone 1: Editable Session Title & Unboxed Metadata */}
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setIsSidebarOpenMobile(true)}
              aria-label="Open sessions sidebar"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 lg:hidden"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              <input
                type="text"
                value={activeSession.title}
                onChange={(e) =>
                  updateSessionById(activeSession.id, (s) => ({
                    ...s,
                    title: e.target.value,
                    updatedAt: Date.now(),
                  }))
                }
                aria-label="Session title"
                className="w-44 truncate bg-transparent font-display text-sm font-semibold text-slate-900 focus:outline-none sm:w-64 dark:text-slate-100"
              />
              <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                <span>{formatDuration(displayedDuration)}</span>
                <span aria-hidden="true">·</span>
                <span>{totalWords} words</span>
                <span aria-hidden="true" className="hidden sm:inline">
                  ·
                </span>
                <span className="hidden truncate sm:inline">
                  {activeLanguageLabel}
                </span>
              </div>
            </div>
          </div>

          {/* Zone 2: View Switch */}
          <div className="hidden items-center gap-1 rounded-lg bg-slate-100 p-1 md:flex dark:bg-slate-800">
            <button
              type="button"
              onClick={() => setActiveTab("transcript")}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                activeTab === "transcript"
                  ? "bg-white text-slate-900 shadow-xs dark:bg-slate-700 dark:text-slate-100"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
              }`}
            >
              Transcript
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("notes")}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                activeTab === "notes"
                  ? "bg-white text-slate-900 shadow-xs dark:bg-slate-700 dark:text-slate-100"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
              }`}
            >
              Notes & Summary
            </button>
          </div>

          {/* Zone 3: Utilities & Theme */}
          <div className="flex items-center gap-1.5 shrink-0">
            {isSearchOpen ? (
              <div className="flex items-center rounded-lg border border-slate-200 bg-slate-50 px-2 dark:border-slate-700 dark:bg-slate-800">
                <Search className="h-3.5 w-3.5 text-slate-400" />
                <input
                  type="text"
                  autoFocus
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Find..."
                  className="h-8 w-28 bg-transparent px-2 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none sm:w-40 dark:text-slate-100"
                />
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    setIsSearchOpen(false);
                  }}
                  aria-label="Clear search"
                  className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIsSearchOpen(true)}
                aria-label="Search transcript"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <Search className="h-4 w-4" />
              </button>
            )}

            <button
              type="button"
              onClick={handleCopyAll}
              disabled={activeSession.segments.length === 0}
              className="hidden h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 sm:flex dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              {copiedAll ? (
                <Check className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              <span>{copiedAll ? "Copied" : "Copy"}</span>
            </button>

            <div className="relative">
              <button
                type="button"
                disabled={activeSession.segments.length === 0}
                onClick={() => setIsExportOpen((o) => !o)}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                <Download className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Export</span>
              </button>
              {isExportOpen && (
                <>
                  <div
                    onClick={() => setIsExportOpen(false)}
                    className="fixed inset-0 z-20"
                  />
                  <div className="absolute right-0 z-30 mt-1.5 w-40 rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                    {(
                      [
                        { id: "txt", label: "Plain Text (.txt)" },
                        { id: "md", label: "Markdown (.md)" },
                        { id: "srt", label: "Subtitles (.srt)" },
                        { id: "json", label: "JSON (.json)" },
                      ] as const
                    ).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handleExport(item.id)}
                        className="flex w-full items-center px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        {item.label}
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
              className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {isDark ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </button>
          </div>
        </header>

        {/* Mobile tab switcher */}
        <div className="flex border-b border-slate-200 bg-white px-4 py-2 md:hidden dark:border-slate-800 dark:bg-slate-900">
          <div className="grid w-full grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
            <button
              type="button"
              onClick={() => setActiveTab("transcript")}
              className={`rounded-md py-1 text-xs font-medium ${
                activeTab === "transcript"
                  ? "bg-white text-slate-900 shadow-xs dark:bg-slate-700 dark:text-slate-100"
                  : "text-slate-600 dark:text-slate-400"
              }`}
            >
              Transcript
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("notes")}
              className={`rounded-md py-1 text-xs font-medium ${
                activeTab === "notes"
                  ? "bg-white text-slate-900 shadow-xs dark:bg-slate-700 dark:text-slate-100"
                  : "text-slate-600 dark:text-slate-400"
              }`}
            >
              Notes & Summary
            </button>
          </div>
        </div>

        {/* Error banner */}
        {errorMessage && (
          <div className="flex items-center justify-between gap-3 border-b border-rose-200 bg-rose-50 px-4 py-2.5 text-xs text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/60 dark:text-rose-200 sm:px-6">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
              <span>{errorMessage}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              aria-label="Dismiss error"
              className="rounded p-1 hover:bg-rose-100 dark:hover:bg-rose-900/50"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* YouTube-style Synced Audio & Live Caption Stage */}
        {hasPlayerForActiveSession && uploadedAudio && activeTab === "transcript" && (
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

        {/* Main content viewport */}
        {activeTab === "transcript" ? (
          <TranscriptStream
            session={activeSession}
            interimText={interimText}
            interimSpeaker={interimSpeaker}
            interimLanguage={interimLanguage}
            connectionState={connectionState}
            searchQuery={searchQuery}
            hasAudioPlayer={hasPlayerForActiveSession}
            playbackTimeMs={playbackTimeMs}
            isAudioPlaying={isAudioPlaying}
            chunkProgress={
              hasPlayerForActiveSession ? chunkProgress : null
            }
            onSeekAudioMs={handleSeekAudioMs}
            onStartRecording={startRecording}
            onOpenUploadModal={() => setIsUploadOpen(true)}
            onUpdateSegmentText={handleUpdateSegmentText}
            onRenameSpeaker={handleRenameSpeaker}
          />
        ) : (
          <NotesPanel session={activeSession} onSaveNotes={handleSaveNotes} />
        )}

        {/* Bottom Acoustic Transport Dock */}
        <footer className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900 sm:px-6">
          {hasPlayerForActiveSession ? (
            <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-xs font-medium whitespace-nowrap shrink-0">
                {chunkProgress?.isBuffering ? (
                  <>
                    <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" />
                    <span className="text-rose-600 dark:text-rose-400">
                      Transcribing...
                    </span>
                  </>
                ) : isAudioPlaying ? (
                  <>
                    <span className="h-2 w-2 rounded-full bg-rose-600 animate-pulse" />
                    <span className="text-rose-600 dark:text-rose-400">
                      Synced Live Playback
                    </span>
                  </>
                ) : chunkProgress?.isAudioEnded &&
                  chunkProgress.isProcessing &&
                  !chunkProgress.isPaused ? (
                  <>
                    <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-emerald-600 dark:text-emerald-400">
                      Completing Transcript
                    </span>
                  </>
                ) : chunkProgress &&
                  chunkProgress.totalChunks > 0 &&
                  chunkProgress.completedChunks >= chunkProgress.totalChunks ? (
                  <span className="text-emerald-600 dark:text-emerald-400">
                    Transcript Complete
                  </span>
                ) : (
                  <span className="text-slate-500 dark:text-slate-400">
                    Playback Paused
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums truncate">
                {chunkProgress
                  ? chunkProgress.isBuffering
                    ? chunkProgress.preRollStage === "segmenting"
                      ? "Segmenting audio into 15s clips..."
                      : chunkProgress.preRollStage === "connecting"
                        ? `Readying ${chunkProgress.readyWorkers ?? 0}/${chunkProgress.workerCount ?? 5} Live workers...`
                        : `Finishing segment 1 (${chunkProgress.readyWorkers ?? 0}/${chunkProgress.workerCount ?? 5} workers ready)`
                    : chunkProgress.totalChunks > 0
                      ? `${chunkProgress.completedChunks}/${chunkProgress.totalChunks} segments (15s)`
                      : "Slicing 15s segments..."
                  : "Audio loaded"}
              </div>
              <div className="flex items-center gap-2 shrink-0">
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
                  className="flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 whitespace-nowrap shrink-0"
                >
                  {isAudioPlaying ? (
                    <>
                      <Pause className="h-3.5 w-3.5" />
                      <span>Pause</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5" />
                      <span>Play</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  disabled={Boolean(chunkProgress?.isBuffering)}
                  onClick={handleStopAudio}
                  className="flex h-10 items-center gap-2 rounded-lg bg-slate-900 px-4 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200 whitespace-nowrap shrink-0"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                  <span>Stop</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
              {/* Left: Status & Device selector */}
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex items-center gap-2 text-xs font-medium whitespace-nowrap shrink-0">
                  {connectionState === "listening" && (
                    <>
                      <span className="h-2 w-2 rounded-full bg-rose-600 animate-pulse" />
                      <span className="text-rose-600 dark:text-rose-400">
                        Recording
                      </span>
                    </>
                  )}
                  {connectionState === "connecting" && (
                    <span className="text-slate-600 dark:text-slate-300">
                      Connecting...
                    </span>
                  )}
                  {connectionState === "paused" && (
                    <span className="text-amber-600 dark:text-amber-400">
                      Paused
                    </span>
                  )}
                  {(connectionState === "idle" ||
                    connectionState === "stopping" ||
                    connectionState === "error") && (
                    <span className="text-slate-500 dark:text-slate-400">
                      Standby
                    </span>
                  )}
                </div>

                {audioDevices.length > 0 && (
                  <select
                    aria-label="Microphone input device"
                    disabled={isActiveLive}
                    value={selectedDeviceId}
                    onChange={(e) => setSelectedDeviceId(e.target.value)}
                    className="hidden h-8 max-w-[180px] truncate rounded-md border border-slate-200 bg-slate-50 px-2 text-xs text-slate-700 focus:outline-none disabled:opacity-60 sm:block dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                  >
                    <option value="">Default microphone</option>
                    {audioDevices.map((dev, i) => (
                      <option key={dev.deviceId || i} value={dev.deviceId}>
                        {dev.label || `Microphone ${i + 1}`}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Center: Live Waveform & Timer */}
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="min-w-0 flex-1">
                  <WaveformVisualizer
                    analyser={analyserNode}
                    state={connectionState}
                    isDark={isDark}
                  />
                </div>
                <span className="font-mono text-xs font-medium text-slate-600 tabular-nums dark:text-slate-300 whitespace-nowrap shrink-0">
                  {formatDuration(displayedDuration)}
                </span>
              </div>

              {/* Right: Transport Controls */}
              <div className="flex items-center gap-2 shrink-0">
                {(connectionState === "listening" ||
                  connectionState === "paused") && (
                  <button
                    type="button"
                    onClick={togglePause}
                    aria-label={
                      connectionState === "paused"
                        ? "Resume recording"
                        : "Pause recording"
                    }
                    className="flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 whitespace-nowrap shrink-0"
                  >
                    {connectionState === "paused" ? (
                      <>
                        <Play className="h-3.5 w-3.5" />
                        <span>Resume</span>
                      </>
                    ) : (
                      <>
                        <Pause className="h-3.5 w-3.5" />
                        <span>Pause</span>
                      </>
                    )}
                  </button>
                )}

                {isActiveLive ? (
                  <button
                    type="button"
                    onClick={stopRecording}
                    className="flex h-10 items-center gap-2 rounded-lg bg-slate-900 px-4 text-xs font-medium text-white transition-colors hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200 whitespace-nowrap shrink-0"
                  >
                    <Square className="h-3.5 w-3.5 fill-current" />
                    <span>Stop</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={startRecording}
                    className="flex h-10 items-center gap-2 rounded-lg bg-rose-600 px-4 text-xs font-medium text-white transition-colors hover:bg-rose-700 whitespace-nowrap shrink-0"
                  >
                    <Mic className="h-3.5 w-3.5" />
                    <span>Start Recording</span>
                  </button>
                )}
              </div>
            </div>
          )}
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
