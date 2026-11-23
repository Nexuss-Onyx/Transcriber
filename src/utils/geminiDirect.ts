import { GoogleGenAI, Modality, Type } from "@google/genai";

const API_KEY_STORAGE = "gemini_api_key_v1";

export function getApiKey(): string {
  return localStorage.getItem(API_KEY_STORAGE) || "";
}

export function setApiKey(key: string): void {
  localStorage.setItem(API_KEY_STORAGE, key.trim());
}

export function hasApiKey(): boolean {
  return !!getApiKey();
}

function getClient(apiVersion?: string): GoogleGenAI {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured. Please add it in Settings.");
  return new GoogleGenAI({
    apiKey,
    ...(apiVersion ? { apiVersion } : {}),
  });
}

export async function transcribeAudio(params: {
  wavBase64: string;
  languageCode?: string;
  customVocabulary?: string[];
  mode: "VERBATIM" | "SMART";
}): Promise<{ text: string; error?: string }> {
  if (!params.wavBase64) return { text: "" };
  try {
    const ai = getClient("v1beta");
    const cleanVocab = (params.customVocabulary || [])
      .map((v) => String(v).trim())
      .filter(Boolean)
      .slice(0, 120);
    const langHint =
      params.languageCode && params.languageCode !== "auto"
        ? params.languageCode.trim()
        : "auto";
    const isSmart = params.mode === "SMART";
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

    const res = await ai.models.generateContent({
      model: "gemini-3.5-transcribe",
      contents: [
        { inlineData: { mimeType: "audio/wav", data: params.wavBase64 } },
        { text: promptLines },
      ],
    });
    return { text: (res.text ?? "").trim() };
  } catch (err) {
    return { text: "", error: String(err) };
  }
}

export async function analyzeTranscript(params: {
  transcript: string;
  task: "summary" | "actions" | "polish";
}): Promise<{ result: string; error?: string }> {
  if (!params.transcript.trim()) return { result: "" };
  try {
    const ai = getClient("v1beta");
    const prompts: Record<string, string> = {
      summary:
        "Summarize the following transcript into a concise executive overview followed by 3–6 clear key takeaways. Use clean markdown headings and bullet points. Write in the same language and script as the transcript (e.g., respond in Amharic using Ethiopic script if the transcript is in Amharic). Do not invent facts not present in the transcript.",
      actions:
        "Extract all action items, decisions, owners (if mentioned), and follow-up questions from this transcript. Format as clean markdown bullet points. Write in the same language and script as the transcript (e.g., respond in Amharic using Ethiopic script if the transcript is in Amharic). If none are explicit, note the main open questions or next steps.",
      polish:
        "Lightly edit this raw speech transcript for readability: fix punctuation, remove verbal filler words, and organize into clean paragraphs while preserving the speakers' exact meaning, language, and script (keep Amharic in Ethiopic script).",
    };
    const systemInstruction = prompts[params.task] ?? prompts.summary;
    const res = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: params.transcript,
      config: { systemInstruction },
    });
    return { result: (res.text ?? "").trim() };
  } catch (err) {
    return { result: "", error: String(err) };
  }
}

export async function refineTranscript(params: {
  mode: "VERBATIM" | "SMART";
  languageCode?: string;
  customVocabulary?: string[];
  sourceText?: string;
  audioBase64?: string;
}): Promise<{ text: string; error?: string }> {
  // Simplified: just return sourceText; real refinement would need audio
  return { text: params.sourceText ?? "" };
}

export { Modality, Type };