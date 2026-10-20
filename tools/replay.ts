import { Engine } from "../src/engine";
import {
  DEFAULT_CONFIG,
  type ControlConfig,
  type ExperimentRecord,
} from "../src/types";
/** Fixed historical observations, not a physical model. Stop at first counterfactual balance entry. */
export function replayRecord(
  record: ExperimentRecord,
  overrides: Partial<ControlConfig> = {},
) {
  if (!record.samples.length) throw new Error("记录为空");
  const engine = new Engine(
      () => {},
      () => {},
    ),
    config = { ...DEFAULT_CONFIG, ...record.config, ...overrides };
  const first = record.samples[0],
    base = first.host_time_s - first.relative_time_s;
  engine.pendulumZero = record.pendulumZero;
  engine.pendulumScale = record.pendulumScale ?? 1;
  engine.pendulumCalibrated = record.pendulumCalibrated;
  engine.calibrationBasis = record.calibrationBasis ?? "upright";
  engine.accept({ ...first, tick_us: (first.tick_us - 1) >>> 0 }, base);
  engine.start("swing", config, base, false, undefined, false, true);
  let capture: null | object = null,
    firstDivergence: null | object = null,
    near: object[] = [];
  for (const raw of record.samples) {
    const { sample: s, fresh } = engine.accept(raw, raw.host_time_s);
    if (!fresh) continue;
    if (
      firstDivergence === null &&
      Math.abs(s.target_duty - raw.target_duty) > 0.1
    )
      firstDivergence = {
        time: s.relative_time_s,
        original: raw.target_duty,
        candidate: s.target_duty,
      };
    if (Math.abs(s.pendulum_deg) < config.entryAngle)
      near.push({
        time: s.relative_time_s,
        angle: s.pendulum_deg,
        velocity: s.control_velocity_deg_s,
        phase: s.phase,
      });
    if (s.phase === "balance") {
      capture = {
        time: s.relative_time_s,
        angle: s.pendulum_deg,
        velocity: s.control_velocity_deg_s,
        duty: s.target_duty,
      };
      break;
    }
    if (!engine.active) break;
  }
  return {
    type: "historical-gate-replay",
    counterfactual: true,
    physicalSuccess: false,
    note: "仅在固定历史观测上评估控制逻辑；输出改变后不能预测真实响应。到首次假设接摆即停止回放。",
    config,
    capture,
    firstDivergence,
    near,
  };
}
