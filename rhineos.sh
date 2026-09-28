#!/usr/bin/env bash
# RhineOS — 莱茵生命图形化 WSL 桌面 启动脚本
# 用法: ./rhineos.sh [--build] [--no-browser] [--port 4876]
set -euo pipefail
cd "$(dirname "$0")"

PORT=4876
DO_BUILD=0
NO_BROWSER=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) DO_BUILD=1; shift;;
    --no-browser) NO_BROWSER=1; shift;;
    --port) PORT="$2"; shift 2;;
    *) echo "未知参数: $1"; exit 1;;
  esac
done

# 优先使用 Linux 原生 Node(node-pty 需要原生编译环境)
if [[ -d "$HOME/.local/lib/nodejs/node22/bin" ]]; then
  export PATH="$HOME/.local/lib/nodejs/node22/bin:$PATH"
fi
command -v node >/dev/null || { echo "未找到 Node.js"; exit 1; }

# 首次运行自动安装依赖
[[ -d server/node_modules ]] || (cd server && npm install --silent)
if [[ ! -d web/node_modules || $DO_BUILD -eq 1 ]]; then
  [[ -d web/node_modules ]] || (cd web && npm ci --silent)
fi
# 未构建过或源码有更新时重新构建
if [[ ! -f web/dist/index.html || $DO_BUILD -eq 1 ]]; then
  echo "[rhineos] 构建前端…"
  (cd web && npm run build >/dev/null 2>&1)
fi

# 端口占用则先停掉旧实例
if curl -sf "http://127.0.0.1:$PORT/api/host" >/dev/null 2>&1; then
  echo "[rhineos] 服务已在运行: http://127.0.0.1:$PORT"
else
  echo "[rhineos] 启动后端 (端口 $PORT)…"
  RHINEOS_PORT=$PORT nohup node server/index.mjs >/tmp/rhineos-server.log 2>&1 &
  sleep 1
fi

if [[ $NO_BROWSER -eq 0 ]]; then
  # Windows 侧浏览器直连 WSL NAT IP(比 localhost 转发更可靠);127.0.0.1 作为备选
  WSL_IP=$(hostname -I | awk '{print $1}')
  URL="http://${WSL_IP:-127.0.0.1}:$PORT"
  open_kiosk() {
    # 优先以独立应用窗口(app 模式)打开,获得"桌面"体验
    for exe in \
      "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
      "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
      "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" \
      "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"; do
      if [[ -f "$exe" ]]; then
        "$exe" --app="$URL" >/dev/null 2>&1 &
        return 0
      fi
    done
    command -v wslview >/dev/null && { wslview "$URL"; return 0; }
    command -v xdg-open >/dev/null && { xdg-open "$URL" >/dev/null 2>&1; return 0; }
    return 1
  }
  if open_kiosk; then
    echo "[rhineos] 已在应用窗口中打开 $URL"
  else
    echo "[rhineos] 请手动访问: $URL"
  fi
fi

echo "[rhineos] 就绪。日志: /tmp/rhineos-server.log · 停止: pkill -f 'node server/index.mjs'"
