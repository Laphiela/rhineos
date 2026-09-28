// RhineOS 内置应用 — 终端 / 文件 / 监控 / WSLg 应用启动器 / 设置,全部经后端与 WSL 耦合
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api, watchMetrics, formatBytes, formatUptime, type Metrics, type FsListing, type DesktopApp } from "./api";
import type { WindowManager } from "./wm";
import type { DesktopCallbacks } from "./desktop";

export type OSCallbacks = {
  enterArchives: () => void;
  replayBoot: () => void;
  powerOff: () => void;
};

const $e = <T extends HTMLElement = HTMLElement>(html: string): T => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
};

// ---------------------------------------------------------------- 终端
export function mountTerminal(wm: WindowManager, callbacks: OSCallbacks, cwd?: string) {
  console.info("[os] mountTerminal: 进入");
  const body = wm.open({ id: "terminal", title: "SHELL ACCESS", subtitle: "Linux Shell", w: 860, h: 520 });
  console.info("[os] mountTerminal: 窗口已创建");
  body.classList.add("app-terminal");
  body.innerHTML = "";
  const term = new Terminal({
    // xterm 依赖等宽字符网格;MiSans 为比例字体,必须以等宽字体优先
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
    fontSize: 13.5,
    lineHeight: 1.3,
    cursorBlink: true,
    allowProposedApi: true,
    theme: {
      background: "#101410",
      foreground: "#d9d6cd",
      cursor: "#ed821b",
      cursorAccent: "#101410",
      selectionBackground: "#3a4a3e",
      black: "#2e332f", brightBlack: "#5c635d",
      green: "#8fae7f", brightGreen: "#a7c79a",
      yellow: "#e0a458", brightYellow: "#f0c078",
      blue: "#7f9fbe", brightBlue: "#9dbdd8",
      red: "#c07a6a", brightRed: "#d89a8c",
      magenta: "#a88aa8", brightMagenta: "#c0a4c0",
      cyan: "#7fa8a8", brightCyan: "#9fc4c4",
      white: "#c9c6bd", brightWhite: "#ece9e2",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(body);
  try { fit.fit(); } catch { /* 布局未就绪 */ }

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${proto}://${location.host}/api/term`);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "init", cols: term.cols, rows: term.rows, cwd }));
    term.onData(d => socket.readyState === 1 && socket.send(JSON.stringify({ type: "data", data: d })));
    term.focus();
  });
  socket.addEventListener("message", e => term.write(e.data));
  socket.addEventListener("close", () => term.write("\r\n\x1b[38;5;208m▪ 会话已断开。\x1b[0m\r\n"));
  const ro = new ResizeObserver(() => { try { fit.fit(); socket.readyState === 1 && socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })); } catch { /* 忽略 */ } });
  ro.observe(body);
}

