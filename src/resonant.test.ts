import { describe, it, expect } from "vitest";
import { Controller } from "./controller";
import { DEFAULT_CONFIG as BASE_CONFIG } from "./types";
const DEFAULT_CONFIG = {
  ...BASE_CONFIG,
  kickDuty: 25,
  kickMs: 80,
  bootstrapPairs: 1,
};
const s = {
  pendulum_deg: -55,
  pendulum_vel_deg_s: 1500,
  motor_cont_deg: 0,
  motor_vel_deg_s: 0,
};
describe("vendor pulse swing adaptation", () => {
  it("escapes rest using a paired pulse then holds zero despite blind-region drift and bogus derivative", () => {
    const c = new Controller();
    c.start("swing", DEFAULT_CONFIG, 0);
    expect(c.step(s, 0, 0.002).duty).toBe(25);
    expect(c.step(s, 0.079, 0.002).duty).toBe(25);
    expect(c.step(s, 0.081, 0.002).duty).toBe(-25);
    expect(c.step(s, 0.16, 0.002).duty).toBe(-25);
    expect(c.step(s, 0.162, 0.002).duty).toBe(0);
    for (let i = 0; i < 25; i++)
      expect(
        c.step({ ...s, pendulum_deg: -55 + i * 0.1 }, 0.2 + i * 0.04, 0.002)
          .duty,
      ).toBe(0);
    expect(c.phase).toBe("coast");
    c.stop();
    expect(c.step(s, 2, 0.002).duty).toBe(0);
  });
  it("bootstraps exactly three alternating pulse pairs and then waits at zero", () => {
    const c = new Controller();
    c.start("swing", { ...DEFAULT_CONFIG, bootstrapPairs: 3 }, 0);
    const check = (t: number, want: number) =>
      expect(c.step(s, t, 0.002).duty).toBe(want);
    check(0, 25);
    check(0.081, -25);
    check(0.162, 0);
    check(0.282, -25);
    check(0.363, 25);
    check(0.444, 0);
    check(0.564, 25);
    check(0.645, -25);
    check(0.726, 0);
    for (let i = 0; i < 20; i++) check(0.8 + i * 0.04, 0);
  });
  it("triggers the correct signed pair at a real turning point, rejects ADC jitter", () => {
    const c = new Controller();
    c.start("swing", DEFAULT_CONFIG, 0);
    c.step(s, 0, 0.002);
    c.step(s, 0.081, 0.002);
    c.step(s, 0.162, 0.002);
    c.step({ ...s, pendulum_deg: -85 }, 0.3, 0.002);
    c.step({ ...s, pendulum_deg: -70 }, 0.341, 0.002);
    expect(c.step({ ...s, pendulum_deg: -88 }, 0.382, 0.002).duty).toBe(-25);
    expect(c.step(s, 0.463, 0.002).duty).toBe(25);
    expect(c.step(s, 0.544, 0.002).duty).toBe(0);
  });
  it("does not miss a turning point 80ms after the reverse pulse ends", () => {
    const c = new Controller();
    c.start("swing", { ...DEFAULT_CONFIG, kickMs: 100 }, 0);
    c.step(s, 0, 0.002);
    c.step(s, 0.101, 0.002);
    c.step(s, 0.202, 0.002);
    c.step({ ...s, pendulum_deg: -70 }, 0.203, 0.002);
    c.step({ ...s, pendulum_deg: -40 }, 0.244, 0.002);
    expect(c.step({ ...s, pendulum_deg: -65 }, 0.285, 0.002).duty).toBe(-25);
  });
  it("lets a validated upright approach interrupt the third startup pulse", () => {
    const c = new Controller();
    const config = {
      ...DEFAULT_CONFIG,
      bootstrapPairs: 3,
      kickMs: 100,
      entryDwellMs: 10,
      entryVelocity: 800,
      exitVelocity: 1100,
    };
    c.start("swing", config, 0);
    c.step(s, 0, 0.002);
    c.step(s, 0.101, 0.002);
    c.step(s, 0.202, 0.002);
    c.step(s, 0.282, 0.002);
    c.step(s, 0.383, 0.002);
    c.step({ ...s, pendulum_deg: 100 }, 0.484, 0.002);
    c.step({ ...s, pendulum_deg: 60 }, 0.564, 0.002);
    for (const [t, angle] of [
      [0.58, 50],
      [0.6, 30],
      [0.62, 20],
      [0.64, 10],
    ])
      c.step({ ...s, pendulum_deg: angle }, t, 0.02);
    expect(c.phase).toBe("balance");
    expect(c.pulseDeadline).toBeNull();
  });
  it("captures a consistent upright approach, anchors motor position there, and stops on fall", () => {
    const c = new Controller();
    c.start("swing", DEFAULT_CONFIG, 0);
    c.step(s, 0, 0.002);
    c.step(s, 0.081, 0.002);
    c.step(s, 0.162, 0.002);
    for (const [time, angle] of [
      [0.2, 40],
      [0.22, 30],
      [0.24, 24],
      [0.26, 20],
      [0.28, 16],
      [0.3, 12],
      [0.32, 8],
    ])
      c.step({ ...s, pendulum_deg: angle, motor_cont_deg: 80 }, time, 0.02);
    expect(c.phase).toBe("balance");
    expect(
      Math.abs(
        c.step({ ...s, pendulum_deg: 7, motor_cont_deg: 80 }, 0.34, 0.02).duty,
      ),
    ).toBeLessThanOrEqual(40);
    expect(
      c.step({ ...s, pendulum_deg: 46, motor_cont_deg: 80 }, 0.36, 0.02).reason,
    ).toContain("稳摆失效");
    expect(c.step(s, 0.4, 0.02).duty).toBe(0);
  });
  it("refuses excessive travel and speed, and latches stop", () => {
    for (const unsafe of [{ motor_cont_deg: 181 }, { motor_vel_deg_s: 721 }]) {
      const c = new Controller();
      c.start("swing", DEFAULT_CONFIG, 0);
      c.step(s, 0, 0.002);
      const out = c.step({ ...s, ...unsafe }, 0.02, 0.02);
      expect(out.reason).toBeTruthy();
      expect(out.duty).toBe(0);
      expect(c.active).toBe(false);
      expect(c.step(s, 0.04, 0.02).duty).toBe(0);
    }
  });
});
