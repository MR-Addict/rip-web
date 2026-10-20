import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import { installStationarySerial } from "./fake-serial";
const recordButton = "开始正弦激励";
async function simulate(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "连接设备", exact: true }).click();
  await page.getByRole("button", { name: "启动模拟装置" }).click();
  await expect(page.getByText("模拟装置在线", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "按住右转" })).toBeEnabled();
}
async function more(page: Page, action: string) {
  await page.getByText("脉冲与正弦激励", { exact: true }).click();
  await page.getByLabel("动作", { exact: true }).selectOption(action);
}
async function raw(page: Page) {
  await page.getByText("传感器数据", { exact: true }).click();
}
async function exported(page: Page, format: "csv" | "json") {
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: format === "csv" ? "导出 CSV" : "JSON",
      exact: true,
    })
    .click();
  return fs.readFile((await (await pending).path())!, "utf8");
}

test("manual default has no automatic swing controls, optional data stays folded, fits phone", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "按住左转" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "起摆", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("采集 10 秒", { exact: true })).toHaveCount(0);
  await expect(page.getByText("零位设置", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "归零", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("内环 Kp")).toHaveCount(0);
  await expect(page.getByLabel("曲线类型")).not.toBeVisible();
  for (const width of [1440, 800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.body.scrollWidth)).toBe(width);
  }
  expect(errors).toEqual([]);
});

test("pulse export retains all sensor samples and replay never energizes keyboard jog", async ({
  page,
}) => {
  await simulate(page);
  await more(page, "pulse");
  await page.getByLabel("脉冲宽度").fill("250");
  await page.getByRole("button", { name: "发送脉冲" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  const csv = await exported(page, "csv"),
    lines = csv.trim().split("\r\n");
  expect(lines.length).toBeGreaterThan(20);
  expect(lines[0]).toContain("adc_raw");
  const data = JSON.parse(await exported(page, "json"));
  expect(data.simulation).toBe(true);
  expect(data.samples.length).toBe(lines.length - 1);
  expect(data.config.pulseMs).toBe(250);
  expect(
    data.samples.some((s: { target_duty: number }) => s.target_duty === 25),
  ).toBe(true);
  await page.getByRole("button", { name: "回放", exact: true }).click();
  await expect(
    page.getByText("历史回放 · 模拟数据", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "按住右转", includeHidden: true }),
  ).toBeDisabled();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "返回实时" }).click();
});

test("optional charts pause while acquisition and sine output continue", async ({
  page,
}) => {
  await simulate(page);
  await more(page, "sine");
  await page.getByLabel("持续时间").fill("1");
  await page.getByText("查看曲线", { exact: true }).click();
  await page.getByRole("button", { name: "开始正弦激励" }).click();
  await page.getByRole("button", { name: "暂停绘图" }).click();
  await expect(page.getByText("绘图已暂停", { exact: true })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  const data = JSON.parse(await exported(page, "json"));
  expect(data.samples.length).toBeGreaterThan(200);
  expect(data.duration).toBeGreaterThanOrEqual(1);
  for (const kind of ["velocity", "pwm", "phase", "angle"])
    await page.getByLabel("曲线类型").selectOption(kind);
});
for (const fault of ["遥测停滞", "写入失败", "模拟拔线"])
  test(`${fault} stops and retains manual records`, async ({ page }) => {
    await simulate(page);
    await more(page, "sine");
    await raw(page);
    await page.getByRole("button", { name: recordButton }).click();
    await expect(page.getByText("正在记录", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: fault, exact: true }).click();
    await expect(page.getByText("通信故障", { exact: true })).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "按住右转", includeHidden: true }),
    ).toBeDisabled();
    await expect(page.locator("tbody tr")).toContainText(
      fault === "遥测停滞"
        ? "100 ms"
        : fault === "写入失败"
          ? "写入失败"
          : "拔出",
    );
  });
