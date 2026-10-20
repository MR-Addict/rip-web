import { afterEach, describe, expect, it, vi } from "vitest";
import { telemetryFrame } from "./protocol";
import { DEFAULT_CONFIG, type WorkerCommand, type WorkerEvent } from "./types";

describe("real serial worker lifecycle with request/response firmware", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });
  it("survives cached-tick replies, computes on fresh data, stops and never resumes output", async () => {
    vi.useFakeTimers({
      toFake: [
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
        "performance",
      ],
    });
    const events: WorkerEvent[] = [];
    const writes: number[] = [];
    let sink!: ReadableStreamDefaultController<Uint8Array>;
    let seq = 0,
      tick = 0;
    const port = {
      getInfo: () => ({ usbVendorId: 0x0483, usbProductId: 0x5740 }),
      open: async () => {},
      close: async () => {},
      readable: new ReadableStream<Uint8Array>({
        start(c) {
          sink = c;
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(bytes) {
          const v = new DataView(bytes.buffer, bytes.byteOffset);
          const duty = v.getFloat32(8, true);
          writes.push(duty);
          if (seq % 2 === 0) tick += 2000;
          sink.enqueue(
            telemetryFrame({
              seq: seq++,
              duty,
              pendulum_raw: 180,
              pendulum_vel_raw_deg_s: 0,
              motor_raw: 0,
              motor_vel_raw_deg_s: 0,
              pendulum_vel_deg_s: 0,
              motor_vel_deg_s: 0,
              tick_us: tick,
              reserved: 0,
            }),
          );
        },
      }),
    };
    vi.stubGlobal("navigator", {
      serial: { getPorts: async () => [port], addEventListener: () => {} },
    });
    vi.stubGlobal("postMessage", (e: WorkerEvent) => events.push(e));
    vi.stubGlobal("onmessage", null);
    await import("./control.worker");
    const command = async (data: WorkerCommand) => {
      await (
        globalThis as unknown as {
          onmessage: (e: { data: WorkerCommand }) => Promise<void>;
        }
      ).onmessage({ data });
      await vi.advanceTimersByTimeAsync(1);
    };
    await command({ type: "ports" });
    await command({ type: "connect", portId: 0, baudRate: 115200 });
    await vi.advanceTimersByTimeAsync(50);
    expect(
      events.some((e) => e.type === "status" && e.connection === "connected"),
    ).toBe(true);
    await command({
      type: "start",
      action: "pulse",
      config: { ...DEFAULT_CONFIG, pulseMs: 1000 },
    });
    await vi.advanceTimersByTimeAsync(240);
    expect(events.filter((e) => e.type === "telemetry").at(-1)).toMatchObject({
      active: true,
    });
    expect(writes.filter((x) => x === 25).length).toBeGreaterThan(5);
    expect(
      events.some((e) => e.type === "status" && e.connection === "fault"),
    ).toBe(false);
    await command({ type: "stop" });
    const afterStop = writes.length;
    await vi.advanceTimersByTimeAsync(150);
    expect(writes.slice(afterStop).every((x) => x === 0)).toBe(true);
    const record = events.find((e) => e.type === "record");
    expect(
      record?.type === "record" && record.record.samples.length,
    ).toBeGreaterThan(10);
    await command({ type: "disconnect" });
  });
});
