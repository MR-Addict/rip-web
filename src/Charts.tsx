import { useEffect, useRef, useState } from "react";
import type { SensorSample } from "./types";

type Channel = {
  key: keyof SensorSample;
  label: string;
  color: string;
  unit: string;
};
export const CHANNELS: Channel[] = [
  { key: "pendulum_deg", label: "摆杆角度", color: "#b56b24", unit: "°" },
  { key: "motor_deg", label: "旋臂角度", color: "#2861ad", unit: "°" },
  {
    key: "pendulum_vel_deg_s",
    label: "摆杆角速度",
    color: "#b56b24",
    unit: "°/s",
  },
  {
    key: "motor_vel_deg_s",
    label: "旋臂角速度",
    color: "#2861ad",
    unit: "°/s",
  },
  { key: "target_duty", label: "目标 PWM", color: "#a67522", unit: "%" },
  { key: "duty", label: "反馈 PWM", color: "#7858ac", unit: "%" },
];
export function Scope({
  samples,
  channels,
  windowSeconds,
  title,
  unit,
}: {
  samples: SensorSample[];
  channels: Channel[];
  windowSeconds: number;
  title: string;
  unit: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [enabled, setEnabled] = useState(
    () => new Set(channels.map((c) => c.key)),
  );
  const last = samples.at(-1);
  const end = last?.host_time_s ?? windowSeconds;
  const start = end - windowSeconds;
  const data = samples.filter((s) => s.host_time_s >= start);
  const cursorSample =
    hover === null || !data.length
      ? null
      : data.reduce(
          (best, s) =>
            Math.abs(s.host_time_s - (start + hover * windowSeconds)) <
            Math.abs(best.host_time_s - (start + hover * windowSeconds))
              ? s
              : best,
          data[0],
        );
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => setWidth(canvas.clientWidth));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const w = canvas.clientWidth,
      h = canvas.clientHeight,
      dpr = devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    const pad = { l: 48, r: 12, t: 15, b: 22 },
      cw = w - pad.l - pad.r,
      ch = h - pad.t - pad.b;
    const visible = channels.filter((c) => enabled.has(c.key));
    let max = unit === "%" ? 100 : unit === "°" ? 180 : 50;
    for (const s of data)
      for (const c of visible)
        max = Math.max(max, Math.abs(Number(s[c.key])) * 1.1);
    max = Math.ceil(max / (unit === "%" ? 20 : 10)) * (unit === "%" ? 20 : 10);
    const x = (t: number) => pad.l + ((t - start) / windowSeconds) * cw;
    const y = (v: number) => pad.t + ch / 2 - ((v / max) * ch) / 2;
    ctx.font = '10px "SFMono-Regular", Consolas, monospace';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const yy = pad.t + (ch * i) / 4;
      ctx.strokeStyle = i === 2 ? "#cbd4de" : "#e7ecf1";
      ctx.beginPath();
      ctx.moveTo(pad.l, yy);
      ctx.lineTo(w - pad.r, yy);
      ctx.stroke();
      ctx.fillStyle = "#677b8d";
      ctx.textAlign = "right";
      ctx.fillText(
        String(Math.round(max - (2 * max * i) / 4)),
        pad.l - 9,
        yy + 3,
      );
    }
    for (let i = 0; i <= 6; i++) {
      const xx = pad.l + (cw * i) / 6;
      ctx.strokeStyle = "#e7ecf1";
      ctx.beginPath();
      ctx.moveTo(xx, pad.t);
      ctx.lineTo(xx, h - pad.b);
      ctx.stroke();
      ctx.fillStyle = "#607385";
      ctx.textAlign = "center";
      ctx.fillText(
        `${(-windowSeconds + (windowSeconds * i) / 6).toFixed(windowSeconds <= 5 ? 1 : 0)}s`,
        xx,
        h - 5,
      );
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, cw, ch);
    ctx.clip();
    // Bucket min/max preserves brief pulses while bounding the number of drawing operations.
    for (const channel of visible) {
      ctx.strokeStyle = channel.color;
      ctx.lineWidth = 1.35;
      ctx.beginPath();
      let previousBucket = -1,
        min = 0,
        maxV = 0,
        first = true;
      const drawBucket = () => {
        if (previousBucket < 0) return;
        const xx = pad.l + previousBucket;
        if (first) {
          ctx.moveTo(xx, y(min));
          first = false;
        } else ctx.lineTo(xx, y(min));
        ctx.lineTo(xx, y(maxV));
      };
      for (const s of data) {
        const bucket = Math.floor(x(s.host_time_s) - pad.l),
          v = Number(s[channel.key]);
        if (bucket !== previousBucket) {
          drawBucket();
          previousBucket = bucket;
          min = maxV = v;
        } else {
          min = Math.min(min, v);
          maxV = Math.max(maxV, v);
        }
      }
      drawBucket();
      ctx.stroke();
    }
    let phase = data[0]?.phase;
    for (const s of data)
      if (s.phase !== phase) {
        phase = s.phase;
        if (phase === "balance" || phase === "kick") {
          ctx.setLineDash([3, 4]);
          ctx.strokeStyle = "#6f8c7980";
          ctx.beginPath();
          ctx.moveTo(x(s.host_time_s), pad.t);
          ctx.lineTo(x(s.host_time_s), h - pad.b);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    if (cursorSample) {
      ctx.strokeStyle = "#526c8f99";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x(cursorSample.host_time_s), pad.t);
      ctx.lineTo(x(cursorSample.host_time_s), h - pad.b);
      ctx.stroke();
    }
    ctx.restore();
  }, [samples, channels, windowSeconds, enabled, hover, width]);
  return (
    <div className="scope">
      <div className="scope-head">
        <span>
          {title} <small>{unit}</small>
        </span>
        <div className="legend">
          {channels.map((c) => (
            <button
              key={c.key}
              className={!enabled.has(c.key) ? "muted" : ""}
              onClick={() =>
                setEnabled((prev) => {
                  const n = new Set(prev);
                  n.has(c.key) ? n.delete(c.key) : n.add(c.key);
                  return n;
                })
              }
            >
              <i style={{ background: c.color }} />
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div
        className="canvas-wrap"
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(
            Math.max(
              0,
              Math.min(1, (e.clientX - r.left - 48) / (r.width - 60)),
            ),
          );
        }}
        onPointerLeave={() => setHover(null)}
      >
        <canvas ref={ref} />
        {cursorSample && (
          <div className="chart-tooltip">
            {cursorSample.relative_time_s.toFixed(3)}s{" "}
            {channels
              .filter((c) => enabled.has(c.key))
              .map((c) => (
                <span key={c.key} style={{ color: c.color }}>
                  {c.label} {Number(cursorSample[c.key]).toFixed(2)}
                  {unit}
                </span>
              ))}
          </div>
        )}
        {!data.length && <div className="chart-empty">等待传感器数据</div>}
      </div>
    </div>
  );
}
export function AnalysisPlot({
  samples,
  kind,
}: {
  samples: SensorSample[];
  kind: "phase" | "energy";
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const o = new ResizeObserver(() => setWidth(ref.current?.clientWidth ?? 0));
    if (ref.current) o.observe(ref.current);
    return () => o.disconnect();
  }, []);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const w = canvas.clientWidth,
      h = canvas.clientHeight,
      dpr = devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const c = canvas.getContext("2d")!;
    c.scale(dpr, dpr);
    const l = 55,
      r = 22,
      t = 24,
      b = 40,
      cw = w - l - r,
      ch = h - t - b;
    const data = samples.slice(-10000);
    const end = data.at(-1)?.host_time_s ?? 0;
    let ymax = kind === "energy" ? 3 : 200;
    for (const s of data)
      ymax = Math.max(
        ymax,
        kind === "energy"
          ? s.energy * 1.1
          : Math.abs(s.pendulum_vel_deg_s) * 1.1,
      );
    const x = (s: SensorSample) =>
      kind === "phase"
        ? l + ((s.pendulum_deg + 180) / 360) * cw
        : l + ((s.host_time_s - end + 30) / 30) * cw;
    const y = (v: number) =>
      t + ch - (kind === "energy" ? v / ymax : (v + ymax) / (2 * ymax)) * ch;
    c.font = "11px monospace";
    for (let i = 0; i <= 6; i++) {
      c.strokeStyle = "#e1e7ee";
      c.beginPath();
      c.moveTo(l + (cw * i) / 6, t);
      c.lineTo(l + (cw * i) / 6, h - b);
      c.stroke();
      c.fillStyle = "#758697";
      c.textAlign = "center";
      c.fillText(
        String(kind === "phase" ? -180 + 60 * i : -30 + 5 * i),
        l + (cw * i) / 6,
        h - b + 20,
      );
    }
    for (let i = 0; i <= 4; i++) {
      c.strokeStyle = "#e1e7ee";
      c.beginPath();
      c.moveTo(l, t + (ch * i) / 4);
      c.lineTo(w - r, t + (ch * i) / 4);
      c.stroke();
      c.fillStyle = "#758697";
      c.textAlign = "right";
      c.fillText(
        (kind === "energy"
          ? ymax - (ymax * i) / 4
          : ymax - (2 * ymax * i) / 4
        ).toFixed(1),
        l - 8,
        t + (ch * i) / 4 + 4,
      );
    }
    c.save();
    c.beginPath();
    c.rect(l, t, cw, ch);
    c.clip();
    if (kind === "energy") {
      c.strokeStyle = "#a67522";
      c.setLineDash([5, 5]);
      c.beginPath();
      c.moveTo(l, y(2));
      c.lineTo(w - r, y(2));
      c.stroke();
      c.setLineDash([]);
    }
    c.strokeStyle = "#b56b24";
    c.lineWidth = 1.4;
    c.beginPath();
    let prev: SensorSample | null = null;
    const stride = Math.max(1, Math.floor(data.length / 4000));
    for (let i = 0; i < data.length; i += stride) {
      const s = data[i];
      const yy = y(kind === "energy" ? s.energy : s.pendulum_vel_deg_s);
      if (
        !prev ||
        (kind === "phase" && Math.abs(s.pendulum_deg - prev.pendulum_deg) > 180)
      )
        c.moveTo(x(s), yy);
      else c.lineTo(x(s), yy);
      prev = s;
    }
    c.stroke();
    const last = data.at(-1);
    if (last) {
      c.fillStyle = "#99591c";
      c.beginPath();
      c.arc(
        x(last),
        y(kind === "energy" ? last.energy : last.pendulum_vel_deg_s),
        4,
        0,
        Math.PI * 2,
      );
      c.fill();
    }
    c.restore();
    c.fillStyle = "#8b9aa8";
    c.textAlign = "center";
    c.fillText(
      kind === "phase" ? "摆杆角度 θ / °" : "时间 / s",
      l + cw / 2,
      h - 5,
    );
  }, [samples, kind, width]);
  return (
    <div className="analysis-plot">
      <canvas ref={ref} />
      {!samples.length && <div className="chart-empty">等待数据</div>}
    </div>
  );
}
