import { useEffect, useRef } from "react";
import type { ConnectionState } from "../types/transcribe";

interface WaveformVisualizerProps {
  analyser: AnalyserNode | null;
  state: ConnectionState;
  isDark: boolean;
}

interface WaveLayer {
  freq: number;
  speed: number;
  ampScale: number;
  phase: number;
  lineWidth: number;
  colorDark: string;
  colorLight: string;
  glowDark?: string;
}

const WAVE_LAYERS: WaveLayer[] = [
  {
    freq: 2.0,
    speed: 0.032,
    ampScale: 0.88,
    phase: 0.2,
    lineWidth: 1.25,
    colorDark: "rgba(56, 189, 248, 0.42)",
    colorLight: "rgba(37, 99, 235, 0.28)",
  },
  {
    freq: 3.1,
    speed: -0.044,
    ampScale: 1.0,
    phase: 1.5,
    lineWidth: 1.45,
    colorDark: "rgba(96, 165, 250, 0.56)",
    colorLight: "rgba(14, 165, 233, 0.4)",
  },
  {
    freq: 1.55,
    speed: 0.026,
    ampScale: 0.72,
    phase: 2.9,
    lineWidth: 1.65,
    colorDark: "rgba(125, 211, 252, 0.72)",
    colorLight: "rgba(2, 132, 199, 0.58)",
  },
  {
    freq: 2.35,
    speed: 0.052,
    ampScale: 0.94,
    phase: 4.2,
    lineWidth: 2.25,
    colorDark: "rgba(240, 249, 255, 0.96)",
    colorLight: "rgba(3, 105, 161, 0.9)",
    glowDark: "rgba(56, 189, 248, 0.9)",
  },
];

export function WaveformVisualizer({
  analyser,
  state,
  isDark,
}: WaveformVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let rafId = 0;
    let tick = 0;
    let smoothedEnergy = 0.44;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const freqData = analyser
      ? new Uint8Array(analyser.frequencyBinCount)
      : new Uint8Array(0);

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    const renderFrame = (advanceTick: boolean) => {
      const width = canvas.width;
      const height = canvas.height;
      if (width === 0 || height === 0) return;

      ctx.clearRect(0, 0, width, height);

      const isActive = state === "listening" && analyser !== null;
      let targetEnergy =
        state === "connecting" ? 0.58 : state === "paused" ? 0.3 : 0.44;

      if (isActive && analyser && freqData.length > 0) {
        analyser.getByteFrequencyData(freqData);
        const speechBins = Math.max(1, Math.floor(freqData.length * 0.45));
        let sum = 0;
        for (let b = 0; b < speechBins; b++) {
          sum += freqData[b];
        }
        const avg = sum / (speechBins * 255);
        targetEnergy = Math.min(1.0, Math.max(0.36, Math.pow(avg * 2.3, 0.82)));
      }

      if (prefersReducedMotion) {
        smoothedEnergy = targetEnergy;
      } else if (advanceTick) {
        smoothedEnergy +=
          (targetEnergy - smoothedEnergy) * (isActive ? 0.25 : 0.08);
        tick += isActive ? 1.25 : 0.42;
      }

      const centerY = height / 2;
      const maxAmp = height * 0.4 * smoothedEnergy;
      const steps = 104;

      for (const layer of WAVE_LAYERS) {
        const buildPath = () => {
          ctx.beginPath();
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const x = t * width;
            const envelope = Math.pow(Math.sin(Math.PI * t), 1.55);

            let freqMod = 0;
            if (isActive && freqData.length > 0) {
              const bin = Math.min(
                freqData.length - 1,
                Math.floor(Math.abs(t - 0.5) * 2 * (freqData.length * 0.4))
              );
              freqMod = (freqData[bin] / 255) * 0.38;
            }

            const angle =
              t * Math.PI * 2 * layer.freq +
              layer.phase +
              tick * layer.speed;
            const harmonic =
              Math.sin(angle) * 0.72 +
              Math.sin(angle * 1.85 - tick * layer.speed * 0.6) * 0.28;

            const y =
              centerY +
              harmonic * envelope * maxAmp * layer.ampScale * (1 + freqMod);

            if (s === 0) {
              ctx.moveTo(x, y);
            } else {
              ctx.lineTo(x, y);
            }
          }
        };

        if (isDark && layer.glowDark) {
          buildPath();
          ctx.lineWidth = layer.lineWidth * 3.2 * dpr;
          ctx.strokeStyle = "rgba(56, 189, 248, 0.22)";
          ctx.stroke();
        }

        buildPath();
        ctx.lineWidth = layer.lineWidth * dpr;
        ctx.strokeStyle = isDark ? layer.colorDark : layer.colorLight;
        ctx.stroke();
      }
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
        renderFrame(false);
      }
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const shouldAnimate =
      (state === "listening" || state === "connecting") &&
      !prefersReducedMotion;

    const loop = () => {
      renderFrame(true);
      if (shouldAnimate) {
        rafId = requestAnimationFrame(loop);
      }
    };

    if (shouldAnimate) {
      rafId = requestAnimationFrame(loop);
    } else {
      renderFrame(false);
    }

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [analyser, state, isDark]);

  return (
    <canvas
      ref={canvasRef}
      aria-label="Live microphone waveform"
      className="block h-24 w-full sm:h-28"
    />
  );
}
