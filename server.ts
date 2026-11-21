import "dotenv/config";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import {
  AudioTranscriptionConfigMode,
  GoogleGenAI,
  Modality,
  type AudioTranscriptionConfig,
  type LiveServerMessage,
  type Session,
} from "@google/genai";

const PORT = 3000;
const LIVE_TRANSCRIBE_MODEL = "gemini-3.5-transcribe-live";

function getAiClient(apiVersion?: string): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Please add it in Settings > Secrets."
    );
  }
  return new GoogleGenAI({
    apiKey,
    ...(apiVersion ? { apiVersion } : {}),
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function isNotFoundError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return (
    raw.includes("NOT_FOUND") ||
    raw.includes('"code":404') ||
    raw.toLowerCase().includes("not found") ||
    raw.toLowerCase().includes("is not supported for")
  );
}

function formatGeminiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes("API_KEY_INVALID")) {
    return `Invalid GEMINI_API_KEY in Settings > Secrets. (${raw.slice(0, 200)})`;
  }
  if (raw.includes("PERMISSION_DENIED")) {
    return `Permission denied by Gemini API. Check your key permissions in Settings > Secrets. (${raw.slice(0, 200)})`;
  }
  if (raw.includes("RESOURCE_EXHAUSTED") || raw.includes('"code":429')) {
    return `Rate limit or quota exceeded (429). (${raw.slice(0, 200)})`;
  }
  return raw.slice(0, 260);
}

interface StartSessionPayload {
  type: "start";
  languageCodes?: string[];
  customVocabulary?: string[];
  mode?: "VERBATIM" | "SMART";
  sourceText?: string;
}

interface AudioChunkPayload {
  type: "audio";
  data: string;
}

interface ControlPayload {
  type: "audioStreamEnd" | "stop";
}

type ClientWsMessage = StartSessionPayload | AudioChunkPayload | ControlPayload;

