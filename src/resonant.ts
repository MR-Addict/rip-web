import { clamp } from "./protocol";
import type { ControlConfig, Phase } from "./types";
export interface ResonantInput {
  pendulum_deg: number;
  motor_cont_deg: number;
  motor_vel_deg_s: number;
  device_time_s?: number;
}
export interface ResonantOutput {
  duty: number;
  phase: Phase;
  reason?: string;
}
/** Adapted from vendor example 16. Times use fresh samples, never replay missed pulses. */
export class ResonantSwing {
  private stage: "forward" | "reverse" | "wait" | "balance" = "forward";
  private since: number | null = null;
  private sign = 1;
  private pairs = 1;
  private pairStarted: number | null = null;
  private points: { t: number; angle: number }[] = [];
  private motion: { t: number; angle: number }[] = [];
  private integral = 0;
  private motorStart: number | null = null;
  private motorCapture = 0;
  private velocity = 0;
  private centerSince: number | null = null;
  get estimatedVelocity() {
    return this.velocity;
  }
  get outputDeadline() {
    return this.since !== null &&
      (this.stage === "forward" || this.stage === "reverse")
      ? this.since
      : null;
  }
  step(
    s: ResonantInput,
    c: ControlConfig,
    now: number,
    dt: number,
  ): ResonantOutput {
    if (this.motorStart === null) this.motorStart = s.motor_cont_deg;
    const end = (reason: string): ResonantOutput => ({
      duty: 0,
      phase: "idle",
      reason,
    });
    if (Math.abs(s.motor_cont_deg - this.motorStart) > c.travelLimit)
      return end("旋臂超过本次动作行程限制");
    if (Math.abs(s.motor_vel_deg_s) > 720) return end("旋臂速度超过 720°/s");
    // The firmware derivative is dominated by ADC noise. Regress measured positions over 60 ms.
    const sensorTime = s.device_time_s ?? now;
    this.motion.push({ t: sensorTime, angle: s.pendulum_deg });
    while (this.motion.length > 2 && this.motion[1].t < sensorTime - 0.06)
      this.motion.shift();
    const n = this.motion.length,
      mt = this.motion.reduce((a, p) => a + p.t, 0) / n,
      ma = this.motion.reduce((a, p) => a + p.angle, 0) / n;
    const den = this.motion.reduce((a, p) => a + (p.t - mt) ** 2, 0);
    if (den > 0)
      this.velocity =
        this.motion.reduce((a, p) => a + (p.t - mt) * (p.angle - ma), 0) / den;
    if (this.stage === "balance") {
      if (
        Math.abs(s.pendulum_deg) >= c.exitAngle ||
        Math.abs(this.velocity) >= c.exitVelocity
      )
        return end("稳摆失效，已停止");
      const ref = clamp(
        c.motorPolarity *
          (c.outerKp * (s.motor_cont_deg - this.motorCapture) +
            c.outerKd * s.motor_vel_deg_s),
        -8,
        8,
      );
      const error = ref - s.pendulum_deg;
      const proposed = clamp(
        this.integral + error * dt,
        -c.maxDuty / Math.max(c.ki, 0.001),
        c.maxDuty / Math.max(c.ki, 0.001),
      );
      let u = c.kp * error + c.ki * proposed - c.kd * this.velocity;
      if (Math.abs(u) < c.maxDuty || error * u < 0) this.integral = proposed;
      u = c.kp * error + c.ki * this.integral - c.kd * this.velocity;
      return { duty: clamp(u, -c.maxDuty, c.maxDuty), phase: "balance" };
    }
    const angle = s.pendulum_deg;
    const approaching = angle * this.velocity < 0;
    const recentExcursion = this.motion.some(
      (p) => Math.abs(p.angle) > c.entryAngle + 2,
    );
    const captureAllowed =
      this.stage === "wait" ||
      (this.pairs >= c.bootstrapPairs && this.pairs > 1);
    if (
      captureAllowed &&
      Math.abs(angle) < c.entryAngle &&
      approaching &&
      Math.abs(this.velocity) < Math.min(c.entryVelocity, c.exitVelocity) &&
      Math.abs(this.velocity) > 15
    ) {
      if (this.centerSince === null && recentExcursion) this.centerSince = now;
      if (
        this.centerSince !== null &&
        now - this.centerSince >= c.entryDwellMs / 1000
      ) {
        this.stage = "balance";
        this.integral = 0;
        this.motorCapture = s.motor_cont_deg;
        return {
          duty: clamp(
            -c.kp * angle - c.kd * this.velocity,
            -c.maxDuty,
            c.maxDuty,
          ),
          phase: "balance",
        };
      }
    } else this.centerSince = null;
    if (this.since === null) {
      this.since = now;
      this.pairStarted = now;
    }
    const width = c.kickMs / 1000;
    if (this.stage === "forward") {
      if (now - this.since < width)
        return { duty: this.sign * c.kickDuty, phase: "kick" };
      this.stage = "reverse";
      this.since = now;
    }
    if (this.stage === "reverse") {
      if (now - this.since < width)
        return { duty: -this.sign * c.kickDuty, phase: "kick" };
      this.stage = "wait";
      this.since = now;
      this.points = [];
      this.motion = [];
      this.centerSince = null;
      return { duty: 0, phase: "coast" };
    }
    // Do not use downward ADC drift as continuous energy feedback. Wait for actual excursions.
    // A bounded startup sequence excites alternating half-cycles before the pole leaves its blind region.
    // The period comes from the reference model; it remains a commissioning parameter, not a measured fact.
    const halfPeriod = Math.max(2 * width + 0.04, Math.PI / c.omegaN);
    if (
      this.pairs < c.bootstrapPairs &&
      this.pairStarted !== null &&
      now - this.pairStarted >= halfPeriod
    ) {
      this.pairs++;
      this.sign = -this.sign;
      this.stage = "forward";
      this.since = this.pairStarted = now;
      this.points = [];
      return { duty: this.sign * c.kickDuty, phase: "swing" };
    }
    if (!this.points.length || now - this.points.at(-1)!.t >= 0.04) {
      this.points.push({ t: now, angle });
      if (this.points.length > 3) this.points.shift();
      if (this.points.length === 3) {
        const [a, b, d] = this.points.map((p) => p.angle),
          margin = c.turnMargin;
        const right =
          [a, b, d].every((x) => x > c.entryAngle) &&
          b < a - margin &&
          b < d - margin;
        const left =
          [a, b, d].every((x) => x < -c.entryAngle) &&
          b > a + margin &&
          b > d + margin;
        // Require an excursion of at least 8 degrees: small stationary ADC reversals are not peaks.
        const excursion = Math.max(a, b, d) - Math.min(a, b, d);
        if ((right || left) && excursion >= 8 && now - this.since >= 0.075) {
          if (this.pairs >= 8) return end("已达到 8 组起摆脉冲，未接住，停止");
          this.pairs++;
          this.sign = right ? 1 : -1;
          this.stage = "forward";
          this.since = this.pairStarted = now;
          this.points = [];
          return { duty: this.sign * c.kickDuty, phase: "swing" };
        }
      }
    }
    return { duty: 0, phase: "coast" };
  }
}
