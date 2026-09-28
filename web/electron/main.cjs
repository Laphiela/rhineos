// RhineOS Electron 主进程 — 后端融入 + kiosk 原生桌面窗口
// server/backend.mjs 在本进程内启动,独立 server 进程消失;
// 经 WSLg 合成后,Windows 桌面上呈现的就是一个原生 Linux GUI 窗口(无浏览器框)。
// 自检模式:RHINEOS_SHOT=<png路径> 时,桌面渲染完成后 capturePage 存图并退出。
const { app, BrowserWindow } = require("electron");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const fs = require("node:fs");

const PORT = Number(process.env.RHINEOS_PORT ?? 4877);
const BACKEND_MJS = pathToFileURL(path.join(__dirname, "..", "..", "server", "backend.mjs")).href;
const DIST = path.join(__dirname, "..", "dist");
const SHOT = process.env.RHINEOS_SHOT || "";
// 自检实例:独立 userData(全新 localStorage → 种子生效 → 无门禁零点击),
// 不读不写生产实例的用户偏好(如用户在设置里开过声音)。
if (SHOT) app.setPath("userData", require("node:os").tmpdir() + "/rhineos-selftest-profile");

// WSLg 环境运行配方(缺一不可,均已实测):
//  1. ELECTRON_DISABLE_SANDBOX=1 环境变量 + 命令行 --no-sandbox(见 systemd 单元)——
//     主进程 appendSwitch 的 no-sandbox 传不到 Chromium 最早的沙箱初始化层(ZygoteHost/
//     namespace sandbox),Chromium 会照常创建 userns+pidns 命名空间,其内部 procfs
//     语义在 WSL2 内核上全部返回 ESRCH → 网络服务/渲染进程自杀(exit 133)。
//  2. 禁用硬件加速:统一 SwiftShader 软渲染,与浏览器版已验证的渲染路径一致。
//  3. --disable-dev-shm-usage:WSLg 下 /dev/shm 的 access() 返回 ESRCH,共享内存移至 /tmp。
//  4. --enable-unsafe-swiftshader(命令行):Chromium 130 起软件 WebGL 需显式开启,档案终端 3D 依赖。
//  5. Electron 钉在 33.x:44.x(Chromium 134)在同样配方下页面加载但桌面壳不挂载,33.x 全通。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-dev-shm-usage");
app.commandLine.appendSwitch("disable-gpu");
// 清晰度:WSLg 的 weston 输出是 Windows 逻辑分辨率(200% 屏仅 1536×960),
// 必须让 Chromium 以 2x 渲染出 3072×1920 原生位图。force-device-scale-factor 和
// no-sandbox 一样,appendSwitch 传不到 Chromium 早期显示层,必须放在真实命令行上
// (见 systemd 单元 ExecStart):electron --no-sandbox --force-device-scale-factor=2 …

let win = null;
let backendPort = 0;

// SwiftShader 软渲染性能档:每次页面加载后注入。
// 1) 首次运行预置 rhine-settings:SUPER PERFORMANCE 开 + 静音(免门禁,开机零点击直达桌面;
//    用户之后在「设置」里的修改照常持久化,不会被再次覆盖);
// 2) 关闭毛玻璃 backdrop-filter 与大阴影 —— 软渲染下这是最大的掉帧源。
const SW_PROFILE_JS = `(() => {
  let seeded = false;
  try {
    const before = localStorage.getItem("rhine-settings");
    console.log("[sw-profile] before:", before ? "present" : "absent");
    if (!before) {
      localStorage.setItem("rhine-settings", JSON.stringify({ superPerformance: true, sound: false, music: false }));
      seeded = true;
    }
  } catch {}
  window.addEventListener("error", e => console.error("[err]", e.error?.stack || e.message));
  window.addEventListener("unhandledrejection", e => console.error("[rej]", e.reason?.stack || String(e.reason)));
  if (!document.getElementById("rhine-sw-style")) {
    const st = document.createElement("style");
    st.id = "rhine-sw-style";
    st.textContent = [
      ".os-topbar, .os-dock { backdrop-filter: none !important; }",
      ".os-topbar, .os-dock { background: rgba(var(--os-paper-rgb), .97) !important; }",
      ".os-window { box-shadow: 0 6px 22px rgba(99, 81, 58, .16) !important; }",
      ".os-window.focused { box-shadow: 0 10px 30px rgba(99, 81, 58, .22) !important; }"
    ].join("\\n");
    document.documentElement.appendChild(st);
  }
  return seeded;
})()`;

