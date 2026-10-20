import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SerialPort } from "serialport";
import { Engine } from "../src/engine";
import { Decoder, pwmFrame } from "../src/protocol";
import { LatestWriter } from "../src/writer";
import { serialSafety } from "../src/serial-safety";
import { toCsv, toJson } from "../src/export";
import {
  DEFAULT_CONFIG,
  type Action,
  type ControlConfig,
  type ExperimentRecord,
} from "../src/types";
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export interface LabPort {
  readonly isOpen: boolean;
  open(callback: (error: Error | null) => void): void;
  write(
    bytes: Uint8Array,
    callback: (error: Error | null | undefined) => void,
  ): unknown;
  drain(callback: (error: Error | null) => void): void;
  close(callback: () => void): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}
export const clock = () => performance.now() / 1000;
export class NodeLab {
  readonly engine: Engine;
  readonly decoder = new Decoder();
  private port: LabPort;
  private writer: LatestWriter;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sequence = 0;
  private lastFresh = 0;
  private lastWrite = 0;
  private openedAt = 0;
  private stopAt = 0;
  private connected = false;
  private closing = false;
  private faulted = false;
  private saves: Promise<void>[] = [];
  private closeTask: Promise<void> | null = null;
  private count = 0;
  private freshCount = 0;
  constructor(
    readonly portPath: string,
    readonly outputDir: string,
    private emit: (event: unknown) => void = console.log,
    serial?: LabPort,
  ) {
    this.engine = new Engine(
      (r) => this.save(r),
      (e) => this.emit({ type: "event", ...e }),
    );
    this.port =
      serial ??
      new SerialPort({
        path: portPath,
        baudRate: 115200,
        autoOpen: false,
        lock: true,
      });
    this.writer = new LatestWriter(
      (duty) =>
        new Promise<void>((resolve, reject) => {
          if (this.closing || this.faulted || !this.engine.active) duty = 0;
          this.lastWrite = clock();
          this.port.write(pwmFrame(this.sequence++, duty), (err) => {
            if (err) {
              reject(err);
              return;
            }
            this.port.drain((error) => (error ? reject(error) : resolve()));
          });
        }),
      (e) => this.fail(`串口写失败：${String(e)}`),
    );
    this.port.on("data", (bytes: Buffer) => this.accept(bytes));
    this.port.on("error", (e) => this.fail(`串口异常：${e.message}`));
    this.port.on("close", () => {
      if (!this.closing) this.fail("串口已断开");
    });
  }
  async open() {
    await mkdir(this.outputDir, { recursive: true });
    await new Promise<void>((resolve, reject) =>
      this.port.open((e) => (e ? reject(e) : resolve())),
    );
    this.openedAt = clock();
    this.timer = setInterval(() => this.poll(), 10);
    this.writer.request(0);
    while (
      (!this.connected || this.engine.latest?.duty !== 0) &&
      !this.faulted &&
      clock() - this.openedAt < 3.1
    )
      await delay(10);
    if (!this.connected || this.engine.latest?.duty !== 0) {
      await this.close();
      throw new Error("3秒内没有有效零输出反馈，未允许动作");
    }
    this.emit({ type: "connected", path: this.portPath, output: 0 });
  }
  private accept(chunk: Uint8Array) {
    const raws = this.decoder.push(chunk);
    let fresh = false;
    for (const raw of raws) {
      const now = clock(),
        result = this.engine.accept(raw, now);
      this.count++;
      if (result.fresh) {
        this.lastFresh = now;
        this.freshCount++;
        fresh = true;
      }
      if (!this.connected && !this.faulted) this.connected = true;
    }
    if (fresh && !this.faulted)
      this.writer.request(
        this.engine.active ? this.engine.latest!.target_duty : 0,
      );
  }
  private poll() {
    const now = clock();
    if (this.faulted) return;
    if (!this.connected) {
      if (now - this.openedAt > 3) this.fail("3秒内没有有效遥测");
      else if (now - this.lastWrite > 0.02) this.writer.request(0);
      return;
    }
    const check = serialSafety(this.engine, now, this.lastFresh);
    if (check?.fault) {
      this.fail(check.reason);
      return;
    }
    if (check) this.stop(check.reason);
    if (now - this.lastWrite > (this.engine.active ? 0.01 : 0.02))
      this.writer.request(
        this.engine.active ? this.engine.latest!.target_duty : 0,
      );
  }
  status() {
    const s = this.engine.latest,
      seconds = Math.max(0.001, clock() - this.openedAt);
    return {
      connected: this.connected && !this.faulted,
      active: this.engine.active,
      phase: this.engine.controller.phase,
      sampleHz: this.freshCount / seconds,
      receivedHz: this.count / seconds,
      badFrames: this.decoder.badFrames,
      calibrated: this.engine.pendulumCalibrated,
      zero: this.engine.pendulumZero,
      latest: s && {
        raw: s.pendulum_raw,
        angle: s.pendulum_deg,
        velocity: s.control_velocity_deg_s,
        motor: s.motor_cont_deg,
        duty: s.duty,
        tick: s.tick_us,
      },
    };
  }
  calibrate() {
    this.ready();
    const zero = this.engine.calibrateUpright();
    this.emit({ type: "calibrated", zero, scale: this.engine.pendulumScale });
  }
  restoreCalibration(zero: number, scale: number) {
    this.ready();
    if (
      this.engine.active ||
      !Number.isFinite(zero) ||
      Math.abs(zero) > 30 ||
      scale !== 333 / 360
    )
      throw new Error("标定引用不合法");
    this.engine.pendulumZero = zero;
    this.engine.pendulumScale = scale;
    this.engine.calibrationBasis = "upright";
    this.engine.pendulumCalibrated = true;
    this.emit({
      type: "calibration-restored",
      zero,
      scale,
      note: "沿用显式指定的人工实测参考，没有重新采样或调整零点",
    });
  }
  start(
    action: Action,
    overrides: Partial<ControlConfig>,
    downConfirmed = false,
    direction = 1,
  ) {
    this.ready();
    if (this.closing) throw new Error("会话正在关闭");
    const config = { ...DEFAULT_CONFIG, ...overrides };
    if (config.maxDuty > 40) throw new Error("Node 硬件调试 PWM 上限为40%");
    this.engine.start(
      action,
      config,
      clock(),
      false,
      direction,
      false,
      downConfirmed,
    );
    this.emit({ type: "started", action, config });
  }
  stop(reason = "Node 手动停止") {
    this.stopAt = clock();
    this.engine.stop(reason, this.stopAt);
    this.writer.request(0);
  }
  private ready() {
    if (!this.connected || this.faulted || clock() - this.lastFresh > 0.1)
      throw new Error("没有新鲜有效遥测，请重连");
  }
  private fail(reason: string) {
    if (this.faulted || this.closing) return;
    this.faulted = true;
    this.stop(reason);
    this.emit({ type: "fault", reason });
    void this.close();
  }
  private save(record: ExperimentRecord) {
    const stem = `rip-NODE-${record.startedAt.replace(/[:.]/g, "-")}`;
    const json = path.join(this.outputDir, `${stem}.json`),
      csv = path.join(this.outputDir, `${stem}.csv`);
    const enriched = { ...record, runtime: "node", port: this.portPath };
    const task = Promise.all([
      writeFile(json, toJson(enriched)),
      writeFile(csv, toCsv(record)),
    ])
      .then(() => {
        this.emit({
          type: "record",
          json,
          csv,
          reason: record.reason,
          duration: record.duration,
          samples: record.samples.length,
          balanceSamples: record.samples.filter((s) => s.phase === "balance")
            .length,
        });
      })
      .catch((e) => {
        this.emit({ type: "save-error", reason: String(e) });
        this.fail("记录保存失败");
      });
    this.saves.push(task);
  }
  close() {
    return (this.closeTask ??= this.finishClose());
  }
  private async finishClose() {
    this.closing = true;
    this.stop("Node 会话结束");
    const deadline = clock() + 0.6;
    // Give the shared writer time to replace pending motion, then wait for a fresh zero feedback.
    while (
      clock() < deadline &&
      (!this.writer.idle ||
        !this.engine.latest ||
        this.engine.latest.host_time_s < this.stopAt ||
        this.engine.latest.duty !== 0)
    )
      await delay(10);
    const zeroConfirmed =
      !!this.engine.latest &&
      this.engine.latest.host_time_s >= this.stopAt &&
      this.engine.latest.duty === 0;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.writer.close();
    if (this.port.isOpen)
      await new Promise<void>((resolve) => this.port.close(() => resolve()));
    await Promise.all(this.saves);
    this.emit({ type: "closed", zeroConfirmed });
  }
}
