import { Controller } from "./controller";
import { DeviceClock, wrapDeg } from "./protocol";
import { summarizeAngles } from "./stillness";
import {
  PHASE_LABEL,
  type Action,
  type ControlConfig,
  type ExperimentEvent,
  type ExperimentRecord,
  type RawSample,
  type SensorSample,
} from "./types";

export const MEMORY_LIMIT = 100 * 1024 * 1024;
// Conservative per-sample allocation budget includes objects, array slots, and UI clone overhead.
export const SAMPLE_BUDGET = 1024;
export class Engine {
  controller = new Controller();
  clock = new DeviceClock();
  latest: SensorSample | null = null;
  motorZero: number | null = null;
  pendulumZero = 0;
  pendulumCalibrated = false;
  calibrationBasis: "down" | "upright" = "down";
  pendulumScale = 1;
  private calibrationWindow: {
    angle: number;
    velocity: number;
    time: number;
  }[] = [];
  memoryBytes = 0;
  record: ExperimentRecord | null = null;
  private previousMotor: number | null = null;
  private continuous = 0;
  constructor(
    private onRecord: (r: ExperimentRecord) => void,
    private onEvent: (e: ExperimentEvent) => void,
    private limit = MEMORY_LIMIT,
  ) {}
  get active() {
    return this.controller.active;
  }
  start(
    action: Action,
    config: ControlConfig,
    now: number,
    simulation: boolean,
    direction?: number,
    calibrateDown = false,
    downConfirmed = false,
  ) {
    if (!this.latest) throw new Error("尚未收到传感器数据");
    if (this.active) throw new Error("请先停止当前动作");
    if (
      action === "swing" &&
      !simulation &&
      (calibrateDown ||
        !this.pendulumCalibrated ||
        this.calibrationBasis !== "upright")
    )
      throw new Error(
        "实机必须先手扶直立并标定；下垂存在传感器盲区，不能推算直立零点",
      );
    if (
      action === "swing" &&
      config.swingMethod === 1 &&
      !simulation &&
      !downConfirmed
    )
      throw new Error(
        "请确认实物自然下垂且已松手；不能根据盲区读数判断初始姿态",
      );
    if (
      action === "swing" &&
      config.swingMethod === 1 &&
      !simulation &&
      config.maxDuty > 40
    )
      throw new Error("当前实机调试 PWM 上限为 40%");
    if (action === "swing" && config.swingMethod === 0 && !simulation)
      throw new Error("当前传感器有下垂盲区，实机请使用原厂脉冲起摆");
    if (
      action === "swing" &&
      simulation &&
      Math.abs(this.latest.pendulum_deg) < 150
    )
      throw new Error(
        "起摆前请让摆杆自然下垂；若实物已下垂，请重新标定下垂位置",
      );
    if (action === "swing" && !simulation && !this.pendulumCalibrated)
      throw new Error("请先让摆杆自然下垂并标定，再起摆");
    // Downward blind-region values cannot establish rest; require the operator's explicit pose confirmation.
    if (this.memoryBytes + SAMPLE_BUDGET > this.limit)
      throw new Error("记录内存已满，请导出并清空记录");
    this.controller.start(action, config, now, direction);
    this.record = {
      id: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      action,
      simulation,
      config: { ...config },
      motorZero: this.motorZero ?? 0,
      pendulumZero: this.pendulumZero,
      pendulumCalibrated: this.pendulumCalibrated || simulation,
      calibrationBasis: this.calibrationBasis,
      pendulumScale: this.pendulumScale,
      samples: [],
      events: [],
      reason: "",
      duration: 0,
    };
    this.event("实验开始", now);
  }
  private event(label: string, now: number) {
    const e = {
      time_s: Math.max(0, now - this.controller.started),
      label,
      phase: this.controller.phase,
    };
    this.record?.events.push(e);
    this.onEvent(e);
  }
  stop(reason: string, now: number) {
    this.controller.stop();
    if (this.record) {
      this.event(reason, now);
      this.record.reason = reason;
      this.record.duration = Math.max(0, now - this.controller.started);
      const completed = this.record;
      this.record = null;
      this.onRecord(completed);
    }
  }
  zero() {
    if (this.active) throw new Error("停止动作后才能设置电机零位");
    if (!this.latest) throw new Error("尚未收到传感器数据");
    this.motorZero = this.latest.motor_raw;
    this.continuous = 0;
  }
  clear() {
    if (this.active) throw new Error("运行期间不能清空记录");
    this.memoryBytes = 0;
  }
  private assertStationary() {
    const samples = this.calibrationWindow;
    if (samples.length < 2 || samples.at(-1)!.time - samples[0].time < 1)
      throw new Error("请保持标定姿态静止至少 1 秒");
    const summary = summarizeAngles(
      samples.map((s) => ({ time: s.time, angle: s.angle })),
    )!;
    // Instantaneous derivative spikes from encoder quantization are not motion evidence.
    // Calibrate a constant offset only; never auto-correct drift in the live angle.
    if (summary.robustSpan > 3 || Math.abs(summary.slope) > 1)
      throw new Error("摆杆仍在运动或读数不稳定，请先做静止检查");
  }
  calibrateUpright() {
    if (this.active) throw new Error("停止动作后才能标定摆杆");
    this.assertStationary();
    const mean =
      this.calibrationWindow.reduce((a, s) => a + s.angle, 0) /
      this.calibrationWindow.length;
    // This device's documented upright ADC is near mid-scale. Reject rails and the downward blind region.
    if (Math.abs(mean) > 30)
      throw new Error("直立读数应接近 ADC 中值，请核对实际姿态、供电和接线");
    this.pendulumZero = mean;
    this.pendulumScale = 333 / 360;
    this.pendulumCalibrated = true;
    this.calibrationBasis = "upright";
    if (this.latest)
      this.latest = {
        ...this.latest,
        pendulum_deg: (this.latest.pendulum_raw - mean) * this.pendulumScale,
        pendulum_down_deg: wrapDeg(
          (this.latest.pendulum_raw - mean) * this.pendulumScale - 180,
        ),
        pendulum_scale: this.pendulumScale,
        control_velocity_deg_s:
          this.latest.pendulum_vel_deg_s * this.pendulumScale,
        pendulum_calibrated: true,
      };
    return this.pendulumZero;
  }
  calibrateDown() {
    if (this.active) throw new Error("停止动作后才能标定摆杆");
    this.assertStationary();
    const samples = this.calibrationWindow;
    const sin = samples.reduce(
      (a, s) => a + Math.sin((s.angle * Math.PI) / 180),
      0,
    );
    const cos = samples.reduce(
      (a, s) => a + Math.cos((s.angle * Math.PI) / 180),
      0,
    );
    this.calibrationBasis = "down";
    this.pendulumScale = 1;
    this.pendulumZero = wrapDeg((Math.atan2(sin, cos) * 180) / Math.PI - 180);
    this.pendulumCalibrated = true;
    if (this.latest)
      this.latest = {
        ...this.latest,
        pendulum_deg: wrapDeg(this.latest.pendulum_raw - this.pendulumZero),
        pendulum_down_deg: wrapDeg(
          this.latest.pendulum_raw - this.pendulumZero - 180,
        ),
        pendulum_calibrated: true,
      };
    return this.pendulumZero;
  }
  resetConnection() {
    this.clock = new DeviceClock();
    this.motorZero = null;
    this.previousMotor = null;
    this.continuous = 0;
    this.latest = null;
    this.pendulumZero = 0;
    this.pendulumCalibrated = false;
    this.calibrationBasis = "down";
    this.pendulumScale = 1;
    this.calibrationWindow = [];
  }
  accept(
    raw: RawSample,
    now: number,
  ): { sample: SensorSample; fresh: boolean } {
    const clock = this.clock.update(raw.tick_us);
    if (clock.reset) this.stop("设备计时重置或跳变", now);
    const fresh = this.latest === null || clock.dt > 0;
    if (fresh) {
      this.calibrationWindow.push({
        angle: raw.pendulum_raw,
        velocity: raw.pendulum_vel_deg_s,
        time: now,
      });
      while (
        this.calibrationWindow.length > 1 &&
        this.calibrationWindow[1].time < now - 1.5
      )
        this.calibrationWindow.shift();
    }
    if (this.motorZero === null) this.motorZero = raw.motor_raw;
    if (this.previousMotor !== null)
      this.continuous += wrapDeg(raw.motor_raw - this.previousMotor);
    this.previousMotor = raw.motor_raw;
    const s: SensorSample = {
      ...raw,
      host_time_s: now,
      device_time_s: clock.seconds,
      relative_time_s: this.active ? now - this.controller.started : 0,
      motor_deg: wrapDeg(raw.motor_raw - this.motorZero),
      motor_cont_deg: this.continuous,
      pendulum_deg:
        (this.calibrationBasis === "upright"
          ? raw.pendulum_raw - this.pendulumZero
          : wrapDeg(raw.pendulum_raw - this.pendulumZero)) * this.pendulumScale,
      pendulum_down_deg: wrapDeg(
        (this.calibrationBasis === "upright"
          ? raw.pendulum_raw - this.pendulumZero
          : wrapDeg(raw.pendulum_raw - this.pendulumZero)) *
          this.pendulumScale -
          180,
      ),
      pendulum_scale: this.pendulumScale,
      control_velocity_deg_s: raw.pendulum_vel_deg_s * this.pendulumScale,
      target_duty: 0,
      phase: this.controller.phase,
      energy: 0,
      pendulum_calibrated: this.pendulumCalibrated,
    };
    const before = this.controller.phase;
    const usingResonant =
      this.active &&
      this.controller.action === "swing" &&
      this.controller.config.swingMethod === 1;
    const output = fresh
      ? this.controller.step(
          { ...s, pendulum_vel_deg_s: s.control_velocity_deg_s! },
          now,
          clock.dt,
        )
      : {
          duty: this.latest?.target_duty ?? 0,
          energy: this.latest?.energy ?? 0,
        };
    if (usingResonant)
      s.control_velocity_deg_s = this.controller.estimatedVelocity;
    s.target_duty = this.active ? output.duty : 0;
    s.phase = this.controller.phase;
    s.energy = output.energy;
    if (before !== s.phase) this.event(PHASE_LABEL[s.phase], now);
    if (this.record) {
      if (this.memoryBytes + SAMPLE_BUDGET > this.limit) {
        s.target_duty = 0;
        this.stop("记录达到 100 MiB 内存预算", now);
        s.phase = "idle";
      } else {
        this.record.samples.push(s);
        this.memoryBytes += SAMPLE_BUDGET;
      }
    }
    if (output.reason) this.stop(output.reason, now);
    this.latest = s;
    return { sample: s, fresh };
  }
}
