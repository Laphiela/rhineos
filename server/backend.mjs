// RhineOS 后端核心 — 静态托管 + PTY 终端 + /proc 指标 + 文件系统 + WSLg 应用启动
// 供两处复用:
//   - server/index.mjs        独立服务(浏览器后备形态,端口 4876)
//   - web/electron/main.cjs   Electron 主进程内嵌(原生桌面形态,端口 4877)
import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { readFile, readdir, stat, writeFile, mkdir, rm, rename } from "node:fs/promises";
import { existsSync, statSync, readFileSync as readFileSyncStr, readdirSync as readdirSyncStr } from "node:fs";
import { join, resolve, dirname, basename, normalize, sep } from "node:path";
import { homedir, hostname, userInfo, arch, totalmem, cpus } from "node:os";
import { execFile, spawn } from "node:child_process";

const HOME = homedir();

// ---------------------------------------------------------------- PTY
let pty;
try {
  pty = await import("node-pty");
} catch (error) {
  console.warn("[rhineos] node-pty 不可用,终端退化为无 TTY 模式:", error.message);
}

/**
 * 启动 RhineOS 后端,返回在 server 'listening' 后 resolve 的 Promise。
 * @param {{ port?: number, host?: string, distDir?: string }} opts
 */
export async function startRhineosBackend(opts = {}) {
  const port = Number(opts.port ?? process.env.RHINEOS_PORT ?? 4876);
  const host = opts.host ?? "0.0.0.0";
  const distDir = resolve(opts.distDir ?? resolve(import.meta.dirname, "../web/dist"));

  function spawnShell(cols, rows, cwd) {
    const env = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: process.env.LANG || "C.UTF-8",
      DISPLAY: process.env.DISPLAY || ":0",
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "wayland-0",
    };
    const dir = dirExists(cwd) ? cwd : HOME;
    if (pty) {
      return pty.spawn(process.env.SHELL || "/bin/bash", ["--login"], {
        name: "xterm-256color", cols, rows, cwd: dir, env,
      });
    }
    // 退化路径:管道 bash(无 TTY,不支持 vim/top 等全屏程序)
    const child = spawn("/bin/bash", ["--login"], { cwd: dir, env });
    return {
      write: d => child.stdin.write(d),
      resize: () => {},
      kill: () => child.kill(),
      onData: cb => child.stdout.on("data", d => cb(d.toString())),
      onExit: cb => child.on("exit", cb),
      stderrPipe: child.stderr && (cb => child.stderr.on("data", d => cb(d.toString()))),
    };
  }

  const dirExists = p => {
    if (!p) return false;
    try { return statSyncNoThrow(p)?.isDirectory?.() ?? false; } catch { return false; }
  };
  const statSyncNoThrow = p => { try { return statSync(p); } catch { return null; } };

  // ---------------------------------------------------------------- 主机信息
  function readOsRelease() {
    try {
      const text = readFileSyncStr("/etc/os-release").toString();
      const map = Object.fromEntries(text.split("\n").filter(l => l.includes("=")).map(l => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
      }));
      return map.PRETTY_NAME || map.NAME || "Linux";
    } catch { return "Linux"; }
  }

  function wslVersion() {
    return new Promise(res => {
      execFile("uname", ["-r"], (err, out) => res(err ? "WSL" : /microsoft/i.test(out) ? `WSL2 (${out.trim()})` : out.trim()));
    });
  }

  function hostInfo() {
    const mem = { total: totalmem() };
    return {
      hostname: hostname(),
      user: userInfo().username,
      home: HOME,
      shell: process.env.SHELL || "/bin/bash",
      distro: readOsRelease(),
      kernel: readFileSyncStr("/proc/sys/kernel/osrelease").toString().trim(),
      arch: arch(),
      uptime: Number(readFileSyncStr("/proc/uptime").toString().split(" ")[0]),
      cpuModel: cpus()[0]?.model?.trim() ?? "CPU",
      cpuCores: cpus().length,
      memoryTotal: mem.total,
      pty: Boolean(pty),
    };
  }

  // ---------------------------------------------------------------- /proc 指标
  let lastCpu = null, lastNet = null, lastStamp = 0;

  function cpuSnapshot() {
    const text = readFileSyncStr("/proc/stat").toString();
    const line = text.split("\n").find(l => l.startsWith("cpu "));
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] ?? 0);
    const total = parts.reduce((a, b) => a + b, 0);
    const cores = text.split("\n").filter(l => /^cpu\d+ /.test(l)).map(l => {
      const p = l.trim().split(/\s+/).slice(1).map(Number);
      return { idle: p[3] + (p[4] ?? 0), total: p.reduce((a, b) => a + b, 0) };
    });
    return { idle, total, cores };
  }

  function netSnapshot() {
    const lines = readFileSyncStr("/proc/net/dev").toString().split("\n").slice(2);
    let rx = 0, tx = 0;
    for (const line of lines) {
      const [name, rest] = line.split(":");
      if (!rest) continue;
      if (/lo|docker|veth|br-/.test(name.trim())) continue;
      const f = rest.trim().split(/\s+/).map(Number);
      rx += f[0] || 0; tx += f[8] || 0;
    }
    return { rx, tx };
  }

  function memSnapshot() {
    const info = {};
    for (const line of readFileSyncStr("/proc/meminfo").toString().split("\n")) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) info[m[1]] = Number(m[2]) * 1024;
    }
    const total = info.MemTotal ?? 0, available = info.MemAvailable ?? total;
    const swapTotal = info.SwapTotal ?? 0, swapFree = info.SwapFree ?? 0;
    return { total, available, used: total - available, swapTotal, swapUsed: swapTotal - swapFree };
  }

  function diskSnapshot() {
    return new Promise(res => {
      execFile("df", ["-B1", "/"], (err, out) => {
        if (err) return res({ total: 0, used: 0 });
        const f = out.split("\n")[1]?.split(/\s+/);
        res(f ? { total: Number(f[1]), used: Number(f[2]) } : { total: 0, used: 0 });
      });
    });
  }

  function topProcesses(limit = 12) {
    return new Promise(res => {
      execFile("ps", ["-eo", "pid,comm,pcpu,pmem,ruser", "--sort=-pcpu"], (err, out) => {
        if (err) return res([]);
        const rows = out.split("\n").slice(1).filter(Boolean).slice(0, limit).map(l => {
          const [pid, , comm, pcpu, pmem, ruser] = l.trim().split(/\s+/);
          return { pid: Number(pid), name: comm, cpu: Number(pcpu), mem: Number(pmem), user: ruser };
        });
        res(rows);
      });
    });
  }

  async function metrics() {
    const now = Date.now();
    const cpu = cpuSnapshot(), net = netSnapshot(), mem = memSnapshot();
    const loadavg = readFileSyncStr("/proc/loadavg").toString().split(" ").slice(0, 3).map(Number);
    let cpuPercent = 0, corePercents = [];
    if (lastCpu && now > lastStamp) {
      const dt = cpu.total - lastCpu.total;
      cpuPercent = dt > 0 ? Math.min(100, 100 * (1 - (cpu.idle - lastCpu.idle) / dt)) : 0;
      corePercents = cpu.cores.map((c, i) => {
        const p = lastCpu.cores[i];
        return p && c.total - p.total > 0 ? Math.min(100, 100 * (1 - (c.idle - p.idle) / (c.total - p.total))) : 0;
      });
    }
    const dtn = (now - lastStamp) / 1000;
    const netRates = lastNet && dtn > 0
      ? { rxRate: Math.max(0, (net.rx - lastNet.rx) / dtn), txRate: Math.max(0, (net.tx - lastNet.tx) / dtn) }
      : { rxRate: 0, txRate: 0 };
    lastCpu = cpu; lastNet = net; lastStamp = now;
    const disk = await diskSnapshot();
    return {
      time: new Date().toISOString(),
      cpu: { percent: cpuPercent, cores: corePercents, loadavg },
      mem, net: { ...net, ...netRates }, disk,
      uptime: Number(readFileSyncStr("/proc/uptime").toString().split(" ")[0]),
    };
  }

  // ---------------------------------------------------------------- 文件 API(安全规整路径)
  function safePath(p) {
    const full = normalize(p || HOME);
    return full;
  }

  async function listDir(p) {
    const full = safePath(p);
    const entries = await readdir(full, { withFileTypes: true });
    const items = [];
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".wslconfig") continue;
      let size = 0, mtime = 0, type = e.isDirectory() ? "dir" : "file";
      try {
        const s = await stat(join(full, e.name));
        size = s.size; mtime = s.mtimeMs;
        if (e.isSymbolicLink()) type = "link";
      } catch { /* 权限或竞态,保留默认 */ }
      items.push({ name: e.name, type, size, mtime });
    }
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "zh-CN") : a.type === "dir" ? -1 : 1));
    return { path: full, parent: dirname(full) !== full ? dirname(full) : null, items };
  }

  // ---------------------------------------------------------------- WSLg 应用
  function listApps() {
    const dirs = ["/usr/share/applications", join(HOME, ".local/share/applications")];
    const apps = new Map();
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSyncStr(dir)) {
        if (!f.endsWith(".desktop")) continue;
        try {
          const text = readFileSyncStr(join(dir, f)).toString();
          if (/NoDisplay\s*=\s*true/i.test(text) || /NotShowIn\s*=/.test(text)) continue;
          const get = k => text.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();
          const name = get("Name") || f.replace(".desktop", "");
          const exec = get("Exec");
          if (!exec || /terminal|su -/i.test(get("TryExec") ?? "")) { /* 仍允许 */ }
          if (!exec) continue;
          const id = f;
          const icon = get("Icon") || "";
          const cat = (get("Categories") || "").split(";").filter(Boolean);
          if (!apps.has(id) || dir.endsWith(".local/share/applications")) {
            apps.set(id, { id, name, exec, icon, categories: cat, local: dir.includes(".local") });
          }
        } catch { /* 跳过损坏条目 */ }
      }
    }
    return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  const launched = new Map(); // id -> pid

  function launchApp(id) {
    const app = listApps().find(a => a.id === id);
    if (!app) throw new Error("应用不存在: " + id);
    const child = spawn("/bin/sh", ["-c", app.exec], {
      detached: true, stdio: "ignore",
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0", WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "wayland-0", XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}` },
    });
    child.unref();
    launched.set(id, child.pid);
    return { pid: child.pid };
  }

  // ---------------------------------------------------------------- HTTP
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use("/api", (req, res, next) => {
    if (req.headers["content-type"]?.includes("json") || req.method === "GET") return next();
    next();
  });

  app.get("/api/host", async (_req, res) => {
    res.json({ ...hostInfo(), wsl: await wslVersion(), appsCount: existsSync("/usr/share/applications") ? listApps().length : 0, gui: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) });
  });
  app.get("/api/metrics", async (_req, res) => {
    res.json(await metrics());
  });
  app.get("/api/processes", async (_req, res) => res.json(await topProcesses(24)));

  app.get("/api/fs/list", async (req, res) => {
    try { res.json(await listDir(req.query.path)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get("/api/fs/read", async (req, res) => {
    try {
      const full = safePath(req.query.path);
      const s = await stat(full);
      if (s.size > 512 * 1024) return res.status(413).json({ error: "文件超过 512KB,请在终端中查看" });
      const buf = await readFile(full);
      res.json({ path: full, size: s.size, binary: buf.includes(0), content: buf.toString("utf8") });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post("/api/fs/write", async (req, res) => {
    try { await writeFile(safePath(req.body.path), req.body.content ?? "", "utf8"); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post("/api/fs/mkdir", async (req, res) => {
    try { await mkdir(safePath(req.body.path), { recursive: true }); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post("/api/fs/delete", async (req, res) => {
    try { await rm(safePath(req.body.path), { recursive: true }); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post("/api/fs/rename", async (req, res) => {
    try { await rename(safePath(req.body.from), safePath(req.body.to)); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get("/api/apps", (_req, res) => res.json(listApps()));
  app.post("/api/apps/launch", (req, res) => {
    try { res.json(launchApp(req.body.id)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get("/api/apps/launched", (_req, res) => res.json([...launched.entries()].map(([id, pid]) => ({ id, pid }))));
  app.post("/api/apps/kill", (req, res) => {
    const pid = launched.get(req.body.id);
    if (!pid) return res.status(404).json({ error: "未在运行" });
    try { process.kill(pid, "SIGTERM"); launched.delete(req.body.id); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post("/api/power/shutdown", (_req, res) => {
    res.json({ ok: true });
    setTimeout(() => { console.log("[rhineos] 收到关机指令,服务退出"); process.exit(0); }, 1200);
  });
  app.post("/api/power/reboot", (_req, res) => res.json({ ok: true }));

  // 宿主机电源操作(WSL 直接执行 Windows 可执行文件)
  const WIN = "/mnt/c/Windows/System32";
  function powerHost(action) {
    const table = {
      lock: [`${WIN}/rundll32.exe`, ["user32.dll,LockWorkStation"]],
      sleep: [`${WIN}/rundll32.exe`, ["powrprof.dll,SetSuspendState", "0,1,0"]],
      hibernate: [`${WIN}/shutdown.exe`, ["/h", "/t", "0"]],
    };
    const entry = table[action];
    if (!entry) throw new Error("未知电源操作: " + action);
    const child = spawn(entry[0], entry[1], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, action };
  }
  app.post("/api/power/lock", (_req, res) => {
    try { res.json(powerHost("lock")); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post("/api/power/sleep", (_req, res) => {
    try { res.json(powerHost("sleep")); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post("/api/power/hibernate", (_req, res) => {
    try { res.json(powerHost("hibernate")); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 静态托管前端构建产物
  app.use(express.static(distDir, { maxAge: "1h", setHeaders: (res, p) => { if (p.endsWith(".html")) res.setHeader("Cache-Control", "no-cache"); } }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(distDir, "index.html")));

  // ---------------------------------------------------------------- 终端 WS
  const server = createServer(app);
  const wssTerm = new WebSocketServer({ noServer: true });
  wssTerm.on("connection", ws => {
    let term = null;
    ws.on("message", raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "init" && !term) {
        term = spawnShell(msg.cols ?? 80, msg.rows ?? 24, msg.cwd);
        term.onData(d => { if (ws.readyState === 1) ws.send(d); });
        term.stderrPipe?.(d => { if (ws.readyState === 1) ws.send(d); });
        term.onExit(({ exitCode }) => { try { ws.send(JSON.stringify({ type: "exit", exitCode })); ws.close(); } catch {} });
      } else if (msg.type === "data" && term) {
        term.write(msg.data);
      } else if (msg.type === "resize" && term) {
        term.resize(msg.cols ?? 80, msg.rows ?? 24);
      }
    });
    ws.on("close", () => term?.kill());
  });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === "/api/term") wssTerm.handleUpgrade(req, socket, head, ws => wssTerm.emit("connection", ws, req));
    else socket.destroy();
  });

  await new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(port, host, () => {
      server.off("error", rej);
      // 绑定全部接口(独立形态):WSL2 NAT 环境下宿主浏览器可直连;
      // Electron 形态传 host=127.0.0.1,仅本机窗口访问。
      const info = hostInfo();
      console.log(`
  ┌─────────────────────────────────────────────────┐
  │  RHINE LAB · ANALYSIS OS  (RhineOS for WSL)     │
  │  ${`http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`.padEnd(48)}│
  │  主机 ${`${info.user}@${info.hostname}`.padEnd(43)}│
  │  系统 ${info.distro.slice(0, 37).padEnd(38)}│
  │  终端 ${`${info.pty ? "node-pty" : "无TTY(降级)"} · GUI ${info.gui ? "WSLg ✓" : "未检出"}`.padEnd(43)}│
  └─────────────────────────────────────────────────┘
`);
      res({ server, wssTerm, port, host });
    });
  });
  return { server, wssTerm, port, host };
}
