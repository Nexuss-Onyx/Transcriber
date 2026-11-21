import { useEffect, useRef } from "react";
import type { ConnectionState } from "../types/transcribe";

interface WaveformVisualizerProps {
  analyser: AnalyserNode | null;
  state: ConnectionState;
  isDark: boolean;
}

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
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
      }
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const barCount = 44;
    const smoothed = new Float32Array(barCount);
    const freqData = analyser
      ? new Uint8Array(analyser.frequencyBinCount)
      : new Uint8Array(0);

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    const draw = () => {
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      const isActive = state === "listening" && analyser !== null;
      if (isActive && analyser) {
        analyser.getByteFrequencyData(freqData);
      }

      const gap = 3 * dpr;
      const totalGap = gap * (barCount - 1);
      const barWidth = Math.max(2 * dpr, (width - totalGap) / barCount);
      const centerY = height / 2;

      for (let i = 0; i < barCount; i++) {
        let target = 0.06;
        if (isActive && freqData.length > 0) {
          // Focus on speech frequency range (roughly lower-mid bins)
          const binIndex = Math.min(
            freqData.length - 1,
            Math.floor((i / barCount) * (freqData.length * 0.55))
          );
          const norm = freqData[binIndex] / 255;
          target = Math.max(0.08, Math.pow(norm, 0.85));
        } else if (state === "connecting") {
          target = 0.14;
        }

        if (prefersReducedMotion) {
          smoothed[i] = target;
        } else {
          smoothed[i] += (target - smoothed[i]) * (isActive ? 0.35 : 0.18);
        }

        const barHeight = Math.max(3 * dpr, smoothed[i] * (height * 0.86));
        const x = i * (barWidth + gap);
        const y = centerY - barHeight / 2;

        if (isActive) {
          ctx.fillStyle = isDark ? "#fb7185" : "#e11d48";
        } else if (state === "paused") {
          ctx.fillStyle = isDark ? "#f59e0b" : "#d97706";
        } else {
          ctx.fillStyle = isDark ? "#334155" : "#cbd5e1";
        }

        ctx.beginPath();
        const radius = Math.min(barWidth / 2, 2 * dpr);
        ctx.roundRect(x, y, barWidth, barHeight, radius);
        ctx.fill();
      }

      if (isActive || smoothed.some((v) => v > 0.075)) {
        rafId = requestAnimationFrame(draw);
      }
    };

    draw();

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [analyser, state, isDark]);

  return (
    <canvas
      ref={canvasRef}
      aria-label="Live microphone waveform"
      className="h-9 w-full block"
    />
  );
}
