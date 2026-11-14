#!/usr/bin/env bash
# deploy/deploy.sh — 本机总入口：打包 → scp 上传 → 远程解包+npm ci+pm2 重载 → 健康检查。
# 用法（二选一）:
#   npm run deploy -- root@1.2.3.4
#   SSH_HOST=root@1.2.3.4 bash deploy/deploy.sh
# 可选环境变量: SSH_PORT（默认 22）、REMOTE_DIR（默认 /opt/saltline）
# 前提: ① 服务器已跑过一次 remote-setup.sh（Node 22 + pm2）；② 本机已配好 SSH 密钥认证。
#       BatchMode=yes——无交互：如果走到密码提示会直接失败而不是挂住。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

TARGET="${1:-${SSH_HOST:-}}"
SSH_PORT="${SSH_PORT:-22}"
REMOTE_DIR="${REMOTE_DIR:-/opt/saltline}"

if [ -z "$TARGET" ]; then
  echo "用法: npm run deploy -- <user@host>（或 SSH_HOST=<user@host> bash deploy/deploy.sh）"
  echo "可选: SSH_PORT=22 REMOTE_DIR=/opt/saltline"
  exit 1
fi

SSH_OPTS=(-p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)

# ---------- 1. 打包 ----------
echo "==> [1/4] 打包（build + tar）"
bash "$ROOT/deploy/pack.sh"
TARBALL="$(ls -t "$ROOT"/deploy/out/saltline-deploy-*.tar.gz | head -1)"
[ -n "$TARBALL" ] || { echo "!! 未找到部署包"; exit 1; }
TARNAME="$(basename "$TARBALL")"
echo "    上传: $TARNAME ($(du -h "$TARBALL" | cut -f1))"

# ---------- 2. 上传 ----------
echo "==> [2/4] 上传到 $TARGET:$REMOTE_DIR/"
ssh "${SSH_OPTS[@]}" "$TARGET" "mkdir -p '$REMOTE_DIR/logs'"
scp -P "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  "$TARBALL" "$TARGET:$REMOTE_DIR/"

# ---------- 3. 远程部署（解包 -> 依赖 -> pm2 重载 -> 本机健康检查）----------
echo "==> [3/4] 远程部署"
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s "$REMOTE_DIR" "$TARNAME" <<'REMOTE'
set -euo pipefail
REMOTE_DIR="$1"; TARNAME="$2"

command -v node >/dev/null 2>&1 || { echo '!! 服务器缺 Node: 先跑一次 remote-setup（见 runbook）'; exit 1; }
command -v pm2  >/dev/null 2>&1 || { echo '!! 服务器缺 pm2 : 先跑一次 remote-setup（见 runbook）'; exit 1; }

cd "$REMOTE_DIR"
tar xzf "$TARNAME"
rm -f "$TARNAME"          # 解包完即删，目录不留包
mkdir -p logs
npm ci --omit=dev         # registry 已在 remote-setup 里设为 npmmirror
pm2 startOrReload deploy/ecosystem.config.cjs --update-env
pm2 save                  # 持久化进程表（配合开机自启）

echo '==> [4/4] 健康检查（http://127.0.0.1:8787/）'
sleep 1
code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/)"
if [ "$code" != "200" ]; then
  echo "!! 健康检查失败: HTTP $code；看日志: pm2 logs saltline-mp"
  exit 1
fi
echo 'OK: 服务器本机 8787 端口返回 200'
REMOTE

echo ""
echo "部署完成。玩家访问: http://<服务器公网IP>:8787 （$TARGET）"
echo "验收步骤与故障排查: docs/DEPLOY-CN-RUNBOOK.md"
