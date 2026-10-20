import { describe, expect, it } from "vitest";
import {
  crc8,
  Decoder,
  DeviceClock,
  frame,
  pwmFrame,
  telemetryFrame,
  wrapDeg,
} from "./protocol";
import type { RawSample } from "./types";
const raw: RawSample = {
  seq: 0x01020304,
  duty: -12.5,
  pendulum_raw: 179.5,
  pendulum_vel_raw_deg_s: -300.25,
  motor_raw: 42.5,
  motor_vel_raw_deg_s: 25,
  pendulum_vel_deg_s: -200,
  motor_vel_deg_s: 20.5,
  tick_us: 0xfffffff0,
  reserved: 123,
  adc_raw: 123,
  motor_velocity_bits: 0x41a40000,
};
const join = (...chunks: Uint8Array[]) => {
  const a = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of chunks) {
    a.set(c, p);
    p += c.length;
  }
  return a;
};
describe("firmware binary protocol", () => {
  it("uses CRC-8 polynomial 0x07, init zero", () =>
    expect(crc8(new TextEncoder().encode("123456789"))).toBe(0xf4));
  it("packs uint32 and float32 little endian, 13-byte command", () => {
    const packet = pwmFrame(0x01020304, -12.5);
    expect([...packet.slice(0, 12)]).toEqual([
      0xaa, 0x55, 1, 8, 4, 3, 2, 1, 0, 0, 0x48, 0xc1,
    ]);
    expect(packet[12]).toBe(crc8(packet.slice(2, 12)));
  });
  it("clamps PWM and wraps sequence", () => {
    const p = pwmFrame(0x100000001, 200);
    const v = new DataView(p.buffer);
    expect(v.getUint32(4, true)).toBe(1);
    expect(v.getFloat32(8, true)).toBe(100);
  });
  it("rejects non-finite PWM", () => expect(() => pwmFrame(0, NaN)).toThrow());
  it("decodes all ten state fields in the Python struct order", () =>
    expect(new Decoder().push(telemetryFrame(raw))).toEqual([raw]));
  it("decodes an independently captured real STM32 packet", () => {
    const hex =
      "aa55812800000000000000004cbf44c280fc5242e2e1614000000000b869ed3f0200008017267902d005000045";
    const captured = Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
    const [s] = new Decoder().push(captured);
    expect(s.seq).toBe(0);
    expect(s.duty).toBe(0);
    expect(s.pendulum_raw).toBeCloseTo(-49.18681335449219);
    expect(s.motor_raw).toBeCloseTo(3.529411792755127);
    expect(s.tick_us).toBe(41494039);
    expect(s.reserved).toBe(1488);
    expect(s.adc_raw).toBe(1488);
    expect(s.motor_vel_deg_s).toBeCloseTo(0);
    expect(s.motor_velocity_bits).toBe(0x80000002);
  });
  it("supports every split point including the SOF boundary", () => {
    const packet = telemetryFrame(raw);
    for (let i = 1; i < packet.length; i++) {
      const d = new Decoder();
      expect(d.push(packet.slice(0, i))).toEqual([]);
      expect(d.push(packet.slice(i))).toEqual([raw]);
    }
  });
  it("decodes coalesced frames and skips leading garbage", () =>
    expect(
      new Decoder().push(
        join(
          new Uint8Array([1, 2, 0xaa, 1]),
          telemetryFrame(raw),
          telemetryFrame(raw),
        ),
      ),
    ).toEqual([raw, raw]));
  it("recovers after corrupt CRC, unknown message and bogus length", () => {
    const bad = telemetryFrame(raw);
    bad[10] ^= 1;
    const d = new Decoder();
    expect(
      d.push(
        join(
          bad,
          frame(0x82, new Uint8Array(0)),
          new Uint8Array([0xaa, 0x55, 0x81, 255]),
          telemetryFrame(raw),
        ),
      ),
    ).toEqual([raw]);
    expect(d.badFrames).toBeGreaterThanOrEqual(3);
  });
  it("discards NaN sensor data even with a correct CRC", () => {
    const d = new Decoder();
    expect(d.push(telemetryFrame({ ...raw, motor_raw: NaN }))).toEqual([]);
    expect(d.badFrames).toBe(1);
  });
  it("normalizes negative and multi-turn angles, with 180 for the downward equilibrium", () => {
    expect(wrapDeg(-180)).toBe(180);
    expect(wrapDeg(-721)).toBe(-1);
    expect(wrapDeg(1081)).toBe(1);
  });
});
describe("hardware clock", () => {
  it("extends uint32 rollover without discontinuity", () => {
    const c = new DeviceClock();
    c.update(0xfffffff0);
    expect(c.update(0x10)).toEqual({
      seconds: 0.000032,
      dt: 0.000032,
      reset: false,
    });
  });
  it("recognizes repeated ticks and resets", () => {
    const c = new DeviceClock();
    c.update(100000);
    expect(c.update(100000).dt).toBe(0);
    expect(c.update(10).reset).toBe(true);
  });
});
