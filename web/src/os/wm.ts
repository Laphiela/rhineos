// RhineOS 窗口管理器 — 莱茵生命视觉语言的玻璃窗口:拖拽 / 缩放 / 聚焦 / 最小化 / 最大化
export type WindowOptions = {
  id: string;
  title: string;
  subtitle?: string;
  x?: number;
  y?: number;
  w: number;
  h: number;
  dark?: boolean;
  onClose?: () => void;
  onFocus?: () => void;
};

const EDGE = 10;

export class WindowManager {
  private root: HTMLElement;
  private layer: HTMLElement;
  private windows = new Map<string, { el: HTMLElement; body: HTMLElement; options: WindowOptions; maximized: boolean; restore?: { x: number; y: number; w: number; h: number }; minTimer?: number }>();
  private z = 100;
  private activeId: string | null = null;
  private onChange: (openIds: string[]) => void;

  constructor(root: HTMLElement, onChange: (openIds: string[]) => void) {
    this.root = root;
    this.onChange = onChange;
    this.layer = document.createElement("div");
    this.layer.className = "os-windows";
    root.append(this.layer);
  }

  get openIds() { return [...this.windows.keys()]; }
  get active() { return this.activeId; }

  has(id: string) { return this.windows.has(id); }

  focus(id: string) {
    const win = this.windows.get(id);
    if (!win) return;
    this.activeId = id;
    win.el.style.zIndex = String(++this.z);
    for (const [wid, w] of this.windows) w.el.classList.toggle("focused", wid === id);
    win.options.onFocus?.();
  }

