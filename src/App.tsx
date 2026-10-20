import { useEffect, useMemo, useRef, useState } from "react";
import { Scope, AnalysisPlot, CHANNELS } from "./Charts";
import { Pose } from "./Pose";
import { stillnessReport } from "./stillness";
import { downloadRecord } from "./export";
import {
  ACTION_LABEL,
  DEFAULT_CONFIG,
  PHASE_LABEL,
  type Action,
  type Connection,
  type ControlConfig,
  type Diagnostics,
  type ExperimentEvent,
  type ExperimentRecord,
  type Phase,
  type PortChoice,
  type SensorSample,
  type WorkerCommand,
  type WorkerEvent,
} from "./types";

const number = (v?: number, digits = 2) =>
  v === undefined
    ? "—"
    : (Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v).toFixed(digits);
const initialDiagnostics: Diagnostics = {
  sampleHz: 0,
  controlHz: 0,
  sendHz: 0,
  latencyMs: null,
  badFrames: 0,
  samples: 0,
  memoryBytes: 0,
  pendulumCalibrated: false,
  pendulumZero: 0,
};
export default function App() {
  const worker = useRef<Worker | null>(null);
  const history = useRef<SensorSample[]>([]);
  const frozen = useRef<SensorSample[]>([]);
  const jogHeld = useRef(false),
    runningRef = useRef(false);
  const [connection, setConnection] = useState<Connection>("disconnected");
  const [simulation, setSimulation] = useState(false);
  const [message, setMessage] = useState("设备未连接");
  const [notice, setNotice] = useState("");
  const [ports, setPorts] = useState<PortChoice[]>([]);
  const [portId, setPortId] = useState(0);
  const [baudRate, setBaudRate] = useState(115200);
  const [connectDialog, setConnectDialog] = useState(false);
  const [help, setHelp] = useState(false);
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [latest, setLatest] = useState<SensorSample>();
  const [lastDataAt, setLastDataAt] = useState(0);
  const [diagnostics, setDiagnostics] = useState(initialDiagnostics);
  const [action, setAction] = useState<Action>("pulse");
  const [config, setConfig] = useState({ ...DEFAULT_CONFIG });
  const [records, setRecords] = useState<ExperimentRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [events, setEvents] = useState<ExperimentEvent[]>([]);
  const [windowSeconds, setWindowSeconds] = useState(10);
  const [paused, setPaused] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [replayRunning, setReplayRunning] = useState(false);
  const [replayTime, setReplayTime] = useState(0);
  const [plotsOpen, setPlotsOpen] = useState(false);
  const [signal, setSignal] = useState("angle");
  const send = (command: WorkerCommand) => worker.current?.postMessage(command);
  const stop = (reason = "手动停止") => {
    jogHeld.current = false;
    runningRef.current = false;
    send({ type: "stop", reason });
    setActive(false);
  };
  useEffect(() => {
    const w = new Worker(new URL("./control.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = w;
    w.onmessage = ({ data: e }: MessageEvent<WorkerEvent>) => {
      if (e.type === "status") {
        setConnection(e.connection);
        setSimulation(e.simulation);
        setMessage(e.message);
        if (e.connection === "connecting") {
          history.current = [];
          frozen.current = [];
          setLatest(undefined);
          setEvents([]);
          setPaused(false);
        }
        if (e.connection !== "connected") {
          setActive(false);
          runningRef.current = false;
        }
        if (e.connection === "fault") setNotice(e.message);
        if (e.connection === "connected") setConnectDialog(false);
      } else if (e.type === "ports") {
        setPorts(e.ports);
        setPortId(e.ports.find((p) => p.label.startsWith("STM32"))?.id ?? 0);
      } else if (e.type === "telemetry") {
        if (e.samples.length) {
          history.current = history.current.concat(e.samples).slice(-20000);
          setLatest(e.samples.at(-1));
          setLastDataAt(Date.now());
        }
        setDiagnostics(e.diagnostics);
        setActive(e.active);
        runningRef.current = e.active;
        setPhase(e.phase);
      } else if (e.type === "record") {
        setActive(false);
        runningRef.current = false;
        setPhase("idle");
        setRecords((prev) => [...prev, e.record]);
        setSelectedId(e.record.id);
      } else if (e.type === "notice") {
        setNotice(e.message);
      } else if (e.type === "event")
        setEvents((prev) => [...prev, e.event].slice(-50));
    };
    w.onerror = (e) => {
      setNotice(`控制线程异常：${e.message}。请检查电机输出并重新加载。`);
      setConnection("fault");
      setActive(false);
    };
    const heartbeat = () =>
      w.postMessage({
        type: "heartbeat",
        visible: document.visibilityState === "visible",
      });
    const interval = setInterval(heartbeat, 200);
    heartbeat();

    document.addEventListener("visibilitychange", heartbeat);
    const blur = () => {
      if (jogHeld.current) {
        jogHeld.current = false;
        w.postMessage({ type: "stop", reason: "窗口失焦，点动停止" });
      }
    };
    window.addEventListener("blur", blur);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", heartbeat);
      window.removeEventListener("blur", blur);
      w.postMessage({ type: "disconnect" });
      setTimeout(() => w.terminate(), 300);
    };
  }, []);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (records.length || active) {
        send({ type: "stop", reason: "离开页面" });
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [records.length, active]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 8000);
    return () => clearTimeout(timer);
  }, [notice]);
  const connected = connection === "connected";
  const fresh = connected && Date.now() - lastDataAt < 250;
  function start(which: Action, direction?: number) {
    if (runningRef.current || !fresh) return;
    setReplaying(false);
    setReplayRunning(false);
    setPaused(false);
    setEvents([]);
    runningRef.current = true;
    send({
      type: "start",
      action: which,
      config: which === "observe" ? { ...config, duration: 10 } : config,
      direction,
      calibrateDown: false,
    });
  }
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        stop("空格键停止");
      }
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement ||
        connectDialog ||
        help
      )
        return;
      if (
        !replaying &&
        fresh &&
        !e.repeat &&
        ["ArrowLeft", "ArrowRight"].includes(e.code)
      ) {
        e.preventDefault();
        if (!runningRef.current) {
          jogHeld.current = true;
          start("jog", e.code === "ArrowLeft" ? -1 : 1);
        }
      }
    };
    const keyup = (e: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight"].includes(e.code) && jogHeld.current)
        stop("松开方向键");
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
    };
  }, [fresh, config, connectDialog, help, replaying]);
  const selected = records.find((r) => r.id === selectedId);
  useEffect(() => {
    if (!replaying || !replayRunning || !selected) return;
    let previous = performance.now();
    const timer = setInterval(() => {
      const current = performance.now();
      const dt = (current - previous) / 1000;
      previous = current;
      setReplayTime((t) => {
        const next = t + dt;
        if (next >= selected.duration) {
          setReplayRunning(false);
          return selected.duration;
        }
        return next;
      });
    }, 40);
    return () => clearInterval(timer);
  }, [replaying, replayRunning, selectedId]);
  const replaySamples =
    replaying && selected
      ? selected.samples.filter((s) => s.relative_time_s <= replayTime)
      : null;
  const displaySamples =
    replaySamples ?? (paused ? frozen.current : history.current);
  const displaySample = replaying ? replaySamples?.at(-1) : latest;
  const displayPhase = replaying ? (displaySample?.phase ?? "idle") : phase;
  const field = (
    key: keyof ControlConfig,
    label: string,
    step = 1,
    suffix?: string,
  ) => (
    <label className="field" key={key}>
      <span>{label}</span>
      <div>
        <input
          aria-label={label}
          type="number"
          step={step}
          value={config[key]}
          disabled={active}
          onChange={(e) =>
            setConfig((prev) => ({
              ...prev,
              [key]: e.target.value === "" ? 0 : Number(e.target.value),
            }))
          }
        />
        {suffix && <small>{suffix}</small>}
      </div>
    </label>
  );

  const authorize = async () => {
    try {
      if (!("serial" in navigator) || !window.isSecureContext)
        throw new Error(
          "请通过 localhost 或 HTTPS，在支持 Web Serial 的桌面 Chrome 中打开",
        );
      await navigator.serial.requestPort();
      send({ type: "ports" });
    } catch (e) {
      if ((e as Error).name !== "NotFoundError") setNotice(String(e));
    }
  };
  const openConnect = () => {
    setConnectDialog(true);
    send({ type: "ports" });
  };
  const togglePause = () => {
    if (!paused) frozen.current = [...history.current];
    setPaused(!paused);
  };
  function replay(record: ExperimentRecord) {
    setSelectedId(record.id);
    setReplaying(true);
    setReplayTime(0);
    setReplayRunning(true);
    setPaused(false);
  }
  const report = useMemo(
    () =>
      selected?.action === "observe" ? stillnessReport(selected.samples) : null,
    [selected],
  );
  const referenced = replaying
    ? Boolean(selected?.pendulumCalibrated)
    : diagnostics.pendulumCalibrated || simulation;
  const angleChannels = useMemo(
    () => [
      { key: "motor_deg" as const, label: "底座", color: "#2861ad", unit: "°" },
      {
        key: (referenced
          ? "pendulum_down_deg"
          : "pendulum_raw") as keyof SensorSample,
        label: referenced ? "连杆 · 标定值" : "连杆 · 原始值",
        color: "#b56b24",
        unit: "°",
      },
    ],
    [referenced],
  );
  const connectionText = connected
    ? simulation
      ? "模拟装置在线"
      : fresh
        ? "已连接"
        : "读数已过期"
    : connection === "connecting"
      ? "正在连接"
      : connection === "fault"
        ? "通信故障"
        : "未连接";
  return (
    <div className="app">
      <header className="topbar">
        <h1>旋转倒立摆</h1>
        <div className="header-actions">
          <span className={`connection-state ${fresh ? "online" : ""}`}>
            <i />
            {connectionText}
          </span>
          <button
            className="button"
            onClick={() =>
              connected || connection === "connecting"
                ? send({ type: "disconnect" })
                : openConnect()
            }
          >
            {connected || connection === "connecting" ? "断开连接" : "连接设备"}
          </button>
          <button
            className="button"
            disabled={!fresh || active || replaying}
            onClick={() => send({ type: "zero" })}
          >
            归零
          </button>
          <button
            className="button stop-button"
            aria-label="停止输出（空格）"
            onClick={() => stop()}
          >
            停止输出 <kbd>空格</kbd>
          </button>
          <button className="text-button" onClick={() => setHelp(true)}>
            说明
          </button>
        </div>
      </header>
      {simulation && (
        <div className="simulation-banner">
          <strong>模拟模式</strong>
        </div>
      )}
      {replaying && selected && (
        <div className="replay-banner">
          <b>历史回放{selected.simulation ? " · 模拟数据" : ""}</b>
          <button onClick={() => setReplayRunning(!replayRunning)}>
            {replayRunning ? "暂停" : "播放"}
          </button>
          <input
            aria-label="回放进度"
            type="range"
            min="0"
            max={Math.max(0.001, selected.duration)}
            step=".001"
            value={replayTime}
            onChange={(e) => {
              setReplayTime(Number(e.target.value));
              setReplayRunning(false);
            }}
          />
          <code>
            {replayTime.toFixed(1)} / {selected.duration.toFixed(1)}s
          </code>
          <button
            onClick={() => {
              setReplaying(false);
              setReplayRunning(false);
            }}
          >
            返回实时
          </button>
        </div>
      )}
      <main className="instrument">
        <section className="device" aria-label="装置与角度">
          <div className="panel-heading">
            <h2>装置</h2>
          </div>
          <div className="device-view">
            <Pose sample={fresh || replaying ? displaySample : undefined} />
          </div>
          <div className="readings">
            <div className="motor-reading">
              <span>底座角度 </span>
              <b>
                {number(displaySample?.motor_deg, 1)}
                <small>°</small>
              </b>
            </div>
            <div>
              <span>连杆读数 </span>
              <b>
                {number(
                  referenced
                    ? displaySample?.pendulum_down_deg
                    : displaySample?.pendulum_raw,
                  1,
                )}
                <small>°</small>
              </b>
            </div>
          </div>
        </section>
        <section className="control-area" aria-label="控制">
          <div className="panel-heading">
            <h2>控制</h2>
          </div>
          <div className="run-status">
            <span className={active ? "running" : ""}>
              <i />
              {PHASE_LABEL[displayPhase]}
            </span>
            <span>
              实际输出 <b>{number(displaySample?.duty, 0)}</b> %
            </span>
          </div>
          <details
            className="disclosure manual-section"
            name="control-section"
            open
          >
            <summary>手动点动</summary>
            <div className="manual-controls">
              {field("jogDuty", "点动幅值", 1, "%")}
              <div className="jog-buttons">
                {[-1, 1].map((dir) => (
                  <button
                    key={dir}
                    className="button primary"
                    disabled={
                      !fresh || replaying || (active && !jogHeld.current)
                    }
                    onPointerDown={(e) => {
                      e.preventDefault();
                      if (runningRef.current) return;
                      e.currentTarget.setPointerCapture(e.pointerId);
                      jogHeld.current = true;
                      start("jog", dir);
                    }}
                    onPointerUp={() => {
                      if (jogHeld.current) stop("松开点动按钮");
                    }}
                    onPointerCancel={() => {
                      if (jogHeld.current) stop("点动取消");
                    }}
                    onLostPointerCapture={() => {
                      if (jogHeld.current) stop("点动失去捕获");
                    }}
                  >
                    <span className="direction-arrow" aria-hidden="true">
                      {dir < 0 ? "←" : "→"}
                    </span>
                    按住{dir < 0 ? "左转" : "右转"}
                  </button>
                ))}
              </div>

              {field("duration", "单次最长运行", 1, "秒")}
            </div>
          </details>
          <details className="disclosure more-actions" name="control-section">
            <summary>脉冲与正弦激励</summary>
            <div className="details-body">
              <label className="select-field">
                动作
                <select
                  aria-label="动作"
                  value={action === "sine" ? "sine" : "pulse"}
                  disabled={active}
                  onChange={(e) => setAction(e.target.value as Action)}
                >
                  <option value="pulse">定时脉冲</option>
                  <option value="sine">正弦激励</option>
                </select>
              </label>
              {action !== "sine" && (
                <>
                  {field("pulseDuty", "脉冲幅值", 1, "%")}
                  {field("pulseMs", "脉冲宽度", 10, "ms")}
                  <button
                    className="button"
                    disabled={!fresh || active || replaying}
                    onClick={() => start("pulse")}
                  >
                    发送脉冲
                  </button>
                </>
              )}
              {action === "sine" && (
                <>
                  {field("sineDuty", "激励幅值", 1, "%")}
                  {field("sineHz", "激励频率", 0.1, "Hz")}
                  {field("sineSeconds", "持续时间", 1, "秒")}
                  <button
                    className="button"
                    disabled={!fresh || active || replaying}
                    onClick={() => start("sine")}
                  >
                    开始正弦激励
                  </button>
                </>
              )}
            </div>
          </details>
        </section>
      </main>
      {report?.motor && report.pendulum && (
        <section className="check-result">
          <h2>采集结果{selected?.simulation ? " · 模拟数据" : ""}</h2>
          <p>
            旋臂原始读数波动 <b>{report.motor.span.toFixed(2)}°</b>
            ；摆杆原始读数波动 <b>{report.pendulum.span.toFixed(2)}°</b>，趋势{" "}
            <b>{report.pendulum.slope.toFixed(3)}°/秒</b>。
          </p>
        </section>
      )}
      <section className="folds">
        <details
          className="disclosure"
          onToggle={(e) => setPlotsOpen(e.currentTarget.open)}
        >
          <summary>查看曲线</summary>
          {plotsOpen && (
            <div className="plot-area">
              <div className="chart-toolbar">
                <select
                  aria-label="曲线类型"
                  value={signal}
                  onChange={(e) => setSignal(e.target.value)}
                >
                  <option value="angle">角度</option>
                  <option value="velocity">角速度</option>
                  <option value="pwm">电机输出</option>
                  <option value="phase">摆杆相图</option>
                </select>
                <select
                  aria-label="图表时间窗"
                  value={windowSeconds}
                  onChange={(e) => setWindowSeconds(Number(e.target.value))}
                >
                  <option value="5">最近 5 秒</option>
                  <option value="10">最近 10 秒</option>
                  <option value="30">最近 30 秒</option>
                </select>
                <button
                  className="text-button"
                  aria-label={paused ? "继续绘图" : "暂停绘图"}
                  disabled={replaying}
                  onClick={togglePause}
                >
                  {paused ? "继续绘图" : "暂停绘图"}
                </button>
                {paused && <span className="chart-state">绘图已暂停</span>}
              </div>
              {signal === "phase" || signal === "energy" ? (
                <AnalysisPlot samples={displaySamples} kind={signal} />
              ) : (
                <Scope
                  samples={displaySamples}
                  channels={
                    signal === "angle"
                      ? angleChannels
                      : signal === "velocity"
                        ? CHANNELS.slice(2, 4)
                        : CHANNELS.slice(4)
                  }
                  windowSeconds={windowSeconds}
                  title={
                    signal === "angle"
                      ? "角度"
                      : signal === "velocity"
                        ? "角速度"
                        : "PWM"
                  }
                  unit={
                    signal === "velocity" ? "°/s" : signal === "pwm" ? "%" : "°"
                  }
                />
              )}
            </div>
          )}
        </details>
        <details className="disclosure">
          <summary>传感器数据</summary>
          <div className="details-body raw-data">
            <div className="raw-grid">
              <SensorRow
                label="旋臂原始角度"
                value={displaySample?.motor_raw}
                unit="°"
              />
              <SensorRow
                label="摆杆原始角度"
                value={displaySample?.pendulum_raw}
                unit="°"
              />
              <SensorRow
                label="旋臂角速度 · 原始"
                value={displaySample?.motor_vel_raw_deg_s}
                unit="°/s"
              />
              <SensorRow
                label="摆杆角速度 · 原始"
                value={displaySample?.pendulum_vel_raw_deg_s}
                unit="°/s"
              />
              <SensorRow
                label="旋臂角速度 · 滤波"
                value={displaySample?.motor_vel_deg_s}
                unit="°/s"
              />
              <SensorRow
                label="摆杆角速度 · 滤波"
                value={displaySample?.pendulum_vel_deg_s}
                unit="°/s"
              />
              <SensorRow
                label="摆杆角度 · 直立为零"
                value={displaySample?.pendulum_deg}
                unit="°"
              />
              <SensorRow
                label="摆杆 ADC 原值"
                value={displaySample?.adc_raw}
                unit=""
              />
              <SensorRow
                label="摆杆标定偏移"
                value={diagnostics.pendulumZero}
                unit="°"
              />
            </div>
            {simulation && (
              <div className="fault-tools">
                <span>模拟故障：</span>
                <button
                  onClick={() => send({ type: "inject", fault: "stall" })}
                >
                  遥测停滞
                </button>
                <button
                  onClick={() => send({ type: "inject", fault: "write" })}
                >
                  写入失败
                </button>
                <button
                  onClick={() => send({ type: "inject", fault: "unplug" })}
                >
                  模拟拔线
                </button>
              </div>
            )}
          </div>
        </details>
      </section>
      <section className="records">
        <div className="section-heading">
          <h2>
            实验记录 {records.length ? <small>{records.length}</small> : null}
          </h2>
          {active && <span className="recording">正在记录</span>}
          <div>
            <button
              className="text-button"
              disabled={active || !records.length}
              onClick={() => {
                setRecords([]);
                setSelectedId("");
                setReplaying(false);
                setReplayRunning(false);
                send({ type: "clear" });
              }}
            >
              清空记录
            </button>
            <button
              className="button compact"
              disabled={!selected}
              onClick={() => selected && downloadRecord(selected, "csv")}
            >
              导出 CSV
            </button>
            <button
              className="button compact"
              disabled={!selected}
              onClick={() => selected && downloadRecord(selected, "json")}
            >
              JSON
            </button>
          </div>
        </div>
        {records.length ? (
          <div className="records-scroll">
            <table>
              <thead>
                <tr>
                  <th>动作</th>
                  <th>时间</th>
                  <th>时长</th>
                  <th>采样</th>
                  <th>结束原因</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...records].reverse().map((r) => (
                  <tr
                    key={r.id}
                    className={selectedId === r.id ? "selected-row" : ""}
                    onClick={() => setSelectedId(r.id)}
                  >
                    <td>
                      {ACTION_LABEL[r.action]}
                      {r.simulation && <small className="sim-tag">模拟</small>}
                    </td>
                    <td>
                      {new Date(r.startedAt).toLocaleTimeString("zh-CN", {
                        hour12: false,
                      })}
                    </td>
                    <td>{r.duration.toFixed(1)}s</td>
                    <td>{r.samples.length}</td>
                    <td>{r.reason}</td>
                    <td>
                      <button
                        className="text-button"
                        disabled={active || !r.samples.length}
                        onClick={(e) => {
                          e.stopPropagation();
                          replay(r);
                        }}
                      >
                        回放
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-records">暂无记录</p>
        )}
      </section>
      {notice && (
        <div className="toast" role="alert">
          <span>{notice}</span>
          <button aria-label="关闭提示" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      )}
      {connectDialog && (
        <div className="modal-backdrop" onClick={() => setConnectDialog(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label="连接倒立摆"
            className="modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <h2>连接设备</h2>
              <button
                aria-label="关闭连接窗口"
                onClick={() => setConnectDialog(false)}
              >
                ×
              </button>
            </div>
            <button className="button primary authorize" onClick={authorize}>
              选择并授权串口
            </button>
            <label className="modal-field">
              已授权设备
              <select
                aria-label="已授权设备"
                value={portId}
                disabled={connection === "connecting"}
                onChange={(e) => setPortId(Number(e.target.value))}
              >
                {!ports.length && <option>暂无授权设备</option>}
                {ports.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <details className="connection-options">
              <summary>串口设置</summary>
              <label className="modal-field">
                波特率
                <select
                  aria-label="波特率"
                  value={baudRate}
                  disabled={connection === "connecting"}
                  onChange={(e) => setBaudRate(Number(e.target.value))}
                >
                  {[115200, 230400, 460800, 921600].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
            </details>
            <button
              className="button primary authorize"
              disabled={!ports.length || connection === "connecting"}
              onClick={() => send({ type: "connect", portId, baudRate })}
            >
              {connection === "connecting" ? "等待设备回包…" : "建立连接"}
            </button>
            <button
              className="text-button simulate-link"
              disabled={connection === "connecting"}
              onClick={() => {
                setConnectDialog(false);
                send({ type: "simulate" });
              }}
            >
              启动模拟装置
            </button>
          </section>
        </div>
      )}
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label="使用说明"
            className="modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <h2>使用说明</h2>
              <button aria-label="关闭说明" onClick={() => setHelp(false)}>
                ×
              </button>
            </div>
            <p>按住左右按钮或方向键转动，松开即停。按空格停止输出。</p>
            <p>每次操作自动记录，停止后可导出或回放。</p>
            <p>连杆在下垂位置的读数可能漂移。</p>
          </section>
        </div>
      )}
    </div>
  );
}
function SensorRow({
  label,
  value,
  unit,
}: {
  label: string;
  value?: number;
  unit: string;
}) {
  return (
    <div className="sensor-row">
      <span>{label}</span>
      <code>
        {number(value, 2)} <small>{unit}</small>
      </code>
    </div>
  );
}
