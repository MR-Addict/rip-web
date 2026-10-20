import { describe, expect, it } from "vitest";
import { Decoder, wrapDeg } from "./protocol";
import { Engine } from "./engine";
import { DEFAULT_CONFIG } from "./types";
import { stillnessReport, summarizeAngles } from "./stillness";
import captured from "./fixtures/stationary.json";

describe("stationary diagnosis and calibration", () => {
  it("confirms variation exists in independent raw ADC captures, not an angle integrator", () => {
    const engine = new Engine(
        () => {},
        () => {},
      ),
      decoder = new Decoder();
    const samples = captured.frames.map((hex, i) => {
      const [raw] = decoder.push(
        Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16)),
      );
      expect(raw.pendulum_raw).toBeCloseTo(
        (raw.adc_raw! * 360) / 4095 - 180,
        4,
      );
      const { sample } = engine.accept(raw, i * 0.5);
      expect(sample.pendulum_raw).toBe(raw.pendulum_raw);
      expect(sample.pendulum_deg).toBe(wrapDeg(raw.pendulum_raw));
      expect(sample.motor_velocity_bits).toBe(0x80000002);
      expect(sample.motor_vel_deg_s).toBeCloseTo(0);
      return sample;
    });
    const r = stillnessReport(samples);
    expect(r.motor!.span).toBe(0);
    expect(r.pendulum!.span).toBeGreaterThan(1);
    expect(r.pendulum!.span).toBeLessThan(3);
    expect(decoder.badFrames).toBe(0);
  });
  it("unwraps boundary crossings instead of reporting false 358-degree jumps", () => {
    const summary = summarizeAngles([
      { time: 0, angle: 179 },
      { time: 1, angle: -179 },
      { time: 2, angle: 180 },
    ])!;
    expect(summary.span).toBe(2);
  });
  it("uses a robust calibration window despite derivative spikes, but never conceals later drift", () => {
    const e = new Engine(
      () => {},
      () => {},
    );
    const raw = {
      seq: 0,
      duty: 0,
      pendulum_raw: -12,
      pendulum_vel_raw_deg_s: 100,
      motor_raw: 0,
      motor_vel_raw_deg_s: 0,
      pendulum_vel_deg_s: 20,
      motor_vel_deg_s: 0,
      tick_us: 0,
      reserved: 0,
    };
    for (let i = 0; i < 800; i++)
      e.accept(
        { ...raw, tick_us: i * 2000, pendulum_raw: -12 + Math.sin(i * 0.1) },
        i * 0.002,
      );
    const offset = e.calibrateDown();
    expect(offset).toBeCloseTo(168, 0);
    const sample = e.accept(
      { ...raw, tick_us: 1602000, pendulum_raw: -7 },
      1.602,
    ).sample;
    expect(sample.pendulum_down_deg).toBeCloseTo(5, 0);
    expect(e.pendulumZero).toBe(offset);
    expect(sample.pendulum_calibrated).toBe(true);
    e.start("observe", { ...DEFAULT_CONFIG, duration: 10 }, 1.602, false);
    expect(
      e.accept({ ...raw, tick_us: 1604000, pendulum_raw: -6 }, 1.604).sample
        .target_duty,
    ).toBe(0);
  });
  it("rejects ongoing drift as a calibration reference", () => {
    const e = new Engine(
      () => {},
      () => {},
    );
    for (let i = 0; i < 800; i++)
      e.accept(
        {
          seq: i,
          duty: 0,
          pendulum_raw: -12 + i * 0.01,
          pendulum_vel_raw_deg_s: 0,
          motor_raw: 0,
          motor_vel_raw_deg_s: 0,
          pendulum_vel_deg_s: 0,
          motor_vel_deg_s: 0,
          tick_us: i * 2000,
          reserved: 0,
        },
        i * 0.002,
      );
    expect(() => e.calibrateDown()).toThrow("不稳定");
    expect(e.pendulumCalibrated).toBe(false);
  });
});
