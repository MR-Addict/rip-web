export type Action = "swing" | "jog" | "pulse" | "sine" | "observe";
export type Phase =
  | "idle"
  | "kick"
  | "swing"
  | "coast"
  | "balance"
  | "jog"
  | "pulse"
  | "sine"
  | "observe";
export type Connection = "disconnected" | "connecting" | "connected" | "fault";
export interface ControlConfig {
  bootstrapPairs: number;
  swingMethod: number;
  motorPolarity: number;
  turnMargin: number;
  travelLimit: number;
  maxDuty: number;
  kickDuty: number;
  kickMs: number;
  duration: number;
  jogDuty: number;
  pulseDuty: number;
  pulseMs: number;
  sineDuty: number;
  sineHz: number;
  sineSeconds: number;
  omegaN: number;
  swingGain: number;
  deadzone: number;
  energyLpf: number;
  coastMs: number;
  kp: number;
  ki: number;
  kd: number;
  outerKp: number;
  outerKi: number;
  outerKd: number;
  entryDwellMs: number;
  entryAngle: number;
  entryVelocity: number;
  exitAngle: number;
  exitVelocity: number;
}
export const DEFAULT_CONFIG: ControlConfig = {
  bootstrapPairs: 3,
  swingMethod: 1,
  motorPolarity: -1,
  turnMargin: 1.5,
  travelLimit: 180,
  maxDuty: 40,
  kickDuty: 30,
  kickMs: 100,
  duration: 5,
  jogDuty: 20,
  pulseDuty: 25,
  pulseMs: 100,
  sineDuty: 15,
  sineHz: 0.5,
  sineSeconds: 5,
  omegaN: 11.1855,
  swingGain: 1,
  deadzone: 20,
  energyLpf: 0.9,
  coastMs: 40,
  kp: (0.3 * 4095) / 333,
  ki: (0.01 * 4095) / 333 / 0.005,
  kd: (0.4 * 0.005 * 4095) / 333,
  outerKp: 0.4 * (408 / 360) * (333 / 4095),
  outerKi: 0,
  outerKd: 4 * 0.05 * (408 / 360) * (333 / 4095),
  entryDwellMs: 25,
  entryAngle: 24,
  entryVelocity: 350,
  exitAngle: 45,
  exitVelocity: 600,
};
export interface RawSample {
  seq: number;
  duty: number;
  pendulum_raw: number;
  pendulum_vel_raw_deg_s: number;
  motor_raw: number;
  motor_vel_raw_deg_s: number;
  pendulum_vel_deg_s: number;
  motor_vel_deg_s: number;
  tick_us: number;
  reserved: number;
  adc_raw?: number;
  motor_velocity_bits?: number;
}
export interface SensorSample extends RawSample {
  host_time_s: number;
  device_time_s: number;
  relative_time_s: number;
  pendulum_deg: number;
  pendulum_down_deg: number;
  motor_deg: number;
  motor_cont_deg: number;
  target_duty: number;
  phase: Phase;
  energy: number;
  pendulum_calibrated: boolean;
  pendulum_scale?: number;
  control_velocity_deg_s?: number;
}
export interface ExperimentEvent {
  time_s: number;
  label: string;
  phase: Phase;
}
export interface ExperimentRecord {
  id: string;
  startedAt: string;
  action: Action;
  simulation: boolean;
  config: ControlConfig;
  motorZero: number;
  pendulumZero: number;
  pendulumCalibrated: boolean;
  calibrationBasis?: "down" | "upright";
  pendulumScale?: number;
  samples: SensorSample[];
  events: ExperimentEvent[];
  reason: string;
  duration: number;
}
export interface PortChoice {
  id: number;
  label: string;
}
export interface Diagnostics {
  sampleHz: number;
  controlHz: number;
  sendHz: number;
  latencyMs: number | null;
  badFrames: number;
  samples: number;
  memoryBytes: number;
  pendulumCalibrated: boolean;
  pendulumZero: number;
}
export type WorkerCommand =
  | { type: "ports" }
  | { type: "connect"; portId: number; baudRate: number }
  | { type: "simulate" }
  | { type: "disconnect" }
  | {
      type: "start";
      action: Action;
      config: ControlConfig;
      direction?: number;
      calibrateDown?: boolean;
      downConfirmed?: boolean;
    }
  | { type: "stop"; reason?: string }
  | { type: "zero" }
  | { type: "calibrateDown" }
  | { type: "calibrateUpright" }
  | { type: "heartbeat"; visible: boolean }
  | { type: "clear" }
  | { type: "inject"; fault: "stall" | "write" | "unplug" };
export type WorkerEvent =
  | { type: "ports"; ports: PortChoice[] }
  | {
      type: "status";
      connection: Connection;
      simulation: boolean;
      message: string;
    }
  | {
      type: "telemetry";
      samples: SensorSample[];
      diagnostics: Diagnostics;
      phase: Phase;
      active: boolean;
    }
  | { type: "record"; record: ExperimentRecord }
  | { type: "notice"; message: string }
  | { type: "event"; event: ExperimentEvent };
export const PHASE_LABEL: Record<Phase, string> = {
  idle: "已停止",
  kick: "启动中",
  swing: "起摆中",
  coast: "滑行",
  balance: "稳摆中",
  jog: "点动中",
  pulse: "脉冲中",
  sine: "正弦激励中",
  observe: "采集中",
};
export const ACTION_LABEL: Record<Action, string> = {
  swing: "起摆",
  jog: "点动",
  pulse: "脉冲",
  sine: "正弦激励",
  observe: "传感器采集",
};
