import { describe, expect, it } from "vitest";
import { Engine, SAMPLE_BUDGET } from "./engine";
import { DEFAULT_CONFIG, type ExperimentRecord, type RawSample } from "./types";
import { CSV_COLUMNS, toCsv } from "./export";
import { LatestWriter } from "./writer";
const raw = (tick = 2000, motor = 179): RawSample => ({
  seq: tick / 2000,
  duty: 0,
  pendulum_raw: 180,
  pendulum_vel_raw_deg_s: 0,
  motor_raw: motor,
  motor_vel_raw_deg_s: 0,
  pendulum_vel_deg_s: 0,
  motor_vel_deg_s: 0,
  tick_us: tick,
  reserved: 0,
});
describe("recording engine", () => {
  it("rejects real swing from a downward-derived zero, including the old combined command", () => {
    const e = new Engine(
      () => {},
      () => {},
    );
    for (let i = 0; i < 800; i++)
      e.accept({ ...raw(i * 2000), pendulum_raw: -12 }, i * 0.002);
    e.calibrateDown();
    expect(() => e.start("swing", DEFAULT_CONFIG, 1.6, false)).toThrow("盲区");
    expect(() =>
      e.start("swing", DEFAULT_CONFIG, 1.6, false, undefined, true),
    ).toThrow("盲区");
    expect(e.active).toBe(false);
    expect(e.latest!.target_duty).toBe(0);
  });
  it("calibrates actual upright with 333 degree span, preserves firmware fields, and still refuses a non-downward start", () => {
    const e = new Engine(
      () => {},
      () => {},
    );
    for (let i = 0; i < 800; i++)
      e.accept(
        {
          ...raw(i * 2000),
          pendulum_raw: -1.4 + Math.sin(i * 0.1) * 0.2,
          pendulum_vel_deg_s: 70,
        },
        i * 0.002,
      );
    e.calibrateUpright();
    const zero = e.pendulumZero;
    const s = e.accept(
      {
        ...raw(1602000),
        pendulum_raw: zero + (90 * 360) / 333,
        pendulum_vel_deg_s: 70,
      },
      1.602,
    ).sample;
    expect(s.pendulum_deg).toBeCloseTo(90);
    expect(s.pendulum_vel_deg_s).toBe(70);
    expect(s.control_velocity_deg_s).toBeCloseTo(64.75);
    expect(() => e.start("swing", DEFAULT_CONFIG, 1.602, false)).toThrow(
      "下垂",
    );
    e.resetConnection();
    expect(e.pendulumScale).toBe(1);
    expect(e.pendulumCalibrated).toBe(false);
  });
  it("rejects moving, off-center and active upright calibration", () => {
    const e = new Engine(
      () => {},
      () => {},
    );
    for (let i = 0; i < 800; i++)
      e.accept({ ...raw(i * 2000), pendulum_raw: i * 0.02 }, i * 0.002);
    expect(() => e.calibrateUpright()).toThrow("仍在运动");
    for (let i = 800; i < 1800; i++)
      e.accept({ ...raw(i * 2000), pendulum_raw: 90 }, i * 0.002);
    expect(() => e.calibrateUpright()).toThrow("ADC 中值");
    e.start("observe", DEFAULT_CONFIG, 3.6, false);
    expect(() => e.calibrateUpright()).toThrow("停止动作");
  });
  it("explicitly calibrates a stationary downward pose, preserves raw angles and records its offset", () => {
    let record!: ExperimentRecord;
    const e = new Engine(
      (r) => (record = r),
      () => {},
    );
    for (let i = 0; i < 800; i++)
      e.accept({ ...raw(i * 2000), pendulum_raw: -12 }, i * 0.002);
    expect(e.calibrateDown()).toBeCloseTo(168);
    const s = e.accept({ ...raw(1602000), pendulum_raw: -12 }, 1.602).sample;
    expect(Math.abs(s.pendulum_deg)).toBeCloseTo(180);
    expect(s.pendulum_raw).toBe(-12);
    e.start("observe", DEFAULT_CONFIG, 1.602, false);
    e.stop("test", 1.604);
    expect(record.pendulumZero).toBeCloseTo(168);
    e.resetConnection();
    expect(e.pendulumZero).toBe(0);
  });
  it("rejects a moving calibration or unsafe initial swing pose", () => {
    const e = new Engine(
      () => {},
      () => {},
    );
    for (let i = 0; i < 800; i++)
      e.accept(
        {
          ...raw(i * 2000),
          pendulum_raw: -12 + i * 0.02,
          pendulum_vel_deg_s: 30,
        },
        i * 0.002,
      );
    expect(() => e.calibrateDown()).toThrow("仍在运动");
    expect(() => e.start("swing", DEFAULT_CONFIG, 0.62, false)).toThrow("直立");
  });
  it("keeps the absolute pendulum upright zero, calibrates motor only", () => {
    const e = new Engine(
      () => {},
      () => {},
    );
    const s = e.accept(raw(), 0).sample;
    expect(s.pendulum_deg).toBe(180);
    expect(s.motor_deg).toBe(0);
  });
  it("unwraps motor turns, supports zero while idle, rejects zero while active", () => {
    const e = new Engine(
      () => {},
      () => {},
    );
    e.accept(raw(), 0);
    expect(e.accept(raw(4000, -179), 0.002).sample.motor_cont_deg).toBe(2);
    e.zero();
    expect(e.accept(raw(6000, -178), 0.004).sample.motor_cont_deg).toBe(1);
    e.start("jog", DEFAULT_CONFIG, 0.004, false);
    expect(() => e.zero()).toThrow();
  });
  it("records every valid sample including duplicate timestamps without advancing controller twice", () => {
    const records: ExperimentRecord[] = [];
    const e = new Engine(
      (r) => records.push(r),
      () => {},
    );
    e.accept(raw(), 0);
    e.start("pulse", DEFAULT_CONFIG, 0, false);
    e.accept(raw(4000), 0.002);
    expect(e.accept(raw(4000), 0.003).fresh).toBe(false);
    e.stop("手动停止", 0.004);
    expect(records[0].samples).toHaveLength(2);
    expect(records[0].events.at(-1)?.label).toBe("手动停止");
    expect(e.accept(raw(6000), 0.005).sample.target_duty).toBe(0);
  });
  it("retains samples at the memory cap and refuses further experiments", () => {
    const records: ExperimentRecord[] = [];
    const e = new Engine(
      (r) => records.push(r),
      () => {},
      2 * SAMPLE_BUDGET,
    );
    e.accept(raw(), 0);
    e.start("jog", DEFAULT_CONFIG, 0, true);
    e.accept(raw(4000), 0.002);
    e.accept(raw(6000), 0.004);
    e.accept(raw(8000), 0.006);
    expect(e.active).toBe(false);
    expect(records[0].samples.length).toBe(2);
    expect(e.memoryBytes).toBe(2 * SAMPLE_BUDGET);
    expect(() => e.start("jog", DEFAULT_CONFIG, 0.008, true)).toThrow();
    e.clear();
    expect(e.memoryBytes).toBe(0);
  });
  it("stops if the hardware timer restarts and preserves prior records across reconnects", () => {
    const records: ExperimentRecord[] = [];
    const e = new Engine(
      (r) => records.push(r),
      () => {},
    );
    e.accept(raw(100000), 0);
    e.start("jog", DEFAULT_CONFIG, 0, false);
    e.accept(raw(102000), 0.002);
    e.accept(raw(5), 0.004);
    expect(e.active).toBe(false);
    expect(records[0].reason).toContain("计时");
    const bytes = e.memoryBytes;
    e.resetConnection();
    expect(e.memoryBytes).toBe(bytes);
    expect(e.latest).toBeNull();
  });
  it("exports raw fields, wrap-safe time, target, feedback and phase, no chart downsampling", () => {
    let record!: ExperimentRecord;
    const e = new Engine(
      (r) => (record = r),
      () => {},
    );
    e.accept(raw(), 0);
    e.start("pulse", DEFAULT_CONFIG, 0, true);
    for (let i = 2; i <= 25; i++) e.accept(raw(i * 2000), i * 0.002);
    e.stop("结束", 0.06);
    const lines = toCsv(record).split("\r\n");
    expect(lines.length).toBe(25);
    expect(lines[0]).toBe("\uFEFF" + CSV_COLUMNS.join(","));
    expect(record.simulation).toBe(true);
    expect(record.config.pulseDuty).toBe(25);
    expect(record.reason).toBe("结束");
    expect(JSON.parse(JSON.stringify(record)).samples).toHaveLength(24);
  });
});
describe("latest-output writer", () => {
  it("drops queued obsolete motion when stopped, with at most one in-flight write", async () => {
    const values: number[] = [];
    const resolves: (() => void)[] = [];
    const w = new LatestWriter(
      (duty) => {
        values.push(duty);
        return new Promise<void>((r) => resolves.push(r));
      },
      () => {},
    );
    w.request(25);
    w.request(40);
    w.request(-40);
    w.request(0);
    expect(values).toEqual([25]);
    resolves.shift()!();
    await Promise.resolve();
    expect(values).toEqual([25, 0]);
    resolves.shift()!();
    await Promise.resolve();
    w.close();
    w.request(50);
    expect(values).toEqual([25, 0]);
  });
  it("reports write failure and cannot write further movement", async () => {
    const values: number[] = [];
    let error: unknown;
    const w = new LatestWriter(
      async (duty) => {
        values.push(duty);
        throw new Error("unplug");
      },
      (e) => (error = e),
    );
    w.request(20);
    await Promise.resolve();
    w.request(30);
    expect(values).toEqual([20]);
    expect(String(error)).toContain("unplug");
  });
});