test("hidden page and missing UI heartbeat stop acquisition in worker", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Base = window.Worker;
    window.Worker = class extends Base {
      postMessage(message: unknown, options?: StructuredSerializeOptions) {
        if (
          (window as unknown as { dropHeartbeat: boolean }).dropHeartbeat &&
          (message as { type: string }).type === "heartbeat"
        )
          return;
        super.postMessage(message, options);
      }
    };
  });
  await simulate(page);
  await more(page, "sine");
  await page.getByRole("button", { name: recordButton }).click();
  await expect(page.getByText("正在记录", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { dropHeartbeat: boolean }).dropHeartbeat = true;
  });
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("心跳超时");
  await page.evaluate(() => {
    (window as unknown as { dropHeartbeat: boolean }).dropHeartbeat = false;
  });
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: recordButton }).click();
  await expect(page.getByText("正在记录", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.locator("tbody tr").first()).toContainText("页面不可见");
});
test("main jog release, blur and space stop; repeated commands remain exclusive", async ({
  page,
}) => {
  await simulate(page);
  const jog = page.getByRole("button", { name: "按住右转" });
  await jog.hover();
  await page.mouse.down();
  await expect(page.getByText("正在记录", { exact: true })).toBeVisible();
  await page.mouse.up();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.keyboard.down("ArrowLeft");
  await expect(page.getByText("正在记录", { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.keyboard.up("ArrowLeft");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await more(page, "sine");
  const collect = page.getByRole("button", { name: recordButton });
  await collect.evaluate((el) => {
    (el as HTMLButtonElement).click();
    (el as HTMLButtonElement).click();
  });
  await expect(page.getByText("正在记录", { exact: true })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await expect(page.locator("tbody tr").first()).toContainText("空格键停止");
});
test("manual console preview has no explanatory captions", async ({ page }) => {
  await simulate(page);
  await expect(page.locator(".hint,.pose-caption,.app-footer")).toHaveCount(0);
  await expect(page.getByText("编码器实时联动", { exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: "artifacts/manual-console-preview.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await page.screenshot({
    path: "artifacts/manual-console-mobile.png",
    fullPage: true,
  });
});
test("real serial mode permits manual control without pendulum calibration", async ({
  page,
}) => {
  await installStationarySerial(page);
  await page.goto("/");
  await page.getByRole("button", { name: "连接设备", exact: true }).click();
  await page.getByRole("button", { name: "建立连接", exact: true }).click();
  const jog = page.getByRole("button", { name: "按住右转" });
  await expect(jog).toBeEnabled();
  await page.getByRole("button", { name: "归零", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("底座角度已归零");
  await jog.hover();
  await page.mouse.down();
  await expect(page.getByText("正在记录", { exact: true })).toBeVisible();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  const d = JSON.parse(await exported(page, "json"));
  expect(d.simulation).toBe(false);
  expect(d.pendulumCalibrated).toBe(false);
  expect(
    d.samples.some((s: { target_duty: number }) => s.target_duty === 20),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "起摆", exact: true }),
  ).toHaveCount(0);
});

test("control sections open one at a time and preserve edited parameters", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".control-area details[open]")).toHaveCount(1);
  await expect(page.getByLabel("点动幅值")).toBeVisible();
  await expect(page.getByLabel("点动幅值")).toHaveValue("20");
  await page.getByLabel("点动幅值").fill("18");
  await page.getByText("脉冲与正弦激励", { exact: true }).click();
  await expect(page.getByLabel("点动幅值")).not.toBeVisible();
  await expect(page.getByLabel("脉冲宽度")).toBeVisible();
  await page.getByText("手动点动", { exact: true }).click();
  await expect(page.getByLabel("脉冲宽度")).not.toBeVisible();
  await expect(page.getByLabel("点动幅值")).toHaveValue("18");
  await expect(page.locator(".control-area details[open]")).toHaveCount(1);
  await page.screenshot({
    path: "artifacts/control-accordion.png",
    fullPage: true,
  });
});
