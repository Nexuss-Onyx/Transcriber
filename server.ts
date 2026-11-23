import "dotenv/config";
import http from "node:http";
import path from "node:path";
import express from "express";
import {
  AudioTranscriptionConfigMode,
  GoogleGenAI,
  Modality,
  Type,
  type AudioTranscriptionConfig,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import { FrontierModelRouter, classifyGeminiRouterError } from "./server/modelRouter";

const PORT = Number(process.env.PORT) || 3000;
const LIVE_TRANSCRIBE_MODEL = "gemini-3.5-transcribe-live";
const STATIC_TRANSCRIBE_MODEL = "gemini-3.5-transcribe";
const lmRouter = new FrontierModelRouter();

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

  // Post-transcript synthesis using frontier-to-down rate-limit router
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
          "Summarize the following transcript into a concise executive overview followed by 3–6 clear key takeaways. Use clean markdown headings and bullet points. Write in the same language and script as the transcript (e.g., respond in Amharic using Ethiopic script if the transcript is in Amharic). Do not invent facts not present in the transcript.",
        actions:
          "Extract all action items, decisions, owners (if mentioned), and follow-up questions from this transcript. Format as clean markdown bullet points. Write in the same language and script as the transcript (e.g., respond in Amharic using Ethiopic script if the transcript is in Amharic). If none are explicit, note the main open questions or next steps.",
        polish:
          "Lightly edit this raw speech transcript for readability: fix punctuation, remove verbal filler words, and organize into clean paragraphs while preserving the speakers' exact meaning, language, and script (keep Amharic in Ethiopic script).",
      };

      const systemInstruction = prompts[task ?? "summary"] ?? prompts.summary;
      const { result: response } = await lmRouter.executeWithFailover((model) =>
        ai.models.generateContent({
          model,
          contents: transcript,
          config: {
            systemInstruction,
          },
        })
      );

      res.json({
        result: (response.text ?? "").trim(),
      });
    } catch (err) {
      console.error("Transcript analysis error:", err);
      res.status(500).json({ error: formatGeminiError(err) });
    }
  });

  // Lossless static WAV audio transcription worker using gemini-3.5-transcribe
  // with frontier-to-down multimodal failover on transient/quota/availability errors
  app.post("/api/transcribe-audio", async (req, res) => {
    try {
      const { wavBase64, languageCode, customVocabulary, mode } = req.body as {
        wavBase64?: string;
        languageCode?: string;
        customVocabulary?: string[];
        mode?: "VERBATIM" | "SMART";
      };

      const cleanWav = typeof wavBase64 === "string" ? wavBase64.trim() : "";
      if (!cleanWav || cleanWav.length > 16_000_000) {
        res.status(400).json({ error: "Invalid or missing wavBase64 payload." });
        return;
      }

      const ai = getAiClient("v1beta");
      const cleanVocab = Array.isArray(customVocabulary)
        ? customVocabulary.map((v) => String(v).trim()).filter(Boolean).slice(0, 120)
        : [];
      const langHint =
        typeof languageCode === "string" && languageCode.trim() && languageCode !== "auto"
          ? languageCode.trim()
          : "auto";
      const isSmart = mode === "SMART";

      const promptLines = [
        isSmart
          ? "Transcribe the attached audio accurately in natural spoken form with clean punctuation and capitalization."
          : "Transcribe the attached audio strictly verbatim word-for-word, preserving contractions, informal speech, slang, and repetitions.",
        langHint !== "auto"
          ? `Expected language code: ${langHint}. Use the native script for that language (e.g., strictly Ethiopic/Ge'ez script for Amharic am-ET, Latin script for English).`
          : "Use the native script of the spoken language(s) (e.g., Ethiopic/Ge'ez script for Amharic, Latin script for English).",
        cleanVocab.length > 0
          ? `Prioritize accurate spelling for these domain terms/names when heard: ${cleanVocab.join(", ")}.`
          : "",
        "Return ONLY the spoken words as plain text with zero commentary, timestamps, speaker labels, or quotes. If only silence or non-speech noise is present, return an empty string.",
      ]
        .filter(Boolean)
        .join("\n");

      const parts = [
        { inlineData: { mimeType: "audio/wav", data: cleanWav } },
        { text: promptLines },
      ];

      let modelUsed = STATIC_TRANSCRIBE_MODEL;
      let transcriptText = "";

      try {
        const directRes = await ai.models.generateContent({
          model: STATIC_TRANSCRIBE_MODEL,
          contents: parts,
        });
        transcriptText = (directRes.text ?? "").trim();
      } catch (directErr) {
        const kind = classifyGeminiRouterError(directErr);
        if (kind === "auth") {
          throw directErr;
        }
        const fallback = await lmRouter.executeWithFailover((model) =>
          ai.models.generateContent({
            model,
            contents: parts,
          })
        );
        modelUsed = fallback.modelUsed;
        transcriptText = (fallback.result.text ?? "").trim();
      }

      // Guard against accidental empty-marker strings
      const normalized =
        transcriptText === '""' || transcriptText === "''" ? "" : transcriptText;

      res.json({
        text: normalized,
        modelUsed,
      });
    } catch (err) {
      console.error("Static WAV transcription error:", err);
      res.status(500).json({ error: formatGeminiError(err) });
    }
  });

  // Under-the-hood multimodal audio + multi-worker transcript refinement using frontier-to-down router
  app.post("/api/refine-transcript", async (req, res) => {
    try {
      const {
        windows,
        priorContext,
        languageCode,
        customVocabulary,
        scope,
      } = req.body as {
        windows?: Array<{
          windowIndex: number;
          startMs: number;
          endMs: number;
          workers: Record<string, string>;
          audioAttachment?: {
            hqWavBase64?: string;
            rawWavBase64?: string;
          };
        }>;
        priorContext?: string;
        languageCode?: string;
        customVocabulary?: string[];
        scope?: "live_6w" | "live_5w" | "upload_5w" | "upload_3w";
      };

      if (!Array.isArray(windows) || windows.length === 0) {
        res.json({ refinedWindows: [] });
        return;
      }

      const isUpload5W = scope === "upload_5w";
      const isUpload3W = scope === "upload_3w";

      const sanitizedSlice = windows.slice(0, 24);
      const boundedWindows = sanitizedSlice.map((w) => ({
        windowIndex: Number(w.windowIndex),
        startMs: Number(w.startMs),
        endMs: Number(w.endMs),
        workers: isUpload5W
          ? {
              worker_1_raw_ws_verbatim: String(w.workers?.worker1LiveRealtime ?? "").trim(),
              worker_2_raw_ws_smart: String(w.workers?.worker2FirstHalfPrimary ?? "").trim(),
              worker_3_hq_ws_verbatim: String(w.workers?.worker3FirstHalfContrast ?? "").trim(),
              worker_4_hq_ws_smart: String(w.workers?.worker4SecondHalfPrimary ?? "").trim(),
              worker_5_hq_vocal_clarity: String(w.workers?.worker5SecondHalfContrast ?? "").trim(),
              worker_7_static_hq_wav: String(w.workers?.worker7StaticHqWav ?? "").trim(),
              worker_8_static_raw_wav: String(w.workers?.worker8StaticRawWav ?? "").trim(),
            }
          : isUpload3W
            ? {
                worker_1_filtered_primary: String(w.workers?.worker2FirstHalfPrimary ?? "").trim(),
                worker_2_raw_contrast: String(w.workers?.worker3FirstHalfContrast ?? "").trim(),
                worker_3_focused_backup: String(w.workers?.worker4SecondHalfPrimary ?? "").trim(),
              }
            : {
                worker_1_live_raw_full: String(w.workers?.worker1LiveRealtime ?? "").trim(),
                worker_2_live_hq_full: String(w.workers?.worker6LiveHqRealtime ?? "").trim(),
                worker_3_first_half_hq: String(w.workers?.worker2FirstHalfPrimary ?? "").trim(),
                worker_4_first_half_raw: String(w.workers?.worker3FirstHalfContrast ?? "").trim(),
                worker_5_second_half_hq: String(w.workers?.worker4SecondHalfPrimary ?? "").trim(),
                worker_6_second_half_raw: String(w.workers?.worker5SecondHalfContrast ?? "").trim(),
                worker_7_static_hq_wav: String(w.workers?.worker7StaticHqWav ?? "").trim(),
                worker_8_static_raw_wav: String(w.workers?.worker8StaticRawWav ?? "").trim(),
              },
      }));

      // Collect lossless WAV audio parts (capped at 8 inline audio parts per call)
      const audioParts: Array<
        { text: string } | { inlineData: { mimeType: string; data: string } }
      > = [];
      const attachedWindowIndices: number[] = [];
      let audioPartCount = 0;

      for (const w of sanitizedSlice) {
        const hqWav =
          typeof w.audioAttachment?.hqWavBase64 === "string"
            ? w.audioAttachment.hqWavBase64.trim()
            : "";
        const rawWav =
          typeof w.audioAttachment?.rawWavBase64 === "string"
            ? w.audioAttachment.rawWavBase64.trim()
            : "";

        if (hqWav && hqWav.length < 12_000_000 && audioPartCount < 8) {
          audioParts.push({
            text: `AUDIO_GROUND_TRUTH (High-Quality 16kHz WAV) for windowIndex ${Number(w.windowIndex)} (${Number(w.startMs)}ms..${Number(w.endMs)}ms):`,
          });
          audioParts.push({
            inlineData: { mimeType: "audio/wav", data: hqWav },
          });
          attachedWindowIndices.push(Number(w.windowIndex));
          audioPartCount++;
        }

        // For focused small batches (1-2 windows), also attach raw unmodified WAV for dual acoustic contrast
        if (
          sanitizedSlice.length <= 2 &&
          rawWav &&
          rawWav.length < 12_000_000 &&
          audioPartCount < 8
        ) {
          audioParts.push({
            text: `AUDIO_RAW_CONTRAST (Unfiltered 16kHz WAV) for windowIndex ${Number(w.windowIndex)}:`,
          });
          audioParts.push({
            inlineData: { mimeType: "audio/wav", data: rawWav },
          });
          if (!attachedWindowIndices.includes(Number(w.windowIndex))) {
            attachedWindowIndices.push(Number(w.windowIndex));
          }
          audioPartCount++;
        }
      }

      const hasAudioGroundTruth = audioPartCount > 0;
      const ai = getAiClient("v1beta");
      const cleanVocab = Array.isArray(customVocabulary)
        ? customVocabulary.map((v) => String(v).trim()).filter(Boolean).slice(0, 120)
        : [];

      const workerTopologyLine = isUpload5W
        ? "Each window contains the independent raw outputs of up to 7 ASR workers (5 parallel live-stream WebSocket passes across raw/HQ/clarified waveforms + 2 static lossless WAV workers) for the EXACT SAME audio segment."
        : isUpload3W
          ? "Each window contains the independent raw outputs of 3 parallel ASR workers each listening to the ENTIRE audio chunk independently."
          : "Each window contains the independent raw outputs of up to 8 ASR workers covering the same 10s live audio window: worker_1 (live raw stream), worker_2 (live HQ stream), worker_3..worker_6 (first-half & second-half HQ/raw passes), and worker_7..worker_8 (full-window lossless static WAV passes).";

      const systemInstruction = [
        "You are an under-the-hood multimodal audio + multi-worker speech-to-text reconstruction engine.",
        hasAudioGroundTruth
          ? "You receive BOTH the actual lossless 16kHz WAV audio waveform(s) for the speech windows AND a structured JSON batch of independent ASR worker hypotheses."
          : "You receive a structured JSON batch of time-ordered speech windows with independent ASR worker hypotheses.",
        workerTopologyLine,
        "",
        "CORE RECONSTRUCTION RULES:",
        ...(hasAudioGroundTruth
          ? [
              "0. DIRECT ACOUSTIC GROUND TRUTH: Listen carefully to EVERY attached audio/wav waveform alongside the worker hypotheses. Recover any dropped words, clipped syllables, quiet endings, misheard names, informal contractions, or Amharic/English phonetic errors directly from what is actually spoken in the audio. When an ASR worker omitted or distorted words clearly audible in the WAV, restore the exact spoken words; when a worker hallucinated words not audible in the WAV, reject them.",
            ]
          : []),
        "1. CONSENSUS WINS ('more workers agreeing beats a single outlier'): Compare all available workers word-by-word and phonetically against the audio. Never let an empty or hallucinating single worker override valid words heard in the audio or agreed upon by multiple workers.",
        "2. CONTEXTUAL & PHONETIC RECOVERY: Real speech ASR workers frequently miss articles/endings, mishear homophones, split/merge words, or stumble on informal conversation, fast English speech, slang, contractions ('gonna', 'wanna', 'kinda', 'don't'), idioms, technical terms, names, numbers, or mixed-language code-switching (including Amharic Ge'ez script + English). Comprehend what the speaker actually said using the audio + cross-worker evidence + priorContext, and output the exact natural spoken sentence(s).",
        "3. STRICTLY NO ESSAYS OR INVENTED CONTENT: Never expand, summarize, answer questions, add commentary, add explanations, or generate unstated sentences. Your output for each window MUST strictly represent only the words spoken in that window, matching the natural length and propositions of the speech.",
        "4. INFORMAL SPEECH FIDELITY: Preserve casual/conversational tone and slang faithfully; only fix garbled ASR mishearings, spacing, punctuation, and casing. Do not turn casual talk into formal essays.",
        "5. CONTINUITY WITHOUT DUPLICATION: Use priorContext strictly to resolve ambiguous words or grammar across window boundaries. Never repeat sentences from priorContext or duplicate words already finished in an earlier window.",
        "6. EMPTY / NOISE HANDLING: If a window contains only silence or non-speech artifacts, return an empty string \"\" for refinedText.",
        "7. SCRIPT & LANGUAGE FIDELITY: Respect the language spoken (and languageCode hint when provided). Keep English in clean Latin script and Amharic in Ethiopic (Ge'ez) script; allow natural mixed-language phrases when genuinely spoken.",
        "8. STRICT OUTPUT FORMAT: Return ONLY valid JSON matching the responseSchema with one entry for every input windowIndex, preserving each exact windowIndex integer.",
      ].join("\n");

      const payload = {
        languageHint: languageCode || "auto",
        customVocabulary: cleanVocab,
        priorContext:
          typeof priorContext === "string" ? priorContext.trim().slice(-600) : "",
        attachedAudioWindowIndices: attachedWindowIndices,
        windows: boundedWindows,
      };

      const responseConfig = {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            refinedWindows: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  windowIndex: { type: Type.INTEGER },
                  refinedText: { type: Type.STRING },
                  detectedLanguage: { type: Type.STRING },
                },
                required: ["windowIndex", "refinedText"],
              },
            },
          },
          required: ["refinedWindows"],
        },
      };

      const jsonText = JSON.stringify(payload);
      let routerOutcome: {
        modelUsed: string;
        result: Awaited<ReturnType<typeof ai.models.generateContent>>;
      };

      if (hasAudioGroundTruth) {
        try {
          routerOutcome = await lmRouter.executeWithFailover((model) =>
            ai.models.generateContent({
              model,
              contents: [...audioParts, { text: jsonText }],
              config: responseConfig,
            })
          );
        } catch (multimodalErr) {
          const kind = classifyGeminiRouterError(multimodalErr);
          if (kind === "auth") {
            throw multimodalErr;
          }
          // Safe fallback to text-only consensus if multimodal payload failed
          routerOutcome = await lmRouter.executeWithFailover((model) =>
            ai.models.generateContent({
              model,
              contents: jsonText,
              config: responseConfig,
            })
          );
        }
      } else {
        routerOutcome = await lmRouter.executeWithFailover((model) =>
          ai.models.generateContent({
            model,
            contents: jsonText,
            config: responseConfig,
          })
        );
      }

      const { modelUsed, result: response } = routerOutcome;

      let parsed: {
        refinedWindows?: Array<{
          windowIndex: number;
          refinedText: string;
          detectedLanguage?: string;
        }>;
      } = {};
      try {
        parsed = JSON.parse((response.text ?? "{}").trim()) as typeof parsed;
      } catch {
        parsed = {};
      }

      const byIndex = new Map<
        number,
        { windowIndex: number; refinedText: string; detectedLanguage?: string }
      >();
      if (Array.isArray(parsed.refinedWindows)) {
        for (const item of parsed.refinedWindows) {
          if (typeof item?.windowIndex === "number") {
            byIndex.set(item.windowIndex, {
              windowIndex: item.windowIndex,
              refinedText: String(item.refinedText ?? "").trim(),
              ...(item.detectedLanguage
                ? { detectedLanguage: String(item.detectedLanguage).trim() }
                : {}),
            });
          }
        }
      }

      const normalized = boundedWindows.map((w) => {
        const hit = byIndex.get(w.windowIndex);
        return (
          hit ?? {
            windowIndex: w.windowIndex,
            refinedText: "",
          }
        );
      });

      res.json({
        refinedWindows: normalized,
        modelUsed,
        multimodalAudioUsed: hasAudioGroundTruth,
      });
    } catch (err) {
      console.error("Structured transcript refinement error:", err);
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
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Transcribe Live server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Fatal server startup error:", err);
  process.exit(1);
});
