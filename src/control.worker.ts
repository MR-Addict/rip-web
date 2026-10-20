import { serialSafety } from "./serial-safety";
import { Engine } from "./engine";
import { Decoder, pwmFrame, telemetryFrame } from "./protocol";
import { LatestWriter } from "./writer";
import type {
  Connection,
  RawSample,
  SensorSample,
  WorkerCommand,
  WorkerEvent,
} from "./types";

const scope = globalThis as unknown as {
  navigator: Navigator;
  postMessage: (e: WorkerEvent) => void;
  onmessage: (e: MessageEvent<WorkerCommand>) => void;
};
const send = (e: WorkerEvent) => scope.postMessage(e);
const now = () => performance.now() / 1000;
const engine = new Engine(
  (r) => send({ type: "record", record: r }),
  (event) => send({ type: "event", event }),
);
let connection: Connection = "disconnected",
  simulation = false;
let port: SerialPort | null = null,
  ports: SerialPort[] = [];
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let serialWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
let writer: LatestWriter | null = null;
let decoder = new Decoder(),
  batch: SensorSample[] = [];
let generation = 0,
  sequence = 0,
  lastFresh = 0,
  lastHeartbeat = now(),
  visible = true,
  connectedAt = 0;
let lastZero = 0,
  lastWrite = 0,
  windowStart = now(),
  received = 0,
  controls = 0,
  sent = 0,
  total = 0,
  latency: number | null = null;
let sampleHz = 0,
  controlHz = 0,
  sendHz = 0;
const txTimes = new Map<number, number>();
let simTimer: ReturnType<typeof setInterval> | null = null;
let simDuty = 0,
  simTick = 0,
  simSeq = 0,
  simTheta = Math.PI,
  simVelocity = 0,
  simMotor = 0,
  simMotorVelocity = 0;
let stall = false,
  writeFailure = false;
let lifecycleBusy = false;
let cleanupTask: Promise<void> = Promise.resolve();

