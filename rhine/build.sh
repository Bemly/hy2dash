#!/bin/sh
# 构建 RhineLabUI 前端（含 hy2dash 覆盖层）→ web/rhine/
# 用法：./rhine/build.sh [upstream检出目录]
# 无参数时自动 clone pin 住的上游 commit 到 rhine/upstream/（gitignored）。
set -eu
cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"

COMMIT=129553bce3496f3826ef343b539ca46d25b94852
UP="${1:-$REPO_ROOT/rhine/upstream}"

if [ ! -d "$UP/.git" ]; then
  echo "clone RhineLabUI@$COMMIT ..."
  git init "$UP" >/dev/null
  git -C "$UP" remote add origin https://github.com/LBEILC/RhineLabUI.git 2>/dev/null || true
  git -C "$UP" fetch --depth 1 origin "$COMMIT"
  git -C "$UP" checkout "$COMMIT"
fi
echo "upstream: $(git -C "$UP" rev-parse --short HEAD)"

node rhine/overlay/apply.mjs "$UP" "$REPO_ROOT/rhine/overlay"

cd "$UP"
[ -d node_modules ] || npm ci
npx tsc
# base './'：构建产物用相对路径，可挂在任意 base_path 子路径下
npx vite build --base './'
node -e '
const fs = require("fs");
const p = "dist/index.html";
let h = fs.readFileSync(p, "utf8");
// PWA manifest/icons 用绝对路径，子路径部署下 404，直接去掉（面板不需要安装）
h = h.replace(/<link rel="manifest"[^>]*>/, "");
h = h.replace(/<link rel="apple-touch-icon"[^>]*>/, "");
h = h.replace(/href="\/favicon\.svg"/, "href=\"./favicon.svg\"");
h = h.replace(/<title>.*?<\/title>/, "<title>RHINE LAB · TRAFFIC CONSOLE</title>");
fs.writeFileSync(p, h);
// src 里若有绝对 /fonts /audio /archives 引用改相对（assetUrl 走 BASE_URL 已是相对）
for (const f of fs.readdirSync("dist/assets").filter(f => f.endsWith(".css") || f.endsWith(".js"))) {
  const fp = "dist/assets/" + f;
  const s = fs.readFileSync(fp, "utf8");
  const n = s.replace(/\(\s*"\/(fonts|audio|archives)\//g, "(\"./$1/").replace(/\(\s*\/(fonts|audio|archives)\//g, "(./$1/");
  if (n !== s) { fs.writeFileSync(fp, n); console.log("relativized", f); }
}
console.log("post-process ok");
'
# 注意顺序：必须在 dist 定稿后再生成离线缓存版本
node scripts/build-pwa.mjs

cd "$REPO_ROOT"
rm -rf web/rhine
cp -r "$UP/dist" web/rhine
du -sh web/rhine
echo "done → web/rhine/"