function safeSend(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function connectLiveTranscribeOnly(params: {
  inputAudioTranscription: AudioTranscriptionConfig;
  callbacks: {
    onopen: () => void;
    onmessage: (message: LiveServerMessage) => void;
    onerror: (err: unknown) => void;
    onclose: (ev: unknown) => void;
  };
}): Promise<{ session: Session; modelUsed: string }> {
  const apiVersions: Array<string | undefined> = ["v1beta", "v1alpha", undefined];

  let lastError: unknown;
  for (const apiVersion of apiVersions) {
    try {
      const ai = getAiClient(apiVersion);
      let earlyError: unknown = null;

      const session = await ai.live.connect({
        model: LIVE_TRANSCRIBE_MODEL,
        config: {
          responseModalities: [Modality.TEXT],
          inputAudioTranscription: params.inputAudioTranscription,
        },
        callbacks: {
          onopen: params.callbacks.onopen,
          onmessage: params.callbacks.onmessage,
          onerror: (err: unknown) => {
            earlyError = err;
            params.callbacks.onerror(err);
          },
          onclose: params.callbacks.onclose,
        },
      });

      if (earlyError && isNotFoundError(earlyError)) {
        try {
          session.close();
        } catch {
          // ignore
        }
        lastError = earlyError;
        continue;
      }

      return { session, modelUsed: LIVE_TRANSCRIBE_MODEL };
    } catch (err) {
      lastError = err;
      if (!isNotFoundError(err)) {
        throw err;
      }
      console.warn(
        `${LIVE_TRANSCRIBE_MODEL} (${apiVersion ?? "default"}) returned not found, trying next API version...`
      );
    }
  }

  throw lastError;
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "35mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      model: LIVE_TRANSCRIBE_MODEL,
      configured: Boolean(process.env.GEMINI_API_KEY),
    });
  });

  // Post-transcript synthesis using gemini-4-hydrogen
  app.post("/api/analyze", async (req, res) => {
    try {
      const { transcript, task } = req.body as {
        transcript?: string;
        task?: "summary" | "actions" | "polish";
      };

      if (!transcript || !transcript.trim()) {
        res.status(400).json({ error: "Transcript is empty." });
        return;
      }

      const ai = getAiClient("v1beta");
      const prompts: Record<string, string> = {
        summary:
          "Summarize the following transcript into a concise executive overview followed by 3–6 clear key takeaways. Use clean markdown headings and bullet points. Do not invent facts not present in the transcript.",
        actions:
          "Extract all action items, decisions, owners (if mentioned), and follow-up questions from this transcript. Format as clean markdown bullet points. If none are explicit, note the main open questions or next steps.",
        polish:
          "Lightly edit this raw speech transcript for readability: fix punctuation, remove verbal filler words, and organize into clean paragraphs while preserving the speakers' exact meaning and voice.",
      };

      const systemInstruction = prompts[task ?? "summary"] ?? prompts.summary;
      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: transcript,
        config: {
          systemInstruction,
        },
      });

      res.json({
        result: (response.text ?? "").trim(),
      });
    } catch (err) {
      console.error("Transcript analysis error:", err);
      res.status(500).json({ error: formatGeminiError(err) });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws/transcribe" });

  wss.on("connection", (clientWs: WebSocket) => {
    let session: Session | null = null;
    let isConnecting = false;
    let isClosed = false;
    const pendingAudioQueue: string[] = [];

    const closeLiveSession = () => {
      if (session) {
        try {
          session.close();
        } catch {
          // ignore close errors
        }
        session = null;
      }
      pendingAudioQueue.length = 0;
    };

    clientWs.on("message", async (rawData: Buffer | string) => {
      if (isClosed) return;

      let msg: ClientWsMessage;
      try {
        msg = JSON.parse(rawData.toString()) as ClientWsMessage;
      } catch {
        safeSend(clientWs, { type: "error", message: "Invalid JSON payload." });
        return;
      }

      if (msg.type === "start") {
        if (isConnecting || session) {
          closeLiveSession();
        }
        isConnecting = true;

        try {
          const isSmart = msg.mode === "SMART";
          const cleanVocab = Array.isArray(msg.customVocabulary)
            ? Array.from(
                new Set(
                  msg.customVocabulary
                    .map((v) => String(v).trim())
                    .filter(Boolean)
                )
              ).slice(0, 500)
            : [];

          const inputAudioTranscription: AudioTranscriptionConfig = {
            languageCodes:
              Array.isArray(msg.languageCodes) && msg.languageCodes.length > 0
                ? msg.languageCodes.filter(Boolean).slice(0, 5)
                : [],
            mode: isSmart
              ? AudioTranscriptionConfigMode.SMART
              : AudioTranscriptionConfigMode.VERBATIM,
          };

          if (cleanVocab.length > 0) {
            inputAudioTranscription.customVocabulary = cleanVocab;
          }

          if (isSmart && typeof msg.sourceText === "string") {
            const trimmedSource = msg.sourceText.trim().slice(-400);
            if (trimmedSource) {
              inputAudioTranscription.sourceText = trimmedSource;
            }
          }

          let readySent = false;
          const sendReadyOnce = () => {
            if (!readySent) {
              readySent = true;
              safeSend(clientWs, { type: "ready", model: LIVE_TRANSCRIBE_MODEL });
            }
          };

          const { session: liveSession } = await connectLiveTranscribeOnly({
            inputAudioTranscription,
            callbacks: {
              onopen: () => {
                safeSend(clientWs, {
                  type: "status",
                  status: "connected",
                  model: LIVE_TRANSCRIBE_MODEL,
                });
              },
              onmessage: (message: LiveServerMessage) => {
                if (message.setupComplete) {
                  sendReadyOnce();
                }

                const content = message.serverContent;
                if (content?.interimInputTranscription?.text !== undefined) {
                  safeSend(clientWs, {
                    type: "interim",
                    text: content.interimInputTranscription.text,
                    languageCode:
                      content.interimInputTranscription.languageCode,
                    speakerLabel:
                      content.interimInputTranscription.speakerLabel,
                    startOffset: content.interimInputTranscription.startOffset,
                  });
                }

                if (content?.inputTranscription) {
                  const t = content.inputTranscription;
                  if (t.text || t.finished) {
                    safeSend(clientWs, {
                      type: "transcript",
                      text: t.text ?? "",
                      finished: Boolean(t.finished),
                      languageCode: t.languageCode,
                      speakerLabel: t.speakerLabel,
                      startOffset: t.startOffset,
                      words: t.words,
                    });
                  }
                }

                if (content?.turnComplete) {
                  safeSend(clientWs, { type: "turnComplete" });
                }

                if (message.goAway) {
                  safeSend(clientWs, {
                    type: "goAway",
                    timeLeft: message.goAway.timeLeft,
                  });
                }
              },
              onerror: (err: unknown) => {
                console.error("Gemini Live session error:", err);
                safeSend(clientWs, {
                  type: "error",
                  message: formatGeminiError(err),
                });
              },
              onclose: (event: unknown) => {
                const reason =
                  typeof event === "object" &&
                  event !== null &&
                  "reason" in event
                    ? String((event as { reason?: string }).reason ?? "")
                    : "";
                const code =
                  typeof event === "object" &&
                  event !== null &&
                  "code" in event
                    ? Number((event as { code?: number }).code ?? 0)
                    : 0;
                if (
                  code === 1007 ||
                  code === 1008 ||
                  reason.toLowerCase().includes("not found") ||
                  reason.toLowerCase().includes("not supported") ||
                  reason.toLowerCase().includes("permission") ||
                  reason.toLowerCase().includes("api key")
                ) {
                  safeSend(clientWs, {
                    type: "error",
                    message: `Live session closed (${code}): ${reason || "Connection rejected"}`,
                  });
                } else {
                  safeSend(clientWs, { type: "closed", code, reason });
                }
                session = null;
              },
            },
          });

          if (isClosed) {
            liveSession.close();
            return;
          }

          session = liveSession;
          isConnecting = false;
          sendReadyOnce();

          while (pendingAudioQueue.length > 0 && session) {
            const chunk = pendingAudioQueue.shift();
            if (chunk) {
              session.sendRealtimeInput({
                audio: { data: chunk, mimeType: "audio/pcm;rate=16000" },
              });
            }
          }
        } catch (err) {
          isConnecting = false;
          console.error("Failed to connect Gemini Live:", err);
          safeSend(clientWs, {
            type: "error",
            message: formatGeminiError(err),
          });
        }
        return;
      }

      if (msg.type === "audio" && msg.data) {
        if (session) {
          try {
            session.sendRealtimeInput({
              audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" },
            });
          } catch (err) {
            safeSend(clientWs, {
              type: "error",
              message: formatGeminiError(err),
            });
          }
        } else if (isConnecting && pendingAudioQueue.length < 120) {
          pendingAudioQueue.push(msg.data);
        }
        return;
      }

      if (msg.type === "audioStreamEnd") {
        if (session) {
          try {
            session.sendRealtimeInput({ audioStreamEnd: true });
          } catch {
            // ignore if already closing
          }
        }
        return;
      }

      if (msg.type === "stop") {
        if (session) {
          try {
            session.sendRealtimeInput({ audioStreamEnd: true });
          } catch {
            // ignore
          }
        }
        setTimeout(() => {
          closeLiveSession();
        }, 250);
      }
    });

    clientWs.on("close", () => {
      isClosed = true;
      closeLiveSession();
    });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Transcribe Live server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Fatal server startup error:", err);
  process.exit(1);
});