// ---------------------------------------------------------------- 文件管理器
export function mountFiles(wm: WindowManager, callbacks: OSCallbacks, startPath?: string) {
  let listing: FsListing | null = null;
  let selectedFile: string | null = null;
  const body = wm.open({ id: "files", title: "FILE SYSTEM", subtitle: "Linux 文件", w: 980, h: 600 });
  body.classList.add("app-files");
  body.innerHTML = `
    <div class="files-toolbar">
      <button class="files-up" title="上一级">↑</button>
      <input class="files-path" type="text" spellcheck="false" aria-label="路径" />
      <button class="files-go" title="转到">GO ↗</button>
      <button class="files-term" title="在此处打开终端">⌁ 终端</button>
      <button class="files-new" title="新建文件夹">＋ 目录</button>
      <button class="files-newfile" title="新建文件">＋ 文件</button>
    </div>
    <div class="files-main">
      <div class="files-list" role="listbox" aria-label="目录内容"></div>
      <aside class="files-preview"></aside>
    </div>
    <div class="files-status"></div>
  `;
  const listEl = body.querySelector<HTMLElement>(".files-list")!;
  const previewEl = body.querySelector<HTMLElement>(".files-preview")!;
  const pathEl = body.querySelector<HTMLInputElement>(".files-path")!;
  const statusEl = body.querySelector<HTMLElement>(".files-status")!;
  let cwd = startPath || "";

  const status = (text: string) => { statusEl.textContent = text; };

  async function navigate(path: string) {
    try {
      listing = await api.list(path);
      cwd = listing.path;
      pathEl.value = cwd;
      selectedFile = null;
      render();
      previewEl.innerHTML = `<div class="files-preview-empty">选择一份文件以预览</div>`;
      status(`${listing.items.length} 项 · ${cwd}`);
    } catch (e) {
      status(`无法访问:${(e as Error).message}`);
    }
  }

  function render() {
    if (!listing) return;
    listEl.innerHTML = "";
    const mkRow = (name: string, kind: string, size: number, mtime: number, target?: string) => {
      const row = $e(`<div class="files-row" role="option" tabindex="0">
        <span class="files-kind ${kind}">${kind === "dir" ? "▸" : kind === "link" ? "↗" : "▪"}</span>
        <span class="files-name">${name}</span>
        <span class="files-size">${kind === "dir" ? "— " : formatBytes(size)}</span>
        <span class="files-date">${new Date(mtime).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}</span>
      </div>`);
      const open = () => {
        if (target === undefined) return;
        if (kind === "dir") void navigate(target);
        else void preview(target);
      };
      row.addEventListener("click", open);
      row.addEventListener("keydown", e => { if (e.key === "Enter") open(); });
      row.addEventListener("contextmenu", e => {
        e.preventDefault();
        if (target === undefined) return;
        const menu = $e(`<div class="files-menu">
          <button data-act="rename">重命名</button>
          <button data-act="delete">删除</button>
        </div>`);
        menu.style.left = `${e.clientX}px`; menu.style.top = `${e.clientY}px`;
        document.body.append(menu);
        const closeMenu = () => { menu.remove(); document.removeEventListener("click", closeMenu); };
        menu.addEventListener("click", async ev => {
          const act = (ev.target as HTMLElement).dataset.act;
          closeMenu();
          if (act === "rename") {
            const next = prompt(`重命名「${name}」`, name);
            if (next && next !== name) {
              await api.rename(target, target.replace(/[^/]+$/, next)).catch(err => status(`重命名失败:${(err as Error).message}`));
              void navigate(cwd);
            }
          } else if (act === "delete") {
            if (confirm(`删除「${name}」?该操作不可恢复。`)) {
              await api.remove(target).catch(err => status(`删除失败:${(err as Error).message}`));
              void navigate(cwd);
            }
          }
        });
        setTimeout(() => document.addEventListener("click", closeMenu), 0);
      });
      return row;
    };
    if (listing.parent) listEl.append(mkRow("..", "dir", 0, 0, listing.parent));
    for (const item of listing.items) {
      const row = mkRow(item.name, item.type, item.size, item.mtime, `${cwd}/${item.name}`.replace("//", "/"));
      listEl.append(row);
    }
  }

  async function preview(path: string) {
    selectedFile = path;
    status(`读取 ${path} …`);
    try {
      const data = await api.read(path);
      if (data.binary) {
        previewEl.innerHTML = `<div class="files-preview-empty">二进制文件 · ${formatBytes(data.size)}</div>`;
      } else {
        previewEl.innerHTML = `
          <div class="files-preview-head"><span>${data.path.split("/").pop()}</span><small>${formatBytes(data.size)}</small></div>
          <textarea class="files-editor" spellcheck="false"></textarea>
          <div class="files-preview-actions"><button class="files-save">保存写入</button></div>`;
        const editor = previewEl.querySelector<HTMLTextAreaElement>(".files-editor")!;
        editor.value = data.content;
        previewEl.querySelector(".files-save")!.addEventListener("click", async () => {
          await api.write(data.path, editor.value);
          status(`已写入 ${data.path}`);
        });
      }
      status(`已读取 ${path}`);
    } catch (e) {
      previewEl.innerHTML = `<div class="files-preview-empty">${(e as Error).message}</div>`;
      status(`读取失败:${(e as Error).message}`);
    }
  }

  body.querySelector(".files-up")!.addEventListener("click", () => listing?.parent && navigate(listing.parent));
  body.querySelector(".files-go")!.addEventListener("click", () => navigate(pathEl.value));
  pathEl.addEventListener("keydown", e => { if (e.key === "Enter") navigate(pathEl.value); });
  body.querySelector(".files-new")!.addEventListener("click", async () => {
    const name = prompt("新目录名称");
    if (name) { await api.mkdir(`${cwd}/${name}`); void navigate(cwd); }
  });
  body.querySelector(".files-newfile")!.addEventListener("click", async () => {
    const name = prompt("新文件名称");
    if (name) { await api.write(`${cwd}/${name}`, ""); void navigate(cwd); }
  });
  body.querySelector(".files-term")!.addEventListener("click", () => mountTerminal(wm, callbacks, cwd));

  void navigate(startPath || "");
}

