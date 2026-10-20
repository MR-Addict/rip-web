import type { RawSample } from "./types";

export const wrapDeg = (x: number) => {
  const y = ((((x + 180) % 360) + 360) % 360) - 180;
  return y === -180 ? 180 : y;
};
export const clamp = (x: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, x));
export function crc8(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ (crc & 0x80 ? 7 : 0)) & 255;
  }
  return crc;
}
export function frame(
  cmd: number,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (payload.length > 255) throw new Error("Payload too long");
  const result = new Uint8Array(payload.length + 5);
  result.set([0xaa, 0x55, cmd, payload.length]);
  result.set(payload, 4);
  result[result.length - 1] = crc8(result.subarray(2, -1));
  return result;
}
export function pwmFrame(seq: number, duty: number) {
  if (!Number.isFinite(duty)) throw new Error("PWM 必须是有限数值");
  const payload = new Uint8Array(8);
  const v = new DataView(payload.buffer);
  v.setUint32(0, seq >>> 0, true);
  v.setFloat32(4, clamp(duty, -100, 100), true);
  return frame(1, payload);
}
export function telemetryFrame(s: RawSample) {
  const payload = new Uint8Array(40);
  const v = new DataView(payload.buffer);
  v.setUint32(0, s.seq, true);
  [
    s.duty,
    s.pendulum_raw,
    s.pendulum_vel_raw_deg_s,
    s.motor_raw,
    s.motor_vel_raw_deg_s,
    s.pendulum_vel_deg_s,
    s.motor_vel_deg_s,
  ].forEach((n, i) => v.setFloat32(4 + i * 4, n, true));
  v.setUint32(32, s.tick_us, true);
  v.setUint32(36, s.reserved, true);
  return frame(0x81, payload);
}
export class Decoder {
  private buffer = new Uint8Array(0);
  badFrames = 0;
  push(chunk: Uint8Array): RawSample[] {
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer);
    next.set(chunk, this.buffer.length);
    const samples: RawSample[] = [];
    let offset = 0;
    while (offset + 4 <= next.length) {
      if (next[offset] !== 0xaa || next[offset + 1] !== 0x55) {
        offset++;
        continue;
      }
      // This firmware has one inbound message. Reject impossible headers immediately.
      if (next[offset + 2] !== 0x81 || next[offset + 3] !== 40) {
        this.badFrames++;
        offset++;
        continue;
      }
      if (offset + 45 > next.length) break;
      const packet = next.subarray(offset, offset + 45);
      if (crc8(packet.subarray(2, -1)) !== packet[44]) {
        this.badFrames++;
        offset++;
        continue;
      }
      const v = new DataView(packet.buffer, packet.byteOffset + 4, 40);
      const floats = Array.from({ length: 7 }, (_, i) =>
        v.getFloat32(4 + i * 4, true),
      );
      if (floats.every(Number.isFinite)) {
        samples.push({
          seq: v.getUint32(0, true),
          duty: floats[0],
          pendulum_raw: floats[1],
          pendulum_vel_raw_deg_s: floats[2],
          motor_raw: floats[3],
          motor_vel_raw_deg_s: floats[4],
          pendulum_vel_deg_s: floats[5],
          motor_vel_deg_s: floats[6],
          motor_velocity_bits: v.getUint32(28, true),
          tick_us: v.getUint32(32, true),
          reserved: v.getUint32(36, true),
          adc_raw: v.getUint32(36, true),
        });
      } else this.badFrames++;
      offset += 45;
    }
    this.buffer = next.slice(offset);
    return samples;
  }
}
export class DeviceClock {
  private previous: number | null = null;
  private elapsed = 0;
  update(tick: number): { seconds: number; dt: number; reset: boolean } {
    if (this.previous === null) {
      this.previous = tick;
      return { seconds: 0, dt: 0, reset: false };
    }
    const delta = (tick - this.previous) >>> 0;
    this.previous = tick;
    const reset = delta > 10_000_000;
    const dt = reset ? 0 : delta / 1e6;
    this.elapsed += dt;
    return { seconds: this.elapsed, dt, reset };
  }
}
