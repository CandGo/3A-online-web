#!/usr/bin/env bash
# deploy/remote-setup.sh — 服务器初始化（腾讯云轻量 Debian/Ubuntu，root，只需跑一次）。
# 做的事：基础工具 → Node 22 LTS（NodeSource 官方 apt 源；失败回落 npmmirror 二进制直装）
#         → npm 换 npmmirror 国内源 → 全局装 pm2 → 建目录 →（若代码已就位）启动并保存。
# 用法（本机执行，无需先上传任何文件）：
#   ssh root@<服务器IP> 'bash -s' < deploy/remote-setup.sh
# 注意：注释为中文（UTF-8），脚本逻辑全部 ASCII、不依赖服务器 locale。
set -euo pipefail

NPMMIRROR_REGISTRY="https://registry.npmmirror.com"
NODE_MIRROR_BASE="https://registry.npmmirror.com/-/binary/node"
APP_DIR="/opt/saltline"

log() { printf '\n===== %s =====\n' "$*"; }

# ---------- 0. 前置检查 ----------
[ "$(id -u)" = "0" ] || { echo "错误: 请用 root 运行（腾讯云轻量默认 root 登录）"; exit 1; }
if [ ! -r /etc/os-release ] || ! grep -qiE 'debian|ubuntu' /etc/os-release; then
  echo "错误: 本脚本只支持 Debian/Ubuntu（步骤见 docs/DEPLOY-CN-RUNBOOK.md）"; exit 1
fi

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

# ---------- 1. 基础工具 ----------
log "1/6 安装基础工具（curl / ca-certificates / gnupg / xz-utils）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg xz-utils

# ---------- 2. Node 22 LTS ----------
log "2/6 安装 Node 22 LTS"
if [ "$(node_major)" = "22" ]; then
  echo "已有 Node $(node -v)，跳过安装"
else
  installed=0
  # 方案 A（标准做法）：NodeSource 官方 apt 源，之后可用 apt-get upgrade 升级
  if curl -fsSL --max-time 60 https://deb.nodesource.com/setup_22.x | bash -; then
    if apt-get install -y nodejs && [ "$(node_major)" = "22" ]; then
      installed=1
    fi
  fi
  # 方案 B（国内网络回落）：npmmirror 镜像的 Node 官方二进制，直解到 /usr/local
  if [ "$installed" != "1" ]; then
    echo "NodeSource 不可用或失败，回落 npmmirror 二进制直装"
    case "$(dpkg --print-architecture)" in
      amd64) narch="x64" ;;
      arm64) narch="arm64" ;;
      *) echo "错误: 不支持的 CPU 架构 $(dpkg --print-architecture)"; exit 1 ;;
    esac
    NODE_VER="$(curl -fsSL --max-time 60 "$NODE_MIRROR_BASE/latest-v22.x/SHASUMS256.txt" \
      | awk -v a="$narch" '$2 ~ ("linux-" a ".tar.xz$") {print $2; exit}' \
      | sed -E 's/^node-v([0-9]+\.[0-9]+\.[0-9]+)-.*/\1/')"
    [ -n "$NODE_VER" ] || { echo "错误: 从 npmmirror 取 Node 22 版本号失败"; exit 1; }
    echo "安装 node-v$NODE_VER-linux-$narch -> /usr/local"
    curl -fL --max-time 600 "$NODE_MIRROR_BASE/v$NODE_VER/node-v$NODE_VER-linux-$narch.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1
  fi
fi
[ "$(node_major)" = "22" ] || { echo "错误: Node 22 安装失败，请手动排查（node -v / npm -v）"; exit 1; }
echo "Node: $(node -v) / npm: $(npm -v)"

# ---------- 3. npm 国内源 ----------
log "3/6 npm 切换 npmmirror 源"
npm config set registry "$NPMMIRROR_REGISTRY"
npm config get registry

# ---------- 4. pm2 ----------
log "4/6 全局安装 pm2"
npm install -g pm2
echo "pm2: $(pm2 -v)"

# ---------- 5. 应用目录 ----------
log "5/6 创建 $APP_DIR（含日志目录）"
mkdir -p "$APP_DIR/logs"

# ---------- 6. 启动（若代码已上传过）----------
log "6/6 启动应用"
if [ -f "$APP_DIR/package.json" ]; then
  cd "$APP_DIR"
  npm ci --omit=dev
  pm2 startOrReload deploy/ecosystem.config.cjs --update-env
  pm2 save
else
  echo "代码尚未上传：稍后在本机执行  npm run deploy -- root@<服务器IP>  完成首次部署"
fi

# ---------- 开机自启 ----------
if pm2 startup systemd >/dev/null 2>&1; then
  pm2 save
  echo "已配置 systemd 开机自启（pm2 startup systemd + pm2 save）"
else
  cat <<'HINT'
提示: 自动配置开机自启失败，请手动执行下面两条（第一条若打印出 sudo 命令，照抄执行它）:
  pm2 startup systemd -u root --hp /root
  pm2 save
HINT
fi

cat <<'NEXT'

初始化完成。下一步（在本机仓库根目录执行）:
  npm run deploy -- root@<服务器IP>

浏览器访问: http://<服务器公网IP>:8787
运维手册: docs/DEPLOY-CN-RUNBOOK.md
NEXT
