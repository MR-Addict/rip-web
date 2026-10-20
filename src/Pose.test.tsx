import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Pose } from "./Pose";
import type { SensorSample } from "./types";

const sample = {
  motor_deg: 0,
  pendulum_raw: -60,
  pendulum_deg: -60,
  pendulum_down_deg: 120,
  pendulum_calibrated: false,
} as SensorSample;
const render = (value: SensorSample) =>
  renderToStaticMarkup(<Pose sample={value} />);
describe("装置示意", () => {
  it("摆杆传感器漂移不会改变画面", () => {
    expect(
      render({
        ...sample,
        pendulum_raw: 90,
        pendulum_deg: 130,
        pendulum_down_deg: -50,
      }),
    ).toBe(render(sample));
  });
  it("未标定时仍由底座角度驱动，连杆始终竖直", () => {
    const first = render(sample),
      rotated = render({ ...sample, motor_deg: 90 });
    expect(first).not.toBe(rotated);
    expect(rotated).toContain('data-angle="90.000"');
    expect(rotated).toContain('data-mode="fixed"');
    expect(rotated).toContain('x1="0" y1="0" x2="0" y2="119"');
    const chassis = (s: string) =>
      s
        .split('data-testid="pose-chassis"')[1]
        .split('data-testid="pose-base"')[0];
    expect(chassis(rotated)).toBe(chassis(first));
  });
});
