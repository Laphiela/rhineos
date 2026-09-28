// RhineOS 桌面壳 — 像素级沿用莱茵生命设计体系(暖灰纸面 / 细线 / MiSans / 琥珀信号色)
// 由 main.ts 在启动完成后切入;终端 / 文件 / 监控 / WSLg 启动器经后端与 WSL 耦合。
import "./desktop.css";
import { api, watchMetrics, formatUptime, type HostInfo, type Metrics } from "./api";
import { WindowManager } from "./wm";
import {
  mountTerminal, mountFiles, mountMonitor, mountLaunchpad, mountSettings, mountAbout, mountPower,
  type OSCallbacks,
} from "./apps";
import { createRollingClock } from "../rolling-clock";
import { brandHeading } from "../brand";
import { escapeHtml } from "../html";

export type DesktopCallbacks = OSCallbacks & {
  enterArchives: () => void; // 切入原版三维档案终端(setMode("archive"))
};
let hostInfo: HostInfo | null = null;
let backendUp = false;
export const osEnabled = () => backendUp;

/** 启动期探测:后端可达则启用桌面模式,否则保持原版档案终端体验。
 * 探测与页面资源下载共用连接池,可能被挤压超时——在启动窗口内持续重试。 */
export async function probeOS(): Promise<boolean> {
  const forced = new URLSearchParams(location.search);
  if (forced.get("os") === "0") return false;
  // 场景加载期间主线程可能被着色器编译长时间冻结,墙钟预算不可靠;
  // 以尝试次数为预算:后端在运行时解冻后数秒内必然成功,宕机时约 40 秒放弃。
  (window as unknown as { __rhineProbe?: unknown }).__rhineProbe = { tries: 0, lastError: null, done: false, ok: false };
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      hostInfo = await Promise.race([
        api.host(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
      ]);
      backendUp = true;
      const probe = (window as unknown as { __rhineProbe: { done: boolean; ok: boolean } }).__rhineProbe;
      if (probe) { probe.done = true; probe.ok = true; }
      return true;
    } catch (error) {
      const probe = (window as unknown as { __rhineProbe?: { tries: number; lastError: string | null; done: boolean } }).__rhineProbe;
      if (probe) {
        probe.tries = attempt + 1;
        probe.lastError = String((error as Error)?.message || error).slice(0, 200);
      }
      await new Promise(r => setTimeout(r, 800));
    }
  }
  backendUp = false;
  const probe = (window as unknown as { __rhineProbe?: { done: boolean } }).__rhineProbe;
  if (probe) probe.done = true;
  return false;
}

let callbacks: DesktopCallbacks;
let wm: WindowManager;
let root: HTMLElement;
let stopMetrics: (() => void) | null = null;
let metrics: Metrics | null = null;

/** 在 #stage 内挂载桌面(幂等),由 main.ts 在首次进入桌面模式前调用。 */
export function mountOS(stage: HTMLElement, cbs: DesktopCallbacks) {
  if (root) return;
  callbacks = cbs;
  root = document.createElement("div");
  root.id = "os-root";
  root.className = "os-root";
  root.hidden = true;
  stage.append(root);
  // 原版页脚加入「返回桌面」入口(仅 OS 模式可见)
  stage.querySelector(".system-footer")?.insertAdjacentHTML(
    "beforeend",
    '<button data-action="desktop" title="返回桌面">⌂ DESKTOP</button>',
  );
  // 先构建桌面壳(buildShell 会写 root.innerHTML),再创建窗口层,
  // 否则 WindowManager 的 .os-windows 会被 innerHTML 覆盖清除。
  buildShell();
  wm = new WindowManager(root, ids => syncDockActive(ids));
}

