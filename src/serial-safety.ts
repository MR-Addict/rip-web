import type { Engine } from "./engine";
/** Same deadline policy for browser and Node. Caller invokes only after valid telemetry. */
export function serialSafety(
  engine: Engine,
  now: number,
  lastFresh: number,
): { reason: string; fault: boolean } | null {
  if (now - lastFresh > 0.1)
    return { reason: "遥测超过 100 ms 未更新，已停止", fault: true };
  if (!engine.active) return null;
  const c = engine.controller,
    deadline = c.pulseDeadline;
  if (deadline !== null && now > deadline + 0.035)
    return { reason: "脉冲换向未及时获得新鲜采样，已归零", fault: false };
  const duration =
    c.action === "pulse"
      ? c.config.pulseMs / 1000
      : c.action === "sine"
        ? c.config.sineSeconds
        : c.config.duration;
  if (now - c.started >= duration)
    return {
      reason:
        c.action === "swing" && c.phase !== "balance"
          ? "起摆超时"
          : "运行时限结束",
      fault: false,
    };
  return null;
}