function status(state: Connection, message: string) {
  connection = state;
  send({ type: "status", connection, simulation, message });
}
function stop(reason: string) {
  engine.stop(reason, now());
  writer?.request(0);
}
function fault(message: string) {
  stop(message);
  status("fault", message);
  void cleanup();
}
function flush() {
  const time = now();
  if (time - windowStart >= 1) {
    sampleHz = received / (time - windowStart);
    controlHz = controls / (time - windowStart);
    sendHz = sent / (time - windowStart);
    received = controls = sent = 0;
    windowStart = time;
  }
  send({
    type: "telemetry",
    samples: batch,
    phase: engine.controller.phase,
    active: engine.active,
    diagnostics: {
      sampleHz,
      controlHz,
      sendHz,
      latencyMs: latency,
      badFrames: decoder.badFrames,
      samples: total,
      memoryBytes: engine.memoryBytes,
      pendulumCalibrated: engine.pendulumCalibrated,
      pendulumZero: engine.pendulumZero,
    },
  });
  batch = [];
}
function accept(chunk: Uint8Array) {
  const raws = decoder.push(chunk);
  let fresh = false;
  for (const raw of raws) {
    const time = now();
    const wasActive = engine.active;
    const result = engine.accept(raw, time);
    if (wasActive && result.fresh) controls++;
    if (result.fresh) {
      lastFresh = time;
      fresh = true;
      received++;
    }
    batch.push(result.sample);
    total++;
    const sentAt = txTimes.get(raw.seq);
    if (sentAt !== undefined) {
      latency = Math.max(0, (time - sentAt) * 1000);
      txTimes.delete(raw.seq);
    }
  }
  if (raws.length && connection === "connecting")
    status(
      "connected",
      simulation
        ? "模拟装置已连接 · 非实机数据"
        : "串口已连接 · 有效遥测已确认",
    );
  // Only the freshest output survives a burst of buffered telemetry.
  if (fresh && (connection === "connected" || connection === "connecting"))
    writer?.request(engine.active ? engine.latest!.target_duty : 0);
}
async function cleanup() {
  const oldPort = port,
    oldReader = reader,
    oldWriter = serialWriter;
  generation++;
  writer?.close();
  writer = null;
  port = null;
  reader = null;
  serialWriter = null;
  if (simTimer) clearInterval(simTimer);
  simTimer = null;
  simDuty = 0;
  const operation = (async () => {
    try {
      if (oldWriter) {
        await Promise.race([
          oldWriter.write(pwmFrame(sequence++, 0)),
          new Promise((resolve) => setTimeout(resolve, 250)),
        ]);
      }
    } catch {
      /* physical disconnect: zero output can no longer be delivered */
    }
    try {
      await oldReader?.cancel();
    } catch {
      /* already disconnected */
    }
    try {
      oldWriter?.releaseLock();
    } catch {
      /* a device write may still be in flight */
    }
    try {
      await oldPort?.close();
    } catch {
      /* the OS may have already closed it */
    }
  })();
  cleanupTask = Promise.all([cleanupTask, operation]).then(() => undefined);
  await cleanupTask;
}
function reset(sim: boolean) {
  simulation = sim;
  engine.resetConnection();
  if (sim) engine.pendulumCalibrated = true;
  decoder = new Decoder();
  batch = [];
  sequence = 0;
  txTimes.clear();
  total = received = controls = sent = 0;
  sampleHz = controlHz = sendHz = 0;
  latency = null;
  lastWrite = now();
  windowStart = connectedAt = lastZero = now();
  lastFresh = 0;
  stall = writeFailure = false;
}
async function connect(id: number, baudRate: number) {
  if (
    lifecycleBusy ||
    connection === "connecting" ||
    connection === "connected"
  )
    throw new Error("设备已连接或正在连接");
  lifecycleBusy = true;
  const pending = cleanup(),
    token = generation;
  try {
    await pending;
    if (token !== generation) return;
    const selected = ports[id];
    if (!selected) throw new Error("串口列表已变化，请重新选择");
    if (![115200, 230400, 460800, 921600].includes(baudRate))
      throw new Error("波特率无效");
    reset(false);
    status("connecting", "等待串口有效遥测…");
    await selected.open({
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
      bufferSize: 8192,
    });
    if (token !== generation) {
      await selected.close();
      return;
    }
    port = selected;
    if (!port.readable || !port.writable) throw new Error("串口不可读写");
    reader = port.readable.getReader();
    serialWriter = port.writable.getWriter();
    const output = serialWriter;
    writer = new LatestWriter(
      async (duty) => {
        const seq = sequence++ >>> 0;
        txTimes.set(seq, now());
        if (txTimes.size > 128) txTimes.delete(txTimes.keys().next().value!);
        await output.write(pwmFrame(seq, duty));
        lastWrite = now();
        sent++;
      },
      (e) => {
        if (token === generation) fault(`串口写入失败：${String(e)}`);
      },
    );
    writer.request(0);
    void readLoop(reader, token);
  } catch (e) {
    if (token === generation) fault(`连接失败：${String(e)}`);
  } finally {
    lifecycleBusy = false;
  }
}
async function readLoop(
  input: ReadableStreamDefaultReader<Uint8Array>,
  token: number,
) {
  try {
    while (generation === token) {
      const { value, done } = await input.read();
      if (generation !== token) break;
      if (done) {
        fault("串口数据流已关闭");
        break;
      }
      if (value) accept(value);
    }
  } catch (e) {
    if (generation === token) fault(`串口读取失败：${String(e)}`);
  } finally {
    try {
      input.releaseLock();
    } catch {
      /* cancelled */
    }
  }
}
async function simulate() {
  if (
    lifecycleBusy ||
    connection === "connected" ||
    connection === "connecting"
  )
    throw new Error("请先断开当前设备");
  lifecycleBusy = true;
  const pending = cleanup(),
    token = generation;
  try {
    await pending;
    if (token !== generation) return;
    reset(true);
    status("connecting", "初始化模拟装置…");
    simTick = simSeq = 0;
    simTheta = Math.PI;
    simVelocity = simMotor = simMotorVelocity = simDuty = 0;
    writer = new LatestWriter(
      async (duty) => {
        if (writeFailure) throw new Error("模拟写入失败");
        simDuty = duty;
        lastWrite = now();
        sent++;
      },
      (e) => {
        if (token === generation) fault(String(e));
      },
    );
    simTimer = setInterval(() => {
      if (stall) return;
      // Simple coupled nonlinear plant for UI/protocol checks, not a hardware model.
      for (let i = 0; i < 2; i++) {
        const dt = 0.002,
          motorAcceleration = simDuty * 0.7 - simMotorVelocity * 3;
        simMotorVelocity += motorAcceleration * dt;
        simMotor += simMotorVelocity * dt;
        simVelocity +=
          (125.1154 * Math.sin(simTheta) +
            0.7 * motorAcceleration * Math.cos(simTheta) -
            0.55 * simVelocity) *
          dt;
        simTheta += simVelocity * dt;
        simTick = (simTick + 2000) >>> 0;
        const deg = 180 / Math.PI;
        const raw: RawSample = {
          seq: simSeq++,
          duty: simDuty,
          pendulum_raw: simTheta * deg,
          pendulum_vel_raw_deg_s: simVelocity * deg,
          motor_raw: simMotor * deg,
          motor_vel_raw_deg_s: simMotorVelocity * deg,
          pendulum_vel_deg_s: simVelocity * deg,
          motor_vel_deg_s: simMotorVelocity * deg,
          tick_us: simTick,
          reserved: 0,
        };
        accept(telemetryFrame(raw));
      }
    }, 4);
  } finally {
    lifecycleBusy = false;
  }
}
setInterval(() => {
  const t = now();
  if (connection !== "connected" && connection !== "connecting") return;
  if (engine.active && (!visible || t - lastHeartbeat > 1))
    stop(!visible ? "页面不可见，已停止" : "界面心跳超时，已停止");
  if (connection === "connected") {
    const check = serialSafety(engine, t, lastFresh);
    if (check?.fault) {
      fault(check.reason);
      return;
    }
    if (check) stop(check.reason);
  }
  if (connection === "connecting" && t - connectedAt > 3) {
    fault("3 秒内未收到有效遥测，请检查设备、波特率和串口占用");
    return;
  }
  // Firmware may return a cached tick. Keep request/response traffic alive without
  // integrating the controller on duplicates; the 100 ms freshness guard remains authoritative.
  if (engine.active && t - lastWrite >= 0.01)
    writer?.request(engine.latest?.target_duty ?? 0);
  if (!engine.active && t - lastZero >= 0.02) {
    writer?.request(0);
    lastZero = t;
  }
}, 10);
setInterval(flush, 100);
scope.navigator.serial?.addEventListener("disconnect", (e) => {
  if (port && e.target === port) fault("USB 设备已拔出");
});
scope.onmessage = async ({ data: command }) => {
  try {
    switch (command.type) {
      case "heartbeat":
        visible = command.visible;
        lastHeartbeat = now();
        if (!visible) stop("页面不可见，已停止");
        break;
      case "ports": {
        if (!scope.navigator.serial)
          throw new Error("浏览器不支持 Web Serial，请使用桌面 Chrome");
        ports = await scope.navigator.serial.getPorts();
        send({
          type: "ports",
          ports: ports.map((p, id) => {
            const info = p.getInfo();
            const hex = (x?: number) =>
              x?.toString(16).padStart(4, "0") ?? "????";
            return {
              id,
              label: `${info.usbVendorId === 0x483 && info.usbProductId === 0x5740 ? "STM32 · 倒立摆" : "USB 串口"} ${hex(info.usbVendorId)}:${hex(info.usbProductId)} · ${id + 1}`,
            };
          }),
        });
        break;
      }
      case "connect":
        await connect(command.portId, command.baudRate);
        break;
      case "simulate":
        await simulate();
        break;
      case "disconnect":
        stop("设备已断开");
        status("disconnected", "设备已断开");
        await cleanup();
        break;
      case "stop":
        stop(command.reason ?? "手动停止");
        break;
      case "zero":
        engine.zero();
        send({ type: "notice", message: "底座角度已归零" });
        break;
      case "calibrateUpright": {
        if (simulation || connection !== "connected" || now() - lastFresh > 0.1)
          throw new Error("需要实机新鲜遥测才能标定直立");
        const offset = engine.calibrateUpright();
        send({
          type: "notice",
          message: `直立标定完成，原始零点 ${offset.toFixed(3)}°；采用 333° 有效量程，下垂盲区的姿态不可信`,
        });
        break;
      }
      case "calibrateDown": {
        if (connection !== "connected" || now() - lastFresh > 0.1)
          throw new Error("需要新鲜遥测才能标定");
        if (!simulation)
          throw new Error("实机下垂存在盲区，请改用手扶直立标定");
        const offset = engine.calibrateDown();
        send({
          type: "notice",
          message: `下垂姿态标定完成，摆杆偏移 ${offset.toFixed(3)}°；原始传感器数据保持不变`,
        });
        break;
      }
      case "clear":
        engine.clear();
        break;
      case "start":
        if (
          connection !== "connected" ||
          now() - lastFresh > 0.1 ||
          !visible ||
          now() - lastHeartbeat > 1
        )
          throw new Error("设备或界面尚未就绪，请确认新鲜遥测");
        engine.start(
          command.action,
          command.config,
          now(),
          simulation,
          command.direction,
          command.calibrateDown,
          command.downConfirmed,
        );
        break;
      case "inject":
        if (!simulation || connection !== "connected")
          throw new Error("故障注入仅用于已连接的模拟装置");
        if (command.fault === "stall") stall = true;
        else if (command.fault === "write") {
          writeFailure = true;
          writer?.request(0);
        } else fault("模拟 USB 拔出");
        break;
    }
  } catch (e) {
    send({
      type: "notice",
      message: e instanceof Error ? e.message : String(e),
    });
  }
};
