// RhineOS 后端 API 客户端 — 与 WSL 服务端耦合的唯一通道
export type HostInfo = {
  hostname: string;
  user: string;
  home: string;
  shell: string;
  distro: string;
  kernel: string;
  arch: string;
  uptime: number;
  cpuModel: string;
  cpuCores: number;
  memoryTotal: number;
  pty: boolean;
  wsl: string;
  gui: boolean;
  appsCount: number;
};

export type Metrics = {
  time: string;
  cpu: { percent: number; cores: number[]; loadavg: number[] };
  mem: { total: number; available: number; used: number; swapTotal: number; swapUsed: number };
  net: { rx: number; tx: number; rxRate: number; txRate: number };
  disk: { total: number; used: number };
  uptime: number;
};

export type FsEntry = { name: string; type: "dir" | "file" | "link"; size: number; mtime: number };
export type FsListing = { path: string; parent: string | null; items: FsEntry[] };

export type DesktopApp = { id: string; name: string; exec: string; icon: string; categories: string[] };

const base = "";

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + input, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

const post = (url: string, body: unknown) =>
  json(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  host: () => json<HostInfo>("/api/host"),
  metrics: () => json<Metrics>("/api/metrics"),
  processes: () => json<{ pid: number; name: string; cpu: number; mem: number; user: string }[]>("/api/processes"),

  list: (path: string) => json<FsListing>(`/api/fs/list?path=${encodeURIComponent(path)}`),
  read: (path: string) => json<{ path: string; size: number; binary: boolean; content: string }>(`/api/fs/read?path=${encodeURIComponent(path)}`),
  write: (path: string, content: string) => post("/api/fs/write", { path, content }),
  mkdir: (path: string) => post("/api/fs/mkdir", { path }),
  remove: (path: string) => post("/api/fs/delete", { path }),
  rename: (from: string, to: string) => post("/api/fs/rename", { from, to }),

  apps: () => json<DesktopApp[]>("/api/apps"),
  launch: (id: string) => post("/api/apps/launch", { id }),
  killApp: (id: string) => post("/api/apps/kill", { id }),

  shutdown: () => post("/api/power/shutdown", {}),
  powerHost: (action: "lock" | "sleep" | "hibernate") => post(`/api/power/${action}`, {}),
};

/** 订阅周期指标(SSE 语义退化为轮询,2s 间隔足够桌面级仪表)。 */
export function watchMetrics(onTick: (m: Metrics) => void): () => void {
  let stop = false;
  let timer: ReturnType<typeof setTimeout>;
  const loop = async () => {
    if (stop) return;
    try {
      onTick(await api.metrics());
    } catch { /* 后端瞬时不可达,静默重试 */ }
    if (!stop) timer = setTimeout(loop, 2000);
  };
  void loop();
  return () => { stop = true; clearTimeout(timer); };
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d} 天 ${h} 小时` : h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}
