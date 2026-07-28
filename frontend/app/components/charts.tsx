"use client";

import { useEffect, useRef } from "react";

type ChartKind = "candles" | "equity" | "drawdown" | "distribution";

type CandleChartOptions = {
  showEma20: boolean;
  showEma50: boolean;
  showVolume: boolean;
};

function seededSeries(length: number, seed: number) {
  let value = seed;
  let state = seed * 9973;
  const random = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };

  return Array.from({ length }, (_, index) => {
    const open = value;
    const cycle = Math.sin(index / 7) * 0.45 + Math.sin(index / 19) * 0.8;
    const delta = (random() - 0.48) * 2.4 + cycle;
    const close = open + delta;
    const high = Math.max(open, close) + random() * 1.8;
    const low = Math.min(open, close) - random() * 1.8;
    value = close;
    return { open, high, low, close, volume: 20 + random() * 80 };
  });
}

function sizeCanvas(canvas: HTMLCanvasElement) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function drawGrid(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  context.strokeStyle = "#1d2631";
  context.lineWidth = 1;
  for (let x = 0; x <= width; x += Math.max(70, width / 10)) {
    context.beginPath();
    context.moveTo(Math.round(x) + 0.5, 0);
    context.lineTo(Math.round(x) + 0.5, height);
    context.stroke();
  }
  for (let y = 0; y <= height; y += Math.max(50, height / 7)) {
    context.beginPath();
    context.moveTo(0, Math.round(y) + 0.5);
    context.lineTo(width, Math.round(y) + 0.5);
    context.stroke();
  }
}

function drawCandles(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  seed: number,
  options: CandleChartOptions,
) {
  const series = seededSeries(92, seed);
  const priceHeight = height * 0.78;
  const min = Math.min(...series.map((item) => item.low));
  const max = Math.max(...series.map((item) => item.high));
  const range = max - min || 1;
  const xStep = width / series.length;
  const priceY = (value: number) =>
    14 + ((max - value) / range) * (priceHeight - 28);

  series.forEach((item, index) => {
    const x = index * xStep + xStep / 2;
    const up = item.close >= item.open;
    const color = up ? "#16c784" : "#ff4d61";
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, priceY(item.high));
    context.lineTo(x, priceY(item.low));
    context.stroke();
    const bodyTop = priceY(Math.max(item.open, item.close));
    const bodyBottom = priceY(Math.min(item.open, item.close));
    context.fillRect(
      x - Math.max(1.5, xStep * 0.29),
      bodyTop,
      Math.max(2.5, xStep * 0.58),
      Math.max(1, bodyBottom - bodyTop),
    );

    if (options.showVolume) {
      const volumeHeight = (item.volume / 100) * (height * 0.16);
      context.globalAlpha = 0.25;
      context.fillRect(
        x - Math.max(1.5, xStep * 0.29),
        height - volumeHeight,
        Math.max(2.5, xStep * 0.58),
        volumeHeight,
      );
      context.globalAlpha = 1;
    }
  });

  const ema = (period: number) => {
    const alpha = 2 / (period + 1);
    let current = series[0].close;
    return series.map((item) => {
      current = item.close * alpha + current * (1 - alpha);
      return current;
    });
  };

  const drawLine = (values: number[], color: string) => {
    context.strokeStyle = color;
    context.lineWidth = 1.4;
    context.beginPath();
    values.forEach((value, index) => {
      const x = index * xStep + xStep / 2;
      const y = priceY(value);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  };

  if (options.showEma20) drawLine(ema(12), "#00c7d9");
  if (options.showEma50) drawLine(ema(28), "#ffb020");

  const last = series.at(-1)?.close ?? seed;
  const lastY = priceY(last);
  context.setLineDash([3, 3]);
  context.strokeStyle = "#6ce5a8";
  context.beginPath();
  context.moveTo(0, lastY);
  context.lineTo(width, lastY);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = "#6ce5a8";
  context.font = "11px ui-monospace, monospace";
  context.fillText(`SIM ${last.toFixed(2)}`, Math.max(8, width - 92), lastY - 6);
}

function drawLineChart(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  kind: "equity" | "drawdown",
) {
  const points = kind === "equity"
    ? [10000, 10090, 10030, 10170, 10140, 10280, 10210, 10340, 10420, 10370, 10510, 10480, 10620]
    : [0, -0.2, -0.65, -0.18, -0.48, -1.0, -0.72, -0.25, -0.1, -0.5, -0.32, -0.08, 0];
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const coordinates = points.map((value, index) => ({
    x: (index / (points.length - 1)) * width,
    y: 18 + ((max - value) / range) * (height - 36),
  }));
  const color = kind === "equity" ? "#16c784" : "#ff4d61";

  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, kind === "equity" ? "rgba(22,199,132,.28)" : "rgba(255,77,97,.32)");
  gradient.addColorStop(1, "rgba(8,12,17,0)");

  context.beginPath();
  coordinates.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.lineTo(width, height);
  context.lineTo(0, height);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  coordinates.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.stroke();
}

function drawDistribution(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const values = [3, 4, 5, 7, 9, 12, 15, 13, 9, 7, 5, 3, 2];
  const max = Math.max(...values);
  const gap = 5;
  const barWidth = width / values.length - gap;
  values.forEach((value, index) => {
    const barHeight = (value / max) * (height - 28);
    const x = index * (width / values.length) + gap / 2;
    const positive = index >= Math.floor(values.length / 2);
    context.fillStyle = positive ? "#16c784" : "#ff4d61";
    context.globalAlpha = 0.82;
    context.fillRect(x, height - barHeight, barWidth, barHeight);
  });
  context.globalAlpha = 1;
}

export function ChartCanvas({
  kind = "candles",
  seed = 4044,
  className = "",
  showEma20 = true,
  showEma50 = true,
  showVolume = true,
}: {
  kind?: ChartKind;
  seed?: number;
  className?: string;
  showEma20?: boolean;
  showEma50?: boolean;
  showVolume?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const draw = () => {
      const sized = sizeCanvas(canvas);
      if (!sized) return;
      const { context, width, height } = sized;
      context.clearRect(0, 0, width, height);
      context.fillStyle = "#090d13";
      context.fillRect(0, 0, width, height);
      drawGrid(context, width, height);
      if (kind === "candles") {
        drawCandles(context, width, height, seed, {
          showEma20,
          showEma50,
          showVolume,
        });
      }
      if (kind === "equity" || kind === "drawdown") {
        drawLineChart(context, width, height, kind);
      }
      if (kind === "distribution") drawDistribution(context, width, height);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [kind, seed, showEma20, showEma50, showVolume]);

  return (
    <canvas
      ref={ref}
      className={`chart-canvas ${className}`}
      aria-label={`${kind} chart using generated simulation data`}
      role="img"
    />
  );
}
