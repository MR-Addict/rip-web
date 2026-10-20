import type { ExperimentRecord, SensorSample } from "./types";
export const CSV_COLUMNS: (keyof SensorSample)[] = [
  "relative_time_s",
  "host_time_s",
  "device_time_s",
  "tick_us",
  "seq",
  "pendulum_raw",
  "pendulum_deg",
  "pendulum_down_deg",
  "pendulum_calibrated",
  "pendulum_scale",
  "control_velocity_deg_s",
  "pendulum_vel_raw_deg_s",
  "pendulum_vel_deg_s",
  "motor_raw",
  "motor_deg",
  "motor_cont_deg",
  "motor_vel_raw_deg_s",
  "motor_vel_deg_s",
  "target_duty",
  "duty",
  "phase",
  "energy",
  "reserved",
  "adc_raw",
  "motor_velocity_bits",
];
export function toCsv(record: ExperimentRecord): string {
  return (
    "\uFEFF" +
    CSV_COLUMNS.join(",") +
    "\r\n" +
    record.samples
      .map((s) => CSV_COLUMNS.map((k) => s[k]).join(","))
      .join("\r\n")
  );
}
export function toJson(record: ExperimentRecord) {
  return JSON.stringify({
    version: 2,
    units: {
      angle: "deg",
      velocity: "deg/s",
      duty: "%",
      time: "s",
      tick_us: "us",
    },
    ...record,
  });
}
export function downloadRecord(
  record: ExperimentRecord,
  format: "csv" | "json",
) {
  const body = format === "csv" ? toCsv(record) : toJson(record);
  const url = URL.createObjectURL(
    new Blob([body], {
      type: format === "csv" ? "text/csv;charset=utf-8" : "application/json",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `rip-${record.simulation ? "SIM-" : ""}${record.startedAt.replace(/[:.]/g, "-")}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