// ---------------------------------------------------------------- 系统监控
export function mountMonitor(wm: WindowManager) {
  const body = wm.open({ id: "monitor", title: "SYSTEM MONITOR", subtitle: "系统实时指标", w: 920, h: 580 });
  body.classList.add("app-monitor");
  body.innerHTML = `
    <div class="monitor-grid">
      <section class="monitor-cell cpu"><div class="monitor-kicker">CPU / <span class="cpu-model"></span></div>
        <div class="monitor-big"><span class="cpu-value">0.0</span><small>%</small></div>
        <div class="monitor-cores"></div>
        <div class="monitor-sub">负载 <span class="load-value">0.00 0.00 0.00</span></div></section>
      <section class="monitor-cell mem"><div class="monitor-kicker">MEMORY</div>
        <div class="monitor-big"><span class="mem-value">0.0</span><small>GB</small></div>
        <div class="monitor-bar"><i class="mem-bar-fill"></i></div>
        <div class="monitor-sub"><span class="mem-detail"></span><br>SWAP <span class="swap-detail">0 B</span></div></section>
      <section class="monitor-cell net"><div class="monitor-kicker">NETWORK</div>
        <div class="monitor-big net-rates"><span class="rx-value">0</span><small>↓ B/s</small> <span class="tx-value">0</span><small>↑ B/s</small></div>
        <div class="monitor-sub">累计 ↓ <span class="rx-total">0 B</span> ／ ↑ <span class="tx-total">0 B</span></div>
        <div class="monitor-kicker" style="margin-top:14px">DISK</div>
        <div class="monitor-bar"><i class="disk-bar-fill"></i></div>
        <div class="monitor-sub"><span class="disk-detail"></span></div></section>
    </div>
    <div class="monitor-proc">
      <div class="monitor-kicker">PROCESSES / 按占用排序 <button class="proc-refresh">刷新 ↻</button></div>
      <div class="proc-table"></div>
    </div>
  `;
  const q = <T extends HTMLElement>(s: string) => body.querySelector<T>(s)!;

  const coresEl = q(".monitor-cores");
  const renderCores = (cores: number[]) => {
    if (!cores.length) return;
    if (coresEl.childElementCount !== cores.length) {
      coresEl.innerHTML = cores.map(() => '<i><b></b></i>').join("");
    }
    [...coresEl.children].forEach((el, i) => {
      (el.firstElementChild as HTMLElement).style.height = `${Math.round(cores[i])}%`;
    });
  };

  const stop = watchMetrics(async (m: Metrics) => {
    q(".cpu-value").textContent = m.cpu.percent.toFixed(1);
    renderCores(m.cpu.cores);
    q(".load-value").textContent = m.cpu.loadavg.map(n => n.toFixed(2)).join(" ");
    q(".mem-value").textContent = (m.mem.used / 1024 ** 3).toFixed(1);
    q(".mem-bar-fill").style.width = `${Math.min(100, (m.mem.used / Math.max(1, m.mem.total)) * 100)}%`;
    q(".mem-detail").textContent = `${formatBytes(m.mem.used)} / ${formatBytes(m.mem.total)}`;
    q(".swap-detail").textContent = formatBytes(m.mem.swapUsed);
    q(".rx-value").textContent = formatBytes(m.net.rxRate);
    q(".tx-value").textContent = formatBytes(m.net.txRate);
    q(".rx-total").textContent = formatBytes(m.net.rx);
    q(".tx-total").textContent = formatBytes(m.net.tx);
    q(".disk-bar-fill").style.width = `${Math.min(100, (m.disk.used / Math.max(1, m.disk.total)) * 100)}%`;
    q(".disk-detail").textContent = `${formatBytes(m.disk.used)} / ${formatBytes(m.disk.total)}`;
  });

  const refreshProcs = async () => {
    try {
      const procs = await api.processes();
      q(".proc-table").innerHTML = `
        <div class="proc-row proc-head"><span>PID</span><span>进程</span><span>用户</span><span>CPU%</span><span>MEM%</span></div>
        ${procs.map(p => `<div class="proc-row"><span>${p.pid}</span><span>${p.name}</span><span>${p.user}</span><span>${p.cpu.toFixed(1)}</span><span>${p.mem.toFixed(1)}</span></div>`).join("")}`;
    } catch { /* 静默 */ }
  };
  q(".proc-refresh").addEventListener("click", refreshProcs);
  void refreshProcs();

  void api.host().then(h => { q(".cpu-model").textContent = h.cpuModel.replace(/\(R\)|\(TM\)/g, "").trim(); }).catch(() => {});
  return { stop };
}

