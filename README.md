# RhineOS — 莱茵生命 · 图形化 WSL 桌面

以 [LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)(MIT)为像素级视觉基线,重构耦合成的 **WSL 定制图形化操作系统**:开机验证序列 → 三维档案终端 → 桌面环境,终端/文件/监控等应用全部经后端与真实 WSL 耦合。

![架构](https://img.shields.io/badge/WSL2-WSLg%20%E5%8F%AF%E7%94%A8-ed821b) ![基线](https://img.shields.io/badge/%E8%A7%86%E8%A7%89%E5%9F%BA%E7%BA%BF-RhineLabUI%20(MIT)-9b7247)

## 原生桌面形态(默认,开机即桌面)

RhineOS 以 **Electron kiosk 全屏窗口**经 WSLg 合成直接出现在 Windows 桌面上——无地址栏、无浏览器框,Express/ws/node-pty 后端**融入 Electron 主进程**,不再有独立 server 进程。WSL 启动(开机自启或手动打开 WSL 终端)后 systemd 用户服务自动拉起桌面。

- **进入系统**:窗口出现后点击门禁「点击进入 →」(或「关闭声音并进入」),开机序列播放后点 `ENTER SYSTEM ↗` / `进入档案` 进入桌面(WSLg 会向 Chromium 暴露触摸设备,页面可能呈现移动端两段式入口,均会正常进入)。
- **自启链路**:Windows 启动项 `rhineos.cmd`(`wsl.exe -d Ubuntu --exec true`)→ systemd 用户服务 `rhineos.service` → Electron kiosk。
- **服务管理**:`systemctl --user status|restart|stop rhineos`;日志 `journalctl --user -u rhineos -f`。
- **运行配方(缺一不可,均为实测结论,详见 `web/electron/main.cjs` 头注)**:
  - `ELECTRON_DISABLE_SANDBOX=1` 环境变量 + 命令行 `--no-sandbox`:Chromium 沙箱在 WSL2 内核上经 userns 命名空间路径全盘 ESRCH(网络服务/渲染进程自杀,exit 133);主进程 `appendSwitch` 传不到 ZygoteHost,必须进程级禁用。
  - `--force-device-scale-factor=2`:WSLg 输出逻辑分辨率(200% 缩放屏仅 1536×960),2x 渲染保证文字位图密度(需 Windows 缩放非 100% 时)。
  - `--autoplay-policy=no-user-gesture-required`:门禁的音频解锁可被程序化点击通过。
  - Electron 钉在 **33.x**:44.x(Chromium 134)同配方下桌面壳不挂载。
- **浏览器后备形态**:`./rhineos.sh` 仍可用(独立 Node 服务 :4876 + Windows 浏览器 `--app` 窗口),核心逻辑与桌面形态共用 `server/backend.mjs`。

## 快速开始(浏览器后备形态)

```bash
cd ~/rhineos
./rhineos.sh              # 首次运行自动装依赖、构建,并以应用窗口打开桌面
./rhineos.sh --build      # 强制重新构建前端
./rhineos.sh --no-browser # 只启动服务,不拉起浏览器
./rhineos.sh --port 5000  # 自定义端口(默认 4876)
```

- **进入系统**:页面加载后点击「点击进入 →」(无声进入可选),播放原版开机验证序列,点击 `ENTER SYSTEM ↗` 或按 Enter 进入桌面。
- **返回桌面**:档案终端内点击右下角 `⌂ DESKTOP`。
- **重启/关机**:Dock → 电源(重启 = 重播开机序列;关机 = 停止后端服务)。
- 服务日志:`/tmp/rhineos-server.log`;停止:`pkill -f 'node server/index.mjs'`。

## 系统组成

```
rhineos/
├── rhineos.sh          # 浏览器后备形态一键启动(依赖安装 → 构建 → 服务 → 应用窗口)
├── server/
│   ├── backend.mjs     # 后端核心(静态托管 + 全部 WSL 耦合 API),两形态共用
│   └── index.mjs       # 独立服务入口(浏览器后备,端口 4876)
├── web/
│   ├── electron/
│   │   └── main.cjs    # Electron 主进程:内嵌后端(:4877)+ kiosk 桌面窗口 + 自检截图
│   └── ...             # 前端(RhineLabUI 源码 + src/os/ 桌面层)
│       └── src/os/
│           ├── desktop.ts  # 桌面壳:壁纸组件/顶栏/Dock/应用调度/开机分流
│           ├── wm.ts       # 窗口管理器(拖拽/缩放/聚焦/最小化/最大化,含开合缓动)
│           ├── apps.ts     # 应用:终端/文件/监控/WSLg 启动器/设置/关于/电源
│           ├── api.ts      # 后端客户端(REST + 轮询指标)
│           └── desktop.css # OS 层样式(完全沿用莱茵设计令牌)
└── ~/.config/systemd/user/rhineos.service   # systemd 用户服务(开机自启)
```

### 与 WSL 的耦合点(全部真实数据)

| 应用 | 耦合方式 |
|---|---|
| **档案终端** | 原版 RhineLabUI 三维阵列(Three.js),像素级保留 |
| **终端** | node-pty 真实 bash(xterm-256color),WebSocket 全双工 |
| **文件** | 后端 fs API:浏览/预览/编辑/写回/新建/重命名/删除 |
| **监控** | /proc 采集:CPU(含每核)/内存/Swap/网络速率/磁盘/进程表,2s 刷新 |
| **应用** | 解析 `/usr/share/applications`,经 WSLg 拉起真实 Linux GUI 应用 |
| **设置/关于/电源** | 主题(亮/暗)与主应用共享 `rhine-settings`;主机信息;电源序列 |

### 设计体系(像素级沿用)

暖灰纸面 `#eae5e1` · 墨色 `#080a08` · 琥珀信号 `#ed821b` · 细线分隔 `#aaa59a` · MiSans 字阶(300/400/600/700)· 滚动数字时钟(`@kitlangton/rolling-number`)· 亮暗双主题(`--theme-*` 变量全局联动)。

## 环境要求

- WSL2(Ubuntu 22.04+/24.04)+ WSLg(可选,仅「应用」启动器需要)
- Windows 侧 Edge 或 Chrome(启动脚本自动检测并以 `--app` 模式打开)
- Linux 原生 Node.js 20+(脚本自动使用 `~/.local/lib/nodejs/node22`;node-pty 需要原生编译,Windows 版 node 不可用)

## 已知边界

- 档案终端的 3D 场景依赖 WebGL;Electron/WSLg 环境无可用 GPU(/dev/dri 缺失),由 SwiftShader 软渲染承担,重动画场景帧率受限。
- WSLg 对 X11 应用按 Windows **逻辑分辨率**输出且不提供 DPI 缩放(平台级限制):200% 缩放屏上位图会被放大,文字达不到浏览器原生锐度;将 Windows 显示缩放设为 100% 可获得 1:1 像素(桌面形态已用 `--force-device-scale-factor=2` 保持界面大小不变)。
- 「应用」启动器列出的 GUI 程序窗口出现在 Windows 桌面(WSLg 机制),由系统拉起、系统接管。
- 后端仅监听本机回环(桌面形态 127.0.0.1:4877 / 后备形态 0.0.0.0:4876 仅 WSL NAT 内可达),不对局域网暴露;文件 API 以当前 WSL 用户权限运行。

## 许可

- 本项目的视觉与交互基线 [RhineLabUI](https://github.com/LBEILC/RhineLabUI) 采用 **MIT License**(© 2026 LBEILC),档案文本为基于公开世界观的原创编目文章。
- 《明日方舟》及莱茵生命版权归鹰角网络所有;本项目为非官方粉丝作品,与官方无关。
