import { describe, expect, it } from "vitest";
import { Controller, validateConfig } from "./controller";
import { DEFAULT_CONFIG as FACTORY_CONFIG } from "./types";
const DEFAULT_CONFIG = {
  ...FACTORY_CONFIG,
  swingMethod: 0,
  kickDuty: 25,
  kickMs: 80,
  duration: 30,
  kp: 2,
  ki: 20,
  kd: 0.05,
  outerKp: 0.1,
  outerKi: 0.01,
  outerKd: 0.02,
  entryAngle: 20,
  entryVelocity: 200,
  exitAngle: 30,
  exitVelocity: 180,
};
const down = {
  pendulum_deg: 180,
  pendulum_vel_deg_s: 0,
  motor_cont_deg: 0,
  motor_vel_deg_s: 0,
};
describe("controller", () => {
  it("starts from rest with a finite kick", () => {
    const c = new Controller();
    c.start("swing", DEFAULT_CONFIG, 0);
    expect(c.step(down, 0.002, 0.002).duty).toBe(25);
    expect(c.phase).toBe("kick");
    expect(c.step(down, 0.09, 0.002).duty).toBe(0);
    expect(c.phase).toBe("swing");
  });
  it("outputs exactly zero throughout a coast interval", () => {
    const c = new Controller();
    c.start("swing", DEFAULT_CONFIG, 0);
    const s = { ...down, pendulum_deg: 175, pendulum_vel_deg_s: 150 };
    expect(c.step(s, 0.2, 0.002).duty).toBe(0);
    expect(c.phase).toBe("coast");
    expect(c.step(s, 0.22, 0.002).duty).toBe(0);
  });
  it("limits swing output after deadzone compensation", () => {
    const c = new Controller();
    c.start("swing", { ...DEFAULT_CONFIG, maxDuty: 30, swingGain: 100 }, 0);
    expect(
      Math.abs(
        c.step(
          { ...down, pendulum_deg: 90, pendulum_vel_deg_s: 10000 },
          0.5,
          0.002,
        ).duty,
      ),
    ).toBeLessThanOrEqual(30);
  });
  it("enters balance after consistent approach, stops on failure without retry", () => {
    const c = new Controller();
    c.start("swing", DEFAULT_CONFIG, 0);
    for (let i = 0; i <= 60; i++)
      c.step(
        { ...down, pendulum_deg: 10, pendulum_vel_deg_s: -20 },
        0.9 + i * 0.002,
        0.002,
      );
    expect(c.phase).toBe("balance");
    const output = c.step({ ...down, pendulum_deg: 40 }, 1.1, 0.002);
    expect(output.reason).toContain("稳摆失效");
    expect(c.active).toBe(false);
    expect(c.step(down, 1.2, 0.002).duty).toBe(0);
  });
  it("has symmetric entry criteria on the negative side", () => {
    const c = new Controller();
    c.start("swing", DEFAULT_CONFIG, 0);
    for (let i = 0; i <= 60; i++)
      c.step(
        { ...down, pendulum_deg: -10, pendulum_vel_deg_s: 20 },
        0.9 + i * 0.002,
        0.002,
      );
    expect(c.phase).toBe("balance");
  });
  it("bounds integrators using real dt under prolonged error", () => {
    const c = new Controller();
    c.start(
      "swing",
      {
        ...DEFAULT_CONFIG,
        ki: 0.1,
        kp: 0,
        kd: 0,
        outerKp: 0,
        outerKi: 0,
        outerKd: 0,
      },
      0,
    );
    for (let i = 0; i <= 60; i++)
      c.step(
        { ...down, pendulum_deg: 10, pendulum_vel_deg_s: -20 },
        0.9 + i * 0.002,
        0.002,
      );
    let result = 0;
    for (let i = 0; i < 500; i++)
      result = c.step({ ...down, pendulum_deg: 10 }, 1.1 + i * 0.01, 0.01).duty;
    expect(result).toBeCloseTo(-2);
  });
  it("ends each action at its duration", () => {
    for (const action of ["swing", "jog", "pulse", "sine"] as const) {
      const c = new Controller();
      c.start(action, DEFAULT_CONFIG, 0);
      const end = action === "pulse" ? 0.1 : action === "sine" ? 5 : 30;
      expect(c.step(down, end, 0.002).duty).toBe(0);
      expect(c.active).toBe(false);
    }
  });
  it("stops on stale sampling and latches stopped state", () => {
    const c = new Controller();
    c.start("jog", DEFAULT_CONFIG, 0);
    expect(c.step(down, 0.15, 0.15).reason).toContain("100 ms");
    expect(c.step(down, 0.16, 0.01).duty).toBe(0);
  });
  it("makes actions exclusive and zeroes outputs after explicit stop", () => {
    const c = new Controller();
    c.start("pulse", DEFAULT_CONFIG, 0);
    expect(() => c.start("jog", DEFAULT_CONFIG, 0)).toThrow();
    c.stop();
    expect(c.step(down, 0.01, 0.002).duty).toBe(0);
  });
  it("applies manual direction and sinusoidal phase", () => {
    const c = new Controller();
    c.start("jog", DEFAULT_CONFIG, 0, -1);
    expect(c.step(down, 0.01, 0.002).duty).toBe(-20);
    c.stop();
    c.start("sine", DEFAULT_CONFIG, 0);
    expect(c.step(down, 0.5, 0.002).duty).toBeCloseTo(15);
  });
  it("rejects invalid and incomplete configs at the worker boundary", () => {
    expect(() => validateConfig({ ...DEFAULT_CONFIG, kp: NaN })).toThrow();
    expect(() => validateConfig({ ...DEFAULT_CONFIG, sineHz: 0 })).toThrow();
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, pulseDuty: 200 }),
    ).toThrow();
  });
});