async function startBackend() {
  const mod = await import(BACKEND_MJS);
  // 端口避让:4877 起连试 5 个,防旧实例占用
  const candidates = [PORT, PORT + 1, PORT + 2, PORT + 3, PORT + 4];
  let lastErr;
  for (const p of candidates) {
    try {
      const backend = await mod.startRhineosBackend({ port: p, host: "127.0.0.1", distDir: DIST });
      backendPort = p;
      return backend;
    } catch (e) {
      if (e?.code !== "EADDRINUSE") throw e;
      lastErr = e;
      console.warn(`[rhineos] 端口 ${p} 被占用,尝试下一个…`);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- 截图自检
const withTimeout = (promise, ms, tag) => Promise.race([
  promise,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${tag} 超时 ${ms}ms`)), ms)),
]);

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    kiosk: true,
    autoHideMenuBar: true,
    title: "RhineOS",
    backgroundColor: "#000000",
    webPreferences: { contextIsolation: true },
  });
  win.loadURL(`http://127.0.0.1:${backendPort}`);
  if (SHOT) { try { win.focus(); win.moveTop(); } catch {} }
  // 软渲染性能档注入 + 首次种子后重载一次使偏好立即生效
  win.webContents.on("did-finish-load", () => {
    win.webContents.executeJavaScript(SW_PROFILE_JS)
      .then(seeded => { if (seeded === true) setTimeout(() => { try { win?.webContents.reload(); } catch {} }, 60); })
      .catch(() => {});
  });
  if (SHOT) {
    win.webContents.on("console-message", (_e, _l, message) => console.log("[renderer]", String(message).slice(0, 400)));
  }
  win.on("closed", () => { win = null; });
}

// 驱动到桌面:入口链 = StartupGate 门禁(.entry-start,点击后做音频解锁,须配合
// --autoplay-policy=no-user-gesture-required 才能被合成点击通过)→ #skip / .mobile-entry
// (WSLg 暴露触摸设备时页面走移动端两段式)。统一轮询:可见且可用的入口就点,
// 节流防重放,以 #stage[data-mode="desktop"] 为权威就绪标记。
async function driveToDesktop(timeoutMs = 180000) {
  let lastClickAt = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let state = null;
    try {
      state = await withTimeout(
        win.webContents.executeJavaScript(
          `(() => {
            const stage = document.getElementById("stage");
            const skip = document.getElementById("skip");
            const entry = document.querySelector(".mobile-entry");
            const gateBtn = document.querySelector(".entry-start");
            const gateSilentEl = document.querySelector(".entry-silent");
            const shown = el => el && el.getClientRects().length > 0 && !el.inert && !el.disabled;
            return {
              mode: stage?.dataset.mode || "",
              gateUp: !!document.getElementById("loading"),
              gateStart: shown(gateBtn) && gateBtn.getAttribute("aria-disabled") !== "true",
              gateSilent: gateSilentEl && !gateSilentEl.hidden && gateSilentEl.getClientRects().length > 0,
              skipBtn: shown(skip),
              mobileEntry: shown(entry),
            };
          })()`,
          false,
        ),
        5000,
        "executeJavaScript",
      );
    } catch { /* 渲染进程未就绪,继续等 */ }
    // archive 即桌面(档案终端落点形态),两种 mode 都算就绪
    if (state?.mode === "desktop" || state?.mode === "archive") return state;
    if (state && Date.now() - lastClickAt > 2500) {
      // 优先级:门禁在场只碰门禁(无声入口优先),门禁退场后才允许点跳过按钮
      const target = state.gateSilent ? ".entry-silent"
        : state.gateStart ? ".entry-start"
        : !state.gateUp && state.skipBtn ? "#skip"
        : !state.gateUp && state.mobileEntry ? ".mobile-entry" : null;
      if (target) {
        lastClickAt = Date.now();
        await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(target)})?.click(); "ok"`).catch(() => {});
      }
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return null;
}

async function selfTest() {
  // 总看门狗:无论如何 5 分钟后退出,绝不允许测试实例挂死
  const watchdog = setTimeout(() => { console.error("[rhineos] 自检总超时,强制退出"); app.exit(1); }, 300000);
  const state = await driveToDesktop();
  // 桌面挂载后再留 4s 让入场动画/首帧指标落位
  await new Promise(r => setTimeout(r, 4000));
  // 扩展自检:RHINEOS_SHOT_ARCHIVE=1 时驱动进入三维档案终端并截图(验证 3D + 文件系统耦合)
  if (process.env.RHINEOS_SHOT_ARCHIVE) {
    try {
      await withTimeout(win.webContents.executeJavaScript(
        `document.querySelector('.os-dock-btn[data-app="archives"]')?.click(); "ok"`, false), 5000, "click archives");
      const deadline = Date.now() + 60000;
      let inArchive = false;
      while (Date.now() < deadline) {
        const st = await withTimeout(win.webContents.executeJavaScript(
          `document.getElementById("stage")?.dataset.mode || ""`, false), 5000, "mode probe").catch(() => null);
        if (st === "archive" || st === "detail") { inArchive = true; break; }
        await new Promise(r => setTimeout(r, 1500));
      }
      // 3D 场景 SwiftShader 首次着色器编译可能冻结 10-20s,多等一会再截
      await new Promise(r => setTimeout(r, 12000));
      const probe = await withTimeout(win.webContents.executeJavaScript(
        `(() => ({ canvas: !!document.querySelector(".three-scene canvas"), title: document.querySelector("#selected-title")?.textContent || "" }))()`,
        false), 8000, "archive probe").catch(() => null);
      console.log(`[rhineos] 档案终端: mode=${inArchive ? "archive" : "未进入"} canvas=${probe?.canvas} selected=${probe?.title}`);
      fs.writeFileSync(SHOT.replace(/\.png$/, "-archive.png"), (await withTimeout(win.webContents.capturePage(), 15000, "capturePage")).toPNG());
    } catch (e) { console.error("[rhineos] 档案终端自检失败:", e.message); }
  }
  try {
    const img = await withTimeout(win.webContents.capturePage(), 15000, "capturePage");
    fs.writeFileSync(SHOT, img.toPNG());
    console.log(`[rhineos] 自检截图已保存: ${SHOT} · 桌面就绪: ${state ? `是 (mode=desktop)` : "超时(仍截图供诊断)"}`);
    if (!state) process.exitCode = 1;
  } catch (e) {
    console.error("[rhineos] 截图失败:", e);
    process.exitCode = 1;
  }
  clearTimeout(watchdog);
  app.exit(process.exitCode ?? 0);
}

// ---------------------------------------------------------------- 生命周期
const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !SHOT) {
  console.log("[rhineos] 已有实例在运行,退出。");
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    try {
      await startBackend();
    } catch (e) {
      console.error("[rhineos] 后端启动失败:", e);
      app.exit(1);
      return;
    }
    createWindow();
    if (SHOT) selfTest();
  });
}

app.on("window-all-closed", () => app.quit());
