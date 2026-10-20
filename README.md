# 旋转倒立摆 Web 实验台

基于 React、TypeScript、Vite 和 Web Serial 的中文控制台。浏览器直接连接串口，串口通信和控制在 Dedicated Worker 中运行，无需 Python 后端。

支持手动点动、定时脉冲、正弦激励、实时传感器读数、曲线、实验回放，以及 CSV / JSON 导出。自动起摆与稳摆尚未实现，不属于当前应用功能。

## 启动

使用 Node.js 22.12+ 或 24+，建议使用 Node.js 24 LTS。使用支持 Web Serial 的桌面 Chrome。

```sh
npm install
npm run dev
```

打开 <http://127.0.0.1:5174/>。Web Serial 需要 localhost 或 HTTPS。

```sh
npm run build
npm run preview
```

## GitHub Pages

在线地址：<https://mr-addict.github.io/rip-web/>。

推送到 `main` 后，GitHub Actions 自动构建 `dist/` 并部署到 Pages；也可手动运行「Deploy GitHub Pages」。仓库 Pages 的发布源使用 GitHub Actions。部署构建命令：

```sh
npm run build:pages
```

该命令将静态资源和 Worker 路径设为 `/rip-web/`，本地开发路径保持不变。无需部署 Python 或 Node 服务，Pages 只托管静态文件。

在线页面可以通过 Web Serial 控制接在当前电脑上的装置：使用桌面 Chrome，点击「连接设备」并重新授权串口。localhost 的串口授权不会自动转移到线上域名。先断开本地页面或 Node 工具以释放串口；网页不会自动连接或开始动作。HTTPS 不代表远程控制，装置必须连接到打开网页的电脑。

## 使用

1. 连接 USB 和装置独立电源，点击「连接设备」，选择并授权串口，再建立连接。默认 115200 / 8N1；收到有效状态帧后显示已连接，连接时发送零 PWM。
2. 默认展开「手动点动」，默认幅值 20%，单次最长 5 秒。按住按钮或左右方向键转动，松开或窗口失焦停止。空格和顶部「停止输出」可随时停止。
3. 控制区一次只展开一项。「脉冲与正弦激励」提供脉冲（默认 25% / 100 ms）和正弦激励（默认 15% / 0.5 Hz / 5 秒），PWM 上限为 40%。
4. 顶部「归零」将底座当前位置设为相对 0°，不会驱动电机。运行和回放期间不可归零。
5. 底座示意随编码器角度旋转，连杆保持固定姿态。连杆传感器读数仍可查看和导出。曲线和传感器数据按需展开，暂停绘图不影响采集。
6. 每次动作自动记录。停止后可选中记录导出或回放；回放不会驱动装置。记录只保存在当前页面会话中，刷新前请导出。

遥测超过 100 ms 未更新、串口出错、页面隐藏或界面心跳丢失时，退出动作并尽可能发送零输出。软件停止不等同硬件急停；浏览器崩溃或物理断线后的行为取决于设备固件。

当前装置的连杆传感器在下垂附近存在盲区，静止时也可能漂移。界面固定连杆示意并不修复传感器。未更改或烧录设备固件；不同设备的协议、方向和量程需自行核对。

## 数据导出

CSV 保留全部收到的有效采样，包括原始与换算角度、原始与滤波角速度、ADC、序号、设备微秒计时、回绕展开时间、相对时间、目标与反馈 PWM、控制阶段。JSON 额外包含参数、事件和结束原因。

图表降采样不影响导出。记录达到 100 MiB 内存预算时停止动作，保留已有数据供导出。

## Node 调试工具

Node 和 Web 共用协议、控制器、记录、安全策略与导出逻辑。串口同一时刻只能由一个程序占用，使用 Node 前先断开网页。

```sh
npm run lab -- ports
npm run lab -- session --port /dev/cu.usbmodemXXXX
```

使用 `ports` 列出的实际串口路径。会话默认零输出，支持逐行命令：

```text
status
pulse {"pulseDuty":25,"pulseMs":100}
jog {"direction":1,"duration":0.2}
observe {"duration":10}
stop
quit
```

这些动作会控制真实设备。记录写入 `artifacts/node/`。Ctrl+C、标准输入关闭或 `quit` 会尝试发送零输出，`zeroConfirmed` 表示是否收到新的零 PWM 反馈。

`--config-file FILE` 可加载参数。可选 `calibrate-upright` 命令用于手扶直立且静止时标定；重启后需显式指定 `--calibration FILE`，工具会核对 USB 身份。

自动起摆研究代码和 `configs/catch-candidate.json` 仅为实验资料，不是可用的稳摆方案。Node 默认禁用自动起摆。以下历史数据回放不接触硬件，也不能预测改变输出后的实物运动：

```sh
npm run lab -- replay --file src/fixtures/near-upright.json --config '{"entryVelocity":650,"exitVelocity":900,"entryDwellMs":10}'
```

## 开发与验证

```sh
npm run build        # Web 类型检查与构建
npm run check:node   # Node 工具类型检查
npm test             # 协议、控制、记录、安全与 Node 适配器测试
npm run test:e2e     # Chrome 界面、键盘、故障、回放与导出测试
```

界面测试使用本机 Chrome。模拟模式和自动化测试不替代实机验收。实机已验证传感器读取、零输出与数据导出，以及有限脉冲动作；尚未实现稳定直立。

| 目录                              | 内容                                     |
| --------------------------------- | ---------------------------------------- |
| `src/`                            | 界面、Worker、串口协议、控制、记录与导出 |
| `src/fixtures/`                   | 用于回归测试的历史采样片段               |
| `tools/`                          | Node 串口会话与离线回放                  |
| `tests/`                          | Playwright 界面测试与模拟串口            |
| `configs/`                        | 未完成的起摆研究参数                     |
| `vendor/xinlu/firmware-audit.txt` | 厂商资料来源和协议差异说明               |

当前通信协议使用 `AA 55` 帧头、CRC8（多项式 `0x07`）、PWM 命令 `0x01` 和 40 字节状态帧 `0x81`。解析器支持拆包、粘包、坏帧恢复和设备计时回绕。厂商原始固件与当前 USB 固件的接口不同，不能直接替换。

串口无法打开时，关闭其他串口监视器或 Node 会话；macOS 可用 `lsof /dev/cu.usbmodemXXXX` 检查占用。USB 枚举成功并不意味着传感器已供电，请确认独立电源开启。

本机日志、下载的厂商压缩包和源码、构建产物与依赖目录均不纳入版本控制。
