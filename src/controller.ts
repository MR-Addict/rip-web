import { ResonantSwing } from "./resonant";
import { clamp, wrapDeg } from "./protocol";
import {
  DEFAULT_CONFIG,
  type Action,
  type ControlConfig,
  type Phase,
  type SensorSample,
} from "./types";

export function validateConfig(c: ControlConfig): void {
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof ControlConfig)[])
    if (!Number.isFinite(c[key])) throw new Error(`参数 ${key} 无效`);
  if (
    !Number.isInteger(c.bootstrapPairs) ||
    c.bootstrapPairs < 1 ||
    c.bootstrapPairs > 3
  )
    throw new Error("启动脉冲组数范围为 1～3");
  if (
    ![0, 1].includes(c.swingMethod) ||
    ![-1, 1].includes(c.motorPolarity) ||
    c.turnMargin < 0.2 ||
    c.turnMargin > 10 ||
    c.travelLimit < 30 ||
    c.travelLimit > 360 ||
    (c.swingMethod === 1 && c.kickMs < 20)
  )
    throw new Error("起摆方式、方向或限位参数无效");
  if (
    c.maxDuty <= 0 ||
    c.maxDuty > 100 ||
    c.omegaN <= 0 ||
    c.energyLpf < 0 ||
    c.energyLpf >= 1 ||
    c.duration <= 0 ||
    c.duration > 600 ||
    c.kickMs < 0 ||
    c.kickMs > 500 ||
    c.pulseMs <= 0 ||
    c.pulseMs > 10000 ||
    c.sineHz <= 0 ||
    c.sineHz > 20 ||
    c.sineSeconds <= 0 ||
    c.sineSeconds > 600 ||
    c.coastMs < 0 ||
    c.coastMs > 500
  )
    throw new Error("参数超出范围");
  if (
    [c.kickDuty, c.jogDuty, c.sineDuty, c.deadzone].some(
      (x) => x < 0 || x > c.maxDuty,
    ) ||
    Math.abs(c.pulseDuty) > c.maxDuty
  )
    throw new Error("动作幅值不能超过 PWM 上限");
  if (
    c.entryDwellMs < 5 ||
    c.entryDwellMs > 80 ||
    (c.swingMethod === 1 && c.entryVelocity >= c.exitVelocity)
  )
    throw new Error("接摆确认时间或速度门限无效");
  if (
    c.entryAngle <= 0 ||
    c.exitAngle <= c.entryAngle ||
    c.exitAngle > 90 ||
    c.entryVelocity <= 0 ||
    c.exitVelocity <= 0 ||
    [c.kp, c.ki, c.kd, c.outerKp, c.outerKi, c.outerKd, c.swingGain].some(
      (x) => x < 0,
    )
  )
    throw new Error("控制增益或切换阈值无效");
}
export class Controller {
  active = false;
  phase: Phase = "idle";
  action: Action = "swing";
  config = { ...DEFAULT_CONFIG };
  started = 0;
  private resonant = new ResonantSwing();
  private direction = 1;
  private filtered: number | null = null;
  private integral = 0;
  private outerIntegral = 0;
  private coastUntil = 0;
  private coastArmed = true;
  private history: { t: number; v: number }[] = [];
  start(action: Action, config: ControlConfig, now: number, direction = 1) {
    if (this.active) throw new Error("请先停止当前动作");
    validateConfig(config);
    this.resonant = new ResonantSwing();
    this.config = { ...config };
    this.action = action;
    this.started = now;
    this.direction = direction < 0 ? -1 : 1;
    this.filtered = null;
    this.integral = this.outerIntegral = this.coastUntil = 0;
    this.history = [];
    this.coastArmed = true;
    this.active = true;
    this.phase = action === "swing" ? "kick" : action;
  }
  get estimatedVelocity() {
    return this.resonant.estimatedVelocity;
  }
  get pulseDeadline() {
    const start = this.resonant.outputDeadline;
    return this.active &&
      this.action === "swing" &&
      this.config.swingMethod === 1 &&
      start !== null
      ? start + this.config.kickMs / 1000
      : null;
  }
  stop() {
    this.active = false;
    this.phase = "idle";
    this.integral = this.outerIntegral = 0;
  }
  step(
    s: Pick<
      SensorSample,
      | "pendulum_deg"
      | "pendulum_vel_deg_s"
      | "motor_cont_deg"
      | "motor_vel_deg_s"
    > & { device_time_s?: number },
    now: number,
    dt: number,
  ): { duty: number; energy: number; reason?: string } {
    const c = this.config;
    const t = now - this.started;
    const theta = s.pendulum_deg,
      velocity = s.pendulum_vel_deg_s;
    const rad = (wrapDeg(theta - 180) * Math.PI) / 180,
      velRad = (velocity * Math.PI) / 180;
    const rawEnergy = 0.5 * (velRad / c.omegaN) ** 2 + 1 - Math.cos(rad);
    const alpha = Math.pow(c.energyLpf, Math.max(0, dt) / 0.002);
    this.filtered =
      this.filtered === null
        ? rawEnergy
        : alpha * this.filtered + (1 - alpha) * rawEnergy;
    const energy = this.filtered;
    if (!this.active) return { duty: 0, energy: rawEnergy };
    const end = (reason: string) => {
      this.stop();
      return { duty: 0, energy, reason };
    };
    const duration =
      this.action === "pulse"
        ? c.pulseMs / 1000
        : this.action === "sine"
          ? c.sineSeconds
          : c.duration;
    if (t >= duration)
      return end(
        this.action === "swing" && this.phase !== "balance"
          ? "起摆超时"
          : "运行时限结束",
      );
    if (dt > 0.1) return end("采样间隔超过 100 ms");
    if (this.action === "observe") return { duty: 0, energy };
    if (this.action === "jog")
      return { duty: this.direction * Math.min(c.jogDuty, c.maxDuty), energy };
    if (this.action === "pulse")
      return { duty: clamp(c.pulseDuty, -c.maxDuty, c.maxDuty), energy };
    if (this.action === "sine")
      return {
        duty: c.sineDuty * Math.sin(2 * Math.PI * c.sineHz * t),
        energy,
      };
    if (c.swingMethod === 1) {
      const output = this.resonant.step(s, c, now, dt);
      this.phase = output.phase;
      if (output.reason) return end(output.reason);
      return { duty: output.duty, energy };
    }
    if (t < c.kickMs / 1000) {
      this.phase = "kick";
      return { duty: c.kickDuty, energy };
    }
    this.history.push({ t: now, v: velocity });
    while (this.history.length > 1 && this.history[1].t <= now - 0.1)
      this.history.shift();
    if (this.phase === "balance") {
      if (
        Math.abs(theta) >= c.exitAngle ||
        Math.abs(velocity) >= c.exitVelocity
      )
        return end("稳摆失效，已停止");
    } else {
      const approaching = theta * velocity < 0;
      const consistent =
        this.history.length > 1 &&
        now - this.history[0].t >= 0.08 &&
        this.history.every((h) => h.v * velocity > 0);
      if (
        t > 1 &&
        Math.abs(theta) < c.entryAngle &&
        Math.abs(velocity) < c.entryVelocity &&
        approaching &&
        consistent
      ) {
        this.phase = "balance";
        this.integral = this.outerIntegral = 0;
      }
    }
    if (this.phase === "balance") {
      this.outerIntegral = clamp(
        this.outerIntegral - s.motor_cont_deg * dt,
        -200,
        200,
      );
      const ref = clamp(
        -c.outerKp * s.motor_cont_deg +
          c.outerKi * this.outerIntegral -
          c.outerKd * s.motor_vel_deg_s,
        -10,
        10,
      );
      const error = theta - ref;
      this.integral = clamp(this.integral + error * dt, -20, 20);
      return {
        duty: clamp(
          -c.kp * error - c.ki * this.integral - c.kd * velocity,
          -c.maxDuty,
          c.maxDuty,
        ),
        energy,
      };
    }
    // A coast interval is entered once per downward crossing, not extended every sample.
    const coastTrigger =
      (theta > 170 && velocity > 100) || (theta < -170 && velocity < -100);
    if (!coastTrigger) this.coastArmed = true;
    if (this.coastArmed && coastTrigger) {
      this.coastUntil = now + c.coastMs / 1000;
      this.coastArmed = false;
    }
    if (now < this.coastUntil) {
      this.phase = "coast";
      return { duty: 0, energy };
    }
    this.phase = "swing";
    let duty = c.swingGain * (energy - 2) * velRad * Math.cos(rad);
    if (duty !== 0) duty += Math.sign(duty) * c.deadzone;
    return { duty: clamp(duty, -c.maxDuty, c.maxDuty) || 0, energy };
  }
}