  open(options: WindowOptions): HTMLElement {
    console.info("[os] wm.open:", options.id);
    const existing = this.windows.get(options.id);
    if (existing) {
      if (existing.el.classList.contains("minimized")) this.restore(options.id);
      this.focus(options.id);
      return existing.body;
    }
    const el = document.createElement("section");
    // .pre 起始态(透明+微缩),下一帧移除,由 CSS 过渡演出开窗入场
    el.className = "os-window pre" + (options.dark ? " dark" : "");
    el.dataset.win = options.id;
    const w = Math.min(options.w, this.root.clientWidth - 32);
    const h = Math.min(options.h, this.root.clientHeight - 90);
    const x = options.x ?? Math.max(16, Math.round((this.root.clientWidth - w) / 2 + (this.windows.size * 26) % 120 - 60));
    const y = options.y ?? Math.max(52, Math.round((this.root.clientHeight - h) / 2 - 40 + (this.windows.size * 22) % 90));
    el.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:${++this.z}`;
    el.innerHTML = `
      <header class="os-titlebar">
        <span class="os-title-dot" aria-hidden="true"></span>
        <div class="os-title-text"><strong>${options.title}</strong>${options.subtitle ? `<small>${options.subtitle}</small>` : ""}</div>
        <div class="os-title-actions">
          <button data-win-action="minimize" aria-label="最小化">—</button>
          <button data-win-action="maximize" aria-label="最大化">□</button>
          <button data-win-action="close" aria-label="关闭">×</button>
        </div>
      </header>
      <div class="os-window-body"></div>
      <div class="os-resize" data-dir="e"></div><div class="os-resize" data-dir="s"></div><div class="os-resize" data-dir="se"></div>
    `;
    const body = el.querySelector<HTMLElement>(".os-window-body")!;
    this.layer.append(el);
    this.windows.set(options.id, { el, body, options, maximized: false });
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("pre")));
    el.addEventListener("pointerdown", () => this.focus(options.id));
    el.querySelector('[data-win-action="close"]')!.addEventListener("click", () => this.close(options.id));
    el.querySelector('[data-win-action="minimize"]')!.addEventListener("click", () => this.minimize(options.id));
    el.querySelector('[data-win-action="maximize"]')!.addEventListener("click", () => this.toggleMaximize(options.id));
    const titlebar = el.querySelector<HTMLElement>(".os-titlebar")!;
    titlebar.addEventListener("pointerdown", e => {
      if ((e.target as HTMLElement).closest("button")) return;
      this.startDrag(options.id, e);
    });
    titlebar.addEventListener("dblclick", e => {
      if ((e.target as HTMLElement).closest("button")) return;
      this.toggleMaximize(options.id);
    });
    for (const handle of el.querySelectorAll<HTMLElement>(".os-resize")) {
      handle.addEventListener("pointerdown", e => this.startResize(options.id, handle.dataset.dir!, e));
    }
    this.focus(options.id);
    this.onChange(this.openIds);
    return body;
  }

  close(id: string) {
    const win = this.windows.get(id);
    if (!win) return;
    if (win.minTimer) { clearTimeout(win.minTimer); win.minTimer = undefined; }
    win.el.classList.add("closing");
    setTimeout(() => win.el.remove(), 170);
    this.windows.delete(id);
    win.options.onClose?.();
    if (this.activeId === id) this.activeId = this.openIds.at(-1) ?? null;
    if (this.activeId) this.focus(this.activeId);
    this.onChange(this.openIds);
  }

  minimize(id: string) {
    const win = this.windows.get(id);
    if (!win) return;
    // 先淡出,再落到 display:none,避免生硬瞬隐
    win.el.classList.add("closing");
    if (win.minTimer) clearTimeout(win.minTimer);
    win.minTimer = window.setTimeout(() => {
      win.minTimer = undefined;
      if (!win.el.isConnected) return;
      win.el.classList.remove("closing");
      win.el.classList.add("minimized");
    }, 190);
    if (this.activeId === id) this.activeId = null;
  }

  restore(id: string) {
    const win = this.windows.get(id);
    if (!win) return;
    if (win.minTimer) { clearTimeout(win.minTimer); win.minTimer = undefined; }
    if (win.el.classList.contains("minimized")) {
      win.el.classList.remove("minimized");
      win.el.classList.add("pre");
      requestAnimationFrame(() => requestAnimationFrame(() => win.el.classList.remove("pre")));
    } else {
      win.el.classList.remove("closing");
    }
    this.focus(id);
  }

  toggle(id: string) {
    const win = this.windows.get(id);
    if (!win) return;
    if (win.el.classList.contains("minimized")) this.restore(id);
    else if (this.activeId === id) this.minimize(id);
    else this.focus(id);
  }

  toggleMaximize(id: string) {
    const win = this.windows.get(id);
    if (!win) return;
    if (win.maximized) {
      const r = win.restore!;
      Object.assign(win.el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      win.maximized = false;
      win.el.classList.remove("maximized");
    } else {
      win.restore = {
        x: parseInt(win.el.style.left), y: parseInt(win.el.style.top),
        w: parseInt(win.el.style.width), h: parseInt(win.el.style.height),
      };
      Object.assign(win.el.style, { left: "8px", top: "44px", width: `${this.root.clientWidth - 16}px`, height: `${this.root.clientHeight - 96}px` });
      win.maximized = true;
      win.el.classList.add("maximized");
    }
  }

  private startDrag(id: string, e: PointerEvent) {
    const win = this.windows.get(id);
    if (!win || win.maximized) return;
    e.preventDefault();
    this.focus(id);
    const startX = e.clientX, startY = e.clientY;
    const origX = parseInt(win.el.style.left), origY = parseInt(win.el.style.top);
    const move = (ev: PointerEvent) => {
      const nx = Math.max(-win.el.clientWidth + 120, Math.min(this.root.clientWidth - 80, origX + ev.clientX - startX));
      const ny = Math.max(40, Math.min(this.root.clientHeight - 60, origY + ev.clientY - startY));
      win.el.style.left = `${nx}px`;
      win.el.style.top = `${ny}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private startResize(id: string, dir: string, e: PointerEvent) {
    const win = this.windows.get(id);
    if (!win || win.maximized) return;
    e.preventDefault();
    e.stopPropagation();
    this.focus(id);
    const startX = e.clientX, startY = e.clientY;
    const origW = parseInt(win.el.style.width), origH = parseInt(win.el.style.height);
    const move = (ev: PointerEvent) => {
      if (dir.includes("e")) win.el.style.width = `${Math.max(360, Math.min(this.root.clientWidth - parseInt(win.el.style.left) - 8, origW + ev.clientX - startX))}px`;
      if (dir.includes("s")) win.el.style.height = `${Math.max(220, Math.min(this.root.clientHeight - parseInt(win.el.style.top) - 56, origH + ev.clientY - startY))}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
}