function buildShell() {
  const host = hostInfo;
  root.innerHTML = `
    <div class="os-atmosphere" aria-hidden="true">
      <div class="os-grid"></div><div class="os-corner tl"></div><div class="os-corner tr"></div><div class="os-corner bl"></div><div class="os-corner br"></div>
      <div class="os-ring"></div>
    </div>
    <header class="os-topbar">
      <div class="os-brand">${brandHeading}</div>
      <div class="os-hostinfo">
        <span class="os-host"><b>${host ? escapeHtml(`${host.user}@${host.hostname}`) : "WSL"}</b></span>
        <span class="os-distro">${host ? escapeHtml(`${host.distro} · ${host.wsl}`) : ""}</span>
      </div>
      <div class="os-topmetrics" aria-label="系统指标">
        <span class="os-metric">CPU <b class="os-cpu-top">--</b></span>
        <span class="os-metric">MEM <b class="os-mem-top">--</b></span>
        <span class="os-metric os-uptime">UPTIME <b class="os-uptime-top">--</b></span>
      </div>
    </header>
    <section class="os-wallpaper">
      <div class="os-clock-panel">
        <div class="os-kicker">RHINE LAB <i>／</i> INTERNAL TERMINAL</div>
        <div class="os-clock" aria-label="时间"></div>
        <div class="os-date"><span class="os-date-text"></span><span class="os-week"></span></div>
        <div class="os-host-line">SESSION AUTHORIZED <i class="os-status-light"></i> <span class="os-hostline-text"></span></div>
      </div>
      <aside class="os-status-panel">
        <div class="os-kicker">SYSTEM <i>／</i> <span class="os-panel-title">系统资源</span></div>
        <div class="os-status-rows">
          <div class="os-status-row"><span>CPU</span><div class="os-bar"><i class="os-cpu-bar"></i></div><b class="os-cpu-num">--%</b></div>
          <div class="os-status-row"><span>MEM</span><div class="os-bar"><i class="os-mem-bar"></i></div><b class="os-mem-num">--%</b></div>
          <div class="os-status-row"><span>DISK</span><div class="os-bar"><i class="os-disk-bar"></i></div><b class="os-disk-num">--%</b></div>
        </div>
        <div class="os-status-note">内存 <span class="os-mem-detail">--</span><br>运行 <span class="os-uptime-detail">--</span></div>
      </aside>
    </section>
    <nav class="os-dock" aria-label="应用坞">
      <button class="os-dock-btn" data-app="archives"><span class="os-dock-glyph">⌸</span><small>档案终端</small></button>
      <button class="os-dock-btn" data-app="terminal"><span class="os-dock-glyph">⌁</span><small>终端</small></button>
      <button class="os-dock-btn" data-app="files"><span class="os-dock-glyph">▤</span><small>文件</small></button>
      <button class="os-dock-btn" data-app="monitor"><span class="os-dock-glyph">∿</span><small>监控</small></button>
      <button class="os-dock-btn" data-app="launchpad"><span class="os-dock-glyph">⋯</span><small>应用</small></button>
      <span class="os-dock-rule" aria-hidden="true"></span>
      <button class="os-dock-btn" data-app="settings"><span class="os-dock-glyph">◷</span><small>设置</small></button>
      <button class="os-dock-btn" data-app="about"><span class="os-dock-glyph">⌗</span><small>关于</small></button>
      <button class="os-dock-btn power" data-app="power"><span class="os-dock-glyph">⏻</span><small>电源</small></button>
    </nav>
    <div class="os-toast" role="status" hidden></div>
  `;

  // 滚动时钟(与原版数字组件同源)
  const clockEl = root.querySelector<HTMLElement>(".os-clock")!;
  const updateClock = createRollingClock(clockEl);
  const tickDate = () => {
    const now = new Date();
    updateClock(now, true);
    root.querySelector<HTMLElement>(".os-date-text")!.textContent =
      now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
    root.querySelector<HTMLElement>(".os-week")!.textContent =
      now.toLocaleDateString("zh-CN", { weekday: "long" }).toUpperCase();
  };
  tickDate();
  setInterval(tickDate, 1000);

  root.querySelector(".os-hostline-text")!.textContent =
    host ? `${host.user}@${host.hostname} — ${host.distro}` : "WSL";

  // 应用坞
  root.querySelector(".os-dock")!.addEventListener("click", e => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-app]");
    if (!btn) return;
    openApp(btn.dataset.app!);
  });

  // 桌面快捷键:Space 启动器、T 终端、/ 检索;捕获阶段先于主应用处理
  document.addEventListener("keydown", osKeydown, { capture: true });

  stopMetrics = watchMetrics(m => {
    metrics = m;
    const cpu = m.cpu.percent, mem = (m.mem.used / Math.max(1, m.mem.total)) * 100;
    const disk = (m.disk.used / Math.max(1, m.disk.total)) * 100;
    root.querySelector<HTMLElement>(".os-cpu-top")!.textContent = `${cpu.toFixed(0)}%`;
    root.querySelector<HTMLElement>(".os-mem-top")!.textContent = `${mem.toFixed(0)}%`;
    root.querySelector<HTMLElement>(".os-uptime-top")!.textContent = formatUptime(m.uptime);
    root.querySelector<HTMLElement>(".os-cpu-bar")!.style.width = `${cpu}%`;
    root.querySelector<HTMLElement>(".os-mem-bar")!.style.width = `${mem}%`;
    root.querySelector<HTMLElement>(".os-disk-bar")!.style.width = `${disk}%`;
    root.querySelector<HTMLElement>(".os-cpu-num")!.textContent = `${cpu.toFixed(0)}%`;
    root.querySelector<HTMLElement>(".os-mem-num")!.textContent = `${mem.toFixed(0)}%`;
    root.querySelector<HTMLElement>(".os-disk-num")!.textContent = `${disk.toFixed(0)}%`;
    root.querySelector<HTMLElement>(".os-mem-detail")!.textContent =
      `${(m.mem.used / 1024 ** 3).toFixed(1)} / ${(m.mem.total / 1024 ** 3).toFixed(1)} GB`;
    root.querySelector<HTMLElement>(".os-uptime-detail")!.textContent = formatUptime(m.uptime);
  });
}

