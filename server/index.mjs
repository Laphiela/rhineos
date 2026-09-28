// RhineOS WSL 后端 — 独立启动入口(浏览器后备形态)。
// 核心逻辑已抽至 backend.mjs,与 Electron 主进程(web/electron/main.cjs)共用同一实现。
// 启动:setsid nohup ... 或 rhineos.sh;端口 4876,绑定全部接口供宿主浏览器直连。
import { resolve } from "node:path";
import { startRhineosBackend } from "./backend.mjs";

const PORT = Number(process.env.RHINEOS_PORT ?? 4876);
const WEB_DIST = resolve(import.meta.dirname, "../web/dist");

await startRhineosBackend({ port: PORT, host: "0.0.0.0", distDir: WEB_DIST });
