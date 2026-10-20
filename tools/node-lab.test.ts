import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeLab, type LabPort } from "./node-lab";
import { telemetryFrame } from "../src/protocol";
import { replayRecord } from "./replay";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
class BytePort extends EventEmitter implements LabPort {
  isOpen = false;
  stalled = false;
  writes: number[] = [];
  tick = 0;
  seq = 0;
  latest = 0;
  open(cb: (e: Error | null) => void) {
    this.isOpen = true;
    cb(null);
  }
  write(bytes: Uint8Array, cb: (e: Error | null) => void) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      duty = v.getFloat32(8, true);
    this.writes.push(duty);
    this.latest = duty;
    cb(null);
    setTimeout(() => {
      if (!this.isOpen || this.stalled) return;
      this.tick += 10000;
      const packet = telemetryFrame({
        seq: this.seq++,
        duty,
        pendulum_raw: 180,
        pendulum_vel_raw_deg_s: 0,
        motor_raw: 0,
        motor_vel_raw_deg_s: 0,
        pendulum_vel_deg_s: 0,
        motor_vel_deg_s: 0,
        tick_us: this.tick,
        reserved: 0,
      });
      this.emit("data", packet.slice(0, 9));
      this.emit("data", packet.slice(9));
    }, 10);
  }
  drain(cb: (e: Error | null) => void) {
    cb(null);
  }
  close(cb: () => void) {
    this.isOpen = false;
    this.emit("close");
    cb();
  }
}
describe("Node serial adapter shares the actual protocol and engine", () => {
  const dirs: string[] = [],
    labs: NodeLab[] = [];
  afterEach(async () => {
    for (const lab of labs) await lab.close();
    labs.length = 0;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  async function setup() {
    const dir = await mkdtemp(path.join(tmpdir(), "rip-node-"));
    dirs.push(dir);
    const port = new BytePort(),
      events: any[] = [];
    const lab = new NodeLab("/fake", dir, (e) => events.push(e), port);
    labs.push(lab);
    await lab.open();
    return { dir, port, events, lab };
  }
  it("opens at zero, handles split frames, saves raw samples and closes at fresh zero feedback", async () => {
    const { lab, port, dir, events } = await setup();
    expect(port.writes.every((x) => x === 0)).toBe(true);
    lab.start("pulse", { pulseMs: 1000 });
    await delay(45);
    expect(port.writes).toContain(25);
    const cut = port.writes.length;
    await lab.close();
    expect(port.writes.slice(cut).every((x) => x === 0)).toBe(true);
    expect(events.at(-1)).toEqual({ type: "closed", zeroConfirmed: true });
    const json = (await readdir(dir)).find((p) => p.endsWith(".json"))!;
    const record = JSON.parse(await readFile(path.join(dir, json), "utf8"));
    expect(record.runtime).toBe("node");
    expect(record.simulation).toBe(false);
    expect(record.samples.length).toBeGreaterThan(0);
  });
  it("stops and exports on stalled telemetry and never writes further motion", async () => {
    const { lab, port, events } = await setup();
    lab.start("pulse", { pulseMs: 1000 });
    await delay(30);
    port.stalled = true;
    await delay(160);
    const cut = port.writes.length;
    await delay(30);
    expect(lab.engine.active).toBe(false);
    expect(
      events.some((e) => e.type === "fault" && e.reason.includes("100 ms")),
    ).toBe(true);
    expect(port.writes.slice(cut).every((x) => x === 0)).toBe(true);
  });
  it("evaluates the actual near-upright log only up to the first hypothetical capture", async () => {
    const record = JSON.parse(
      await readFile("src/fixtures/near-upright.json", "utf8"),
    );
    const old = replayRecord(record);
    expect(old.capture).toBeNull();
    const candidate = replayRecord(record, {
      entryVelocity: 650,
      exitVelocity: 900,
      entryDwellMs: 10,
    });
    expect(candidate.capture).toMatchObject({
      time: expect.closeTo(2.7859, 3),
    });
    expect(candidate.firstDivergence).toMatchObject({
      time: expect.closeTo(2.7859, 3),
      original: 0,
    });
    expect(candidate.physicalSuccess).toBe(false);
  });
});