// ---------------------------------------------------------------- WSLg 应用启动器
export async function mountLaunchpad(wm: WindowManager) {
  const body = wm.open({ id: "launchpad", title: "APPLICATIONS", subtitle: "图形应用", w: 780, h: 540 });
  body.classList.add("app-launchpad");
  body.innerHTML = `<input class="pad-search" type="search" placeholder="检索应用…" aria-label="检索应用" /><div class="pad-grid"></div><div class="pad-status"></div>`;
  const grid = body.querySelector<HTMLElement>(".pad-grid")!;
  const status = body.querySelector<HTMLElement>(".pad-status")!;
  const search = body.querySelector<HTMLInputElement>(".pad-search")!;
  let apps: DesktopApp[] = [];
  try { apps = await api.apps(); } catch (e) { status.textContent = `无法载入应用列表:${(e as Error).message}`; }

  const render = () => {
    const kw = search.value.trim().toLowerCase();
    const items = apps.filter(a => !kw || a.name.toLowerCase().includes(kw) || a.id.toLowerCase().includes(kw));
    grid.innerHTML = "";
    if (!items.length) { grid.innerHTML = `<div class="pad-empty">没有匹配的应用</div>`; return; }
    for (const app of items) {
      const tile = $e(`<button class="pad-tile"><span class="pad-glyph">${app.icon ? "▣" : "▣"}</span><strong>${app.name}</strong><small>${app.categories[0] ?? "APPLICATION"}</small></button>`);
      tile.addEventListener("click", async () => {
        status.textContent = `启动 ${app.name} …`;
        try { await api.launch(app.id); status.textContent = `${app.name} 已拉起,窗口经 WSLg 显示在 Windows 桌面`; }
        catch (e) { status.textContent = `启动失败:${(e as Error).message}`; }
      });
      grid.append(tile);
    }
  };
  search.addEventListener("input", render);
  render();
}

// ---------------------------------------------------------------- 设置
export function mountSettings(wm: WindowManager, callbacks: DesktopCallbacks) {
  const body = wm.open({ id: "settings", title: "SYSTEM SETTINGS", subtitle: "系统设置", w: 640, h: 480 });
  body.classList.add("app-settings");
  const stored = readSettings();
  body.innerHTML = `
    <div class="settings-block"><div class="settings-kicker">INTERFACE ／ 界面配色</div>
      <div class="settings-choices"><button data-os-theme="light" aria-pressed="${stored.colorTheme !== "dark"}">亮色</button><button data-os-theme="dark" aria-pressed="${stored.colorTheme === "dark"}">暗色</button></div>
    </div>
    <div class="settings-block"><div class="settings-kicker">SYSTEM ／ 系统</div>
      <button class="settings-line" data-os-act="replay">重播开机序列 <span>REINITIALIZE ↗</span></button>
      <button class="settings-line" data-os-act="archives">打开档案终端 <span>ARCHIVE ↗</span></button>
    </div>
    <div class="settings-block"><div class="settings-kicker">HOST ／ 主机信息</div><div class="settings-host">读取中…</div></div>
    <div class="settings-foot">RHINE LAB · ANALYSIS OS — LINUX CUSTOM EDITION<br>基于开源项目 RhineLabUI (MIT) 构建的图形化 Linux 桌面</div>
  `;
  body.querySelectorAll("[data-os-theme]").forEach((btn: Element) =>
    btn.addEventListener("click", () => {
      const dark = (btn as HTMLElement).dataset.osTheme === "dark";
      callbacks.setTheme(dark); // 与主应用同路径(prefs + scene.setTheme),否则每帧被帧循环覆盖
      body.querySelectorAll("[data-os-theme]").forEach((b: Element) => b.setAttribute("aria-pressed", String(b === btn)));
    }));
  body.querySelector('[data-os-act="replay"]')!.addEventListener("click", () => { wm.close("settings"); callbacks.replayBoot(); });
  body.querySelector('[data-os-act="archives"]')!.addEventListener("click", () => { wm.close("settings"); callbacks.enterArchives(); });
  void api.host().then(h => {
    body.querySelector<HTMLElement>(".settings-host")!.innerHTML =
      `<b>${h.user}@${h.hostname}</b><br>${h.distro} · ${h.wsl}<br>${h.cpuModel.replace(/\(R\)|\(TM\)/g, "")} × ${h.cpuCores} 核 · 内存 ${formatBytes(h.memoryTotal)}<br>终端 ${h.pty ? "PTY 就绪" : "降级模式"} · WSLg ${h.gui ? "可用" : "未检出"}`;
  }).catch(e => { body.querySelector<HTMLElement>(".settings-host")!.textContent = (e as Error).message; });
}

