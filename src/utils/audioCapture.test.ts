import test from "node:test";
import assert from "node:assert/strict";
import {
  applyVocalPresenceConditioning,
  bcp47ToScriptFamily,
  buildExportContent,
  cleanTranscriptArtifacts,
  countWords,
  createStreamingSpeechConditioner,
  detectScriptFamily,
  downsampleBuffer,
  float32ToBase64Pcm16,
  formatDuration,
  formatSpeakerDisplay,
  formatSrtTime,
  normalizeSpeechDynamics,
  reconcileFocusedTranscripts,
  splitTextIntoTimedCues,
  stitchChunkBoundary,
} from "./audioCapture";
import type { TranscriptionSession } from "../types/transcribe";

test("speech conditioning helpers boost quiet speech smoothly without clipping peaks", () => {
  const quietWave = new Float32Array(1600);
  for (let i = 0; i < quietWave.length; i++) {
    quietWave[i] = Math.sin((2 * Math.PI * 220 * i) / 16000) * 0.025;
  }
  const normalized = normalizeSpeechDynamics(quietWave);
  const peakNorm = Math.max(...Array.from(normalized, Math.abs));
  assert.ok(peakNorm > 0.08 && peakNorm <= 0.96);

  const clarified = applyVocalPresenceConditioning(quietWave);
  assert.equal(clarified.length, quietWave.length);
  const peakClar = Math.max(...Array.from(clarified, Math.abs));
  assert.ok(peakClar > 0.05 && peakClar <= 0.96);

  const conditioner = createStreamingSpeechConditioner(16000);
  const out1 = conditioner(quietWave.subarray(0, 800));
  const out2 = conditioner(quietWave.subarray(800, 1600));
  assert.equal(out1.length, 800);
  assert.equal(out2.length, 800);
});

test("downsampleBuffer performs 3:1 box decimation from 48kHz to 16kHz", () => {
  const input = new Float32Array([1, 2, 3, 4, 5, 6]);
  const out = downsampleBuffer(input, 48000, 16000);
  assert.equal(out.length, 2);
  assert.equal(out[0], 2);
  assert.equal(out[1], 5);
});

test("float32ToBase64Pcm16 encodes PCM16 little-endian bytes", () => {
  const b64 = float32ToBase64Pcm16(new Float32Array([0, 1, -1]));
  const buf = Buffer.from(b64, "base64");
  assert.equal(buf.length, 6);
  assert.equal(buf.readInt16LE(0), 0);
  assert.equal(buf.readInt16LE(2), 0x7fff);
  assert.equal(buf.readInt16LE(4), -0x8000);
});

test("cleanTranscriptArtifacts fixes spacing and collapses 3+ word loops", () => {
  assert.equal(cleanTranscriptArtifacts("Hello ,  world !"), "Hello, world!");
  assert.equal(
    cleanTranscriptArtifacts("thank you thank you thank you thank you"),
    "thank you"
  );
});

test("stitchChunkBoundary deduplicates overlap across chunk edges", () => {
  assert.equal(
    stitchChunkBoundary("We met yesterday morning", "yesterday morning to review"),
    "to review"
  );
  assert.equal(
    stitchChunkBoundary("First sentence.", "Completely new thought"),
    "Completely new thought"
  );
});

test("reconcileFocusedTranscripts picks consensus over outlier pass", () => {
  const res = reconcileFocusedTranscripts([
    { text: "Quarterly budget review starts on Tuesday", lang: "en-US" },
    { text: "Quarterly budget review starts on Tuesday morning", lang: "en-US", isSmart: true },
    { text: "unrelated noise", lang: "en-US" },
  ]);
  assert.match(res.text, /Quarterly budget review starts on Tuesday/);
  assert.equal(res.lang, "en-US");
});

test("detectScriptFamily and bcp47ToScriptFamily identify non-Latin scripts", () => {
  assert.equal(detectScriptFamily("ሰላም ለሁላችሁ"), "ethiopic");
  assert.equal(detectScriptFamily("Hello world"), "latin");
  assert.equal(bcp47ToScriptFamily("am-ET"), "ethiopic");
  assert.equal(bcp47ToScriptFamily("en-US"), "latin");
  assert.equal(bcp47ToScriptFamily("auto"), null);
});

test("splitTextIntoTimedCues distributes timestamps monotonically", () => {
  const cues = splitTextIntoTimedCues(
    "First sentence here. Second sentence follows.",
    1000,
    5000
  );
  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[1].endMs, 5000);
  assert.ok(cues[0].endMs <= cues[1].startMs + 1);
});

test("formatting and export helpers produce valid txt, md, srt, and json", () => {
  assert.equal(formatDuration(65000), "01:05");
  assert.equal(formatDuration(3661000), "01:01:01");
  assert.equal(formatSrtTime(3661042), "01:01:01,042");
  assert.equal(countWords("one two three"), 3);
  assert.equal(formatSpeakerDisplay("spk_2", {}), "Speaker 2");
  assert.equal(formatSpeakerDisplay("spk_1", { spk_1: "Alice" }), "Alice");

  const session: TranscriptionSession = {
    id: "s1",
    title: "Test Call",
    createdAt: 1700000000000,
    updatedAt: 1700000010000,
    durationMs: 5000,
    segments: [
      { id: "seg1", text: "Hello there.", speakerId: "spk_1", timestampMs: 0, endTimestampMs: 2500 },
    ],
    speakerNames: { spk_1: "Alice" },
    detectedLanguages: ["en-US"],
    config: {
      mode: "VERBATIM",
      languageCode: "auto",
      diarization: true,
      wordTimestamp: false,
      customVocabulary: [],
    },
  };

  const srt = buildExportContent(session, "srt");
  assert.match(srt.content, /00:00:00,000 --> 00:00:02,500/);
  assert.match(srt.content, /Alice: Hello there\./);
  assert.equal(buildExportContent(session, "md").extension, "md");
  assert.equal(buildExportContent(session, "txt").extension, "txt");
  assert.equal(buildExportContent(session, "json").extension, "json");
});
