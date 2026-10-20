import { wrapDeg } from "./protocol";
import type { SensorSample } from "./types";
export interface AngleSummary {
  span: number;
  robustSpan: number;
  change: number;
  slope: number;
  mean: number;
}
export function summarizeAngles(
  points: { time: number; angle: number }[],
): AngleSummary | null {
  if (points.length < 2 || points.at(-1)!.time <= points[0].time) return null;
  const angles = [points[0].angle];
  for (let i = 1; i < points.length; i++)
    angles.push(angles[i - 1] + wrapDeg(points[i].angle - points[i - 1].angle));
  const sorted = [...angles].sort((a, b) => a - b),
    count = angles.length;
  const mt = points.reduce((n, p) => n + p.time, 0) / count,
    mean = angles.reduce((a, b) => a + b, 0) / count;
  let numerator = 0,
    denominator = 0;
  for (let i = 0; i < count; i++) {
    const t = points[i].time - mt;
    numerator += t * (angles[i] - mean);
    denominator += t * t;
  }
  const edge = Math.max(1, Math.floor(count * 0.2));
  return {
    span: sorted.at(-1)! - sorted[0],
    robustSpan:
      sorted[Math.floor((count - 1) * 0.95)] -
      sorted[Math.floor((count - 1) * 0.05)],
    change:
      angles.slice(-edge).reduce((a, b) => a + b, 0) / edge -
      angles.slice(0, edge).reduce((a, b) => a + b, 0) / edge,
    slope: numerator / denominator,
    mean,
  };
}
export function stillnessReport(samples: SensorSample[]) {
  return {
    motor: summarizeAngles(
      samples.map((s) => ({ time: s.host_time_s, angle: s.motor_raw })),
    ),
    pendulum: summarizeAngles(
      samples.map((s) => ({ time: s.host_time_s, angle: s.pendulum_raw })),
    ),
  };
}