// ---------------------------------------------------------------- 关于 / 电源
export function mountAbout(wm: WindowManager) {
  const body = wm.open({ id: "about", title: "ABOUT THIS SYSTEM", subtitle: "关于本系统", w: 560, h: 420 });
  body.classList.add("app-about");
  body.innerHTML = `
    <div class="about-mark">RHINE LAB<br><small>SYNTHESIZE INFORMATION ANALYSIS OS</small></div>
    <div class="about-lines">
      <div><span>系统</span><b>RhineOS · WSL 定制图形桌面</b></div>
      <div><span>视觉基线</span><b>RhineLabUI (MIT) 像素级复刻</b></div>
      <div><span>运行时</span><b>TypeScript + Three.js + Vite · Node 后端</b></div>
      <div><span>耦合层</span><b>WSL2 / WSLg · node-pty · /proc</b></div>
    </div>
    <div class="about-note">非官方粉丝作品,与鹰角网络无关;视觉基线基于 LBEILC/RhineLabUI(MIT License)构建。</div>`;
}

export type PowerAction = "reboot" | "shutdown" | "lock" | "sleep" | "hibernate";
export function mountPower(wm: WindowManager, callbacks: OSCallbacks) {
  const body = wm.open({ id: "power", title: "POWER", subtitle: "电源", w: 420, h: 300 });
  body.classList.add("app-power");
  body.innerHTML = `
    <div class="settings-kicker">POWER ／ 电源</div>
    <div class="settings-kicker">SESSION ／ 会话</div>
    <button class="settings-line" data-os-power="reboot">重新启动 <span>重播开机序列</span></button>
    <button class="settings-line danger" data-os-power="shutdown">关机 <span>结束桌面会话并停止服务</span></button>
    <div class="settings-kicker">WINDOWS HOST ／ 宿主机</div>
    <button class="settings-line" data-os-power="lock">锁屏 <span>LOCK WORKSTATION</span></button>
    <button class="settings-line" data-os-power="sleep">睡眠 <span>SUSPEND</span></button>
    <button class="settings-line" data-os-power="hibernate">休眠 <span>HIBERNATE</span></button>
    <div class="about-note">关机将停止 RhineOS 后端服务;重新进入请再次运行启动脚本。锁屏/睡眠/休眠作用于 Windows 宿主机。</div>`;
  body.querySelectorAll("[data-os-power]").forEach((btn: Element) => btn.addEventListener("click", () => {
    const act = (btn as HTMLElement).dataset.osPower as PowerAction;
    if (act === "shutdown" && !confirm("确认关机?后端服务将退出。")) return;
    if ((act === "sleep" || act === "hibernate") && !confirm("确认让 Windows 宿主机进入该电源状态?")) return;
    wm.close("power");
    if (act === "reboot") callbacks.replayBoot();
    else if (act === "lock" || act === "sleep" || act === "hibernate") void api.powerHost(act);
    else callbacks.powerOff();
  }));
}

// ---------------------------------------------------------------- 本地设置读写(与主应用共享 rhine-settings 键)
type OsStored = { colorTheme?: "light" | "dark" };
function readSettings(): OsStored {
  try { return JSON.parse(localStorage.getItem("rhine-settings") ?? "{}") ?? {}; } catch { return {}; }
}
function saveSettings(patch: OsStored) {
  try {
    const next = { ...readSettings(), ...patch };
    localStorage.setItem("rhine-settings", JSON.stringify(next));
  } catch { /* 隐私模式等 */ }
}