function osKeydown(e: KeyboardEvent) {
  if (root.hidden || !backendUp) return;
  const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (e.key === "Escape" && wm.active) {
    // 关闭聚焦窗口优先于主应用行为(主应用 Escape 在桌面模式无语义)
    if (!inField) { e.stopPropagation(); }
    return;
  }
  if (inField) return;
  if (e.key.toLowerCase() === "t" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault(); e.stopPropagation();
    openApp("terminal");
  }
}

export function openApp(id: string) {
  console.info("[os] openApp:", id, "backend:", backendUp, "wm:", Boolean(wm));
  if (!backendUp && id !== "archives") return;
  switch (id) {
    case "archives": callbacks.enterArchives(); return;
    case "terminal": mountTerminal(wm, callbacks); return;
    case "files": mountFiles(wm, callbacks, hostInfo?.home); return;
    case "monitor": mountMonitor(wm); return;
    case "launchpad": void mountLaunchpad(wm); return;
    case "settings": mountSettings(wm, callbacks); return;
    case "about": mountAbout(wm); return;
    case "power": mountPower(wm, callbacks); return;
  }
}

function syncDockActive(openIds: string[]) {
  for (const btn of root.querySelectorAll<HTMLElement>("[data-app]")) {
    btn.classList.toggle("running", openIds.includes(btn.dataset.app!));
  }
}

/** 桌面模式的进入/离开(main.ts setMode 调用)。 */
export function setDesktopVisible(visible: boolean) {
  if (!root) return;
  root.hidden = !visible;
  root.classList.toggle("active", visible);
  if (visible) syncDockActive(wm.openIds);
}

/** 顶部 Toast 提示(莱茵细线风格)。 */
export function osToast(message: string, ms = 2600) {
  if (!root) return;
  const toast = root.querySelector<HTMLElement>(".os-toast")!;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout((toast as unknown as { _t?: number })._t);
  (toast as unknown as { _t?: number })._t = setTimeout(() => { toast.hidden = true; }, ms) as unknown as number;
}

export function osHostInfo() { return hostInfo; }
/** 真实身份名(当前 WSL 用户);探测未完成时保留原版虚构名以维持视觉节奏。 */
export function osIdentityName(): string {
  return hostInfo ? hostInfo.user.toUpperCase() : "JOYCE MOORE";
}
export function osMetrics() { return metrics; }

/** 关机序列:淡出至黑场 → 通知后端退出。 */
export function osPowerOffSequence() {
  const shade = document.createElement("div");
  shade.className = "os-shutdown";
  shade.innerHTML = `<div class="os-shutdown-mark">RHINE LAB</div><div class="os-shutdown-text">SYSTEM OFFLINE <i>／</i> 系统已关机</div><small>重新进入请再次运行启动脚本</small>`;
  document.body.append(shade);
  requestAnimationFrame(() => shade.classList.add("on"));
  void api.shutdown().catch(() => { /* 后端可能已停止 */ });
}
