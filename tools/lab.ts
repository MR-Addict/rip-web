import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { SerialPort } from "serialport";
import { NodeLab } from "./node-lab";
import { replayRecord } from "./replay";
const emit = (event: unknown) => console.log(JSON.stringify(event));
const args = process.argv.slice(2),
  mode = args.shift();
const flag = (key: string) => {
  const i = args.indexOf(key);
  return i < 0 ? undefined : args[i + 1];
};
if (mode === "ports") emit(await SerialPort.list());
else if (mode === "replay") {
  const file = flag("--file");
  if (!file) throw new Error("需要 --file JSON");
  emit(
    replayRecord(
      JSON.parse(await readFile(file, "utf8")),
      JSON.parse(flag("--config") ?? "{}"),
    ),
  );
} else if (mode === "session") {
  const candidates = (await SerialPort.list()).filter(
    (p) =>
      p.vendorId?.toLowerCase() === "0483" &&
      p.productId?.toLowerCase() === "5740",
  );
  const portPath =
    flag("--port") ??
    (candidates.length === 1 ? candidates[0].path : undefined);
  if (!portPath)
    throw new Error("STM32 不唯一或未找到，请用 ports 查看后指定 --port");
  const lab = new NodeLab(
    portPath,
    path.resolve(flag("--out") ?? "artifacts/node"),
    emit,
  );
  const hardware = candidates.find(
    (p) =>
      p.path === portPath ||
      p.path.replace("/dev/tty.", "/dev/cu.") === portPath,
  );
  const profile = flag("--config-file")
    ? JSON.parse(await readFile(flag("--config-file")!, "utf8"))
    : {};
  const calibration = flag("--calibration")
    ? JSON.parse(await readFile(flag("--calibration")!, "utf8"))
    : null;
  if (
    calibration &&
    (!hardware?.serialNumber ||
      hardware.serialNumber !== calibration.serialNumber ||
      hardware.vendorId !== calibration.vendorId ||
      hardware.productId !== calibration.productId)
  )
    throw new Error("标定文件与USB设备身份不符，拒绝引用");
  await lab.open();
  if (calibration) lab.restoreCalibration(calibration.zero, calibration.scale);
  const rl = createInterface({ input: process.stdin, terminal: false });
  let ending = false;
  const finish = async () => {
    if (ending) return;
    ending = true;
    rl.close();
    await lab.close();
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(sig, () => {
      void finish();
    });
  process.once("uncaughtException", (e) => {
    emit({ type: "error", reason: String(e) });
    void finish();
  });
  process.once("unhandledRejection", (e) => {
    emit({ type: "error", reason: String(e) });
    void finish();
  });
  emit({
    type: "ready",
    commands: [
      "status",
      "calibrate-upright（可选）",
      'pulse {"pulseDuty":25,"pulseMs":100}',
      'jog {"direction":1,"duration":0.2}',
      'observe {"duration":10}',
      "stop",
      "quit",
    ],
    note: "连接后只发送零PWM。点动／脉冲不需要摆杆标定；stop 或 Ctrl+C 归零；quit 关闭前核对零反馈。",
  });
  for await (const line of rl) {
    if (ending) break;
    const match = line.trim().match(/^(\S+)(?:\s+(.+))?$/);
    if (!match) continue;
    try {
      const [, command, body] = match;
      if (command === "status") emit({ type: "status", ...lab.status() });
      else if (command === "calibrate-upright") {
        lab.calibrate();
        const file = path.join(
          lab.outputDir,
          `calibration-${hardware?.serialNumber ?? "unknown"}.json`,
        );
        await writeFile(
          file,
          JSON.stringify({
            zero: lab.engine.pendulumZero,
            scale: lab.engine.pendulumScale,
            serialNumber: hardware?.serialNumber,
            vendorId: hardware?.vendorId,
            productId: hardware?.productId,
            createdAt: new Date().toISOString(),
          }),
        );
        emit({ type: "calibration-file", file });
      } else if (command === "stop") lab.stop();
      else if (command === "quit") {
        await finish();
        break;
      } else if (
        command === "swing" ||
        command === "observe" ||
        command === "pulse" ||
        command === "jog" ||
        command === "sine"
      ) {
        if (command === "swing" && !args.includes("--experimental-auto"))
          throw new Error(
            "自动起摆已退出产品范围；仅研究模式可显式添加 --experimental-auto",
          );
        const {
          downConfirmed = false,
          direction = 1,
          ...config
        } = JSON.parse(body ?? "{}");
        lab.start(
          command,
          {
            ...profile,
            ...(command === "jog" ? { duration: 0.2 } : {}),
            ...config,
          },
          downConfirmed === true,
          direction,
        );
      } else throw new Error("未知命令");
    } catch (e) {
      emit({ type: "command-error", reason: String(e) });
    }
  }
  await finish();
} else
  console.log(
    "用法：npm run lab -- ports | session [--port PATH] [--out DIR] [--config-file JSON] [--calibration JSON] | replay --file JSON [--config JSON]",
  );
