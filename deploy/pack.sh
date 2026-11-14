#!/usr/bin/env bash
# deploy/pack.sh — 本机打包：构建前端 → 打部署 tar 包 → 校验清单。
# 用法：bash deploy/pack.sh（或 npm run deploy:pack）
# 产物：deploy/out/saltline-deploy-<日期时间>.tar.gz（只保留最近 5 个）
# 说明：src/net/protocol.js 必须打包——server/index.js 与 server/rooms.js 都
#       从它 import（运行时依赖，不是仅开发用）；docs 只带 *.md，不带截图。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT_DIR="$ROOT/deploy/out"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARBALL="$OUT_DIR/saltline-deploy-$STAMP.tar.gz"

echo "==> [1/3] npm run build（产出 dist/）"
npm run build

echo "==> [2/3] 打包 -> $TARBALL"
mkdir -p "$OUT_DIR"
tar -czf "$TARBALL" \
  dist \
  server \
  src/net/protocol.js \
  scripts/mp-smoke.mjs \
  package.json \
  package-lock.json \
  docs/*.md \
  deploy/ecosystem.config.cjs

echo "==> [3/3] 校验清单"
LIST="$(tar -tzf "$TARBALL")"
for must in \
  dist/index.html \
  server/index.js \
  server/rooms.js \
  src/net/protocol.js \
  scripts/mp-smoke.mjs \
  package.json \
  package-lock.json \
  deploy/ecosystem.config.cjs; do
  printf '%s\n' "$LIST" | grep -qx "$must" || { echo "!! 打包缺文件: $must"; exit 1; }
done
printf '%s\n' "$LIST" | wc -l | xargs -I{} echo "    清单共 {} 个条目"

# 只保留最近 5 个部署包，防止 deploy/out/ 无限膨胀
ls -t "$OUT_DIR"/saltline-deploy-*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f

echo "    包大小: $(du -h "$TARBALL" | cut -f1)"
echo "打包完成: $TARBALL"
