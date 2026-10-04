#!/usr/bin/env node
// 把 hy2dash 覆盖层接入上游 RhineLabUI 检出。幂等，可重复执行。
// 用法：node apply.mjs <upstream-dir> <overlay-dir>
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const [upstream, overlay] = process.argv.slice(2);
if (!upstream || !overlay) {
  console.error("用法：node apply.mjs <upstream-dir> <overlay-dir>");
  process.exit(1);
}

for (const f of ["traffic.ts", "traffic.css"]) {
  copyFileSync(join(overlay, f), join(upstream, "src", f));
  console.log(`copy ${f}`);
}

const mainPath = join(upstream, "src", "main.ts");
let main = readFileSync(mainPath, "utf8");
const marker = 'import "./traffic"; // hy2dash overlay';
if (!main.includes(marker)) {
  const lines = main.split("\n");
  let last = -1;
  lines.forEach((l, i) => { if (/^import /.test(l)) last = i; });
  if (last < 0) throw new Error("main.ts 里没找到 import 行");
  lines.splice(last + 1, 0, marker);
  writeFileSync(mainPath, lines.join("\n"));
  console.log("patched src/main.ts");
} else {
  console.log("src/main.ts 已 patch，跳过");
}
