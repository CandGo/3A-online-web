#!/usr/bin/env node
// Build a classic-script bundle that can be opened directly from file://.
// The normal Vite build remains the HTTP/module distribution used for LAN and P2P.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, "dist-file");

await build({
  root,
  base: "./",
  build: {
    outDir,
    emptyOutDir: true,
    lib: {
      entry: path.resolve(root, "scripts/file-entry.js"),
      name: "SaltlineApp",
      formats: ["iife"],
      fileName: () => "saltline-file.js",
    },
    rollupOptions: {
      output: {
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});

await mkdir(path.join(outDir, "assets"), { recursive: true });

const js = await readFile(path.join(outDir, "saltline-file.js"), "utf8");
let css = await readFile(path.join(outDir, "assets", "saltline-local.css"), "utf8");
const fontData = new Map();
for (let match of css.matchAll(/url\((\.\.\/fonts\/[^)]+)\)/g)) {
  let relative = match[1];
  if (fontData.has(relative)) continue;
  let fontPath = path.resolve(outDir, "fonts", path.basename(relative));
  let encoded = (await readFile(fontPath)).toString("base64");
  fontData.set(relative, `url(data:font/woff2;base64,${encoded})`);
}
css = css.replace(/url\((\.\.\/fonts\/[^)]+)\)/g, (_match, relative) => fontData.get(relative));
const inlineJs = js.replace(/<\/script/gi, "<\\/script");
const inlineCss = css.replace(/<\/style/gi, "<\\/style");

await writeFile(
  path.join(outDir, "index.html"),
  `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#0b0d0f" />
    <meta name="description" content="Saltline — 切断港区三条上行链路，登上撤离船。" />
    <title>Saltline港区防线</title>
    <link rel="icon" href="data:," />
    <style>${inlineCss}</style>
  </head>
  <body>
    <div id="app">
      <canvas id="view" tabindex="0"></canvas>
      <div id="ui"></div>
      <div id="boot">
        <div class="boot-mark">SALTLINE</div>
        <div class="boot-sub" id="boot-msg">正在竖起港区终端</div>
        <div class="boot-bar"><i id="boot-fill"></i></div>
      </div>
    </div>
    <script>${inlineJs}</script>
  </body>
</html>
`,
  "utf8",
);

// index.html already contains the complete application. Remove Vite's
// intermediate bundle, source maps, fonts and worker assets so dist-file is
// a genuinely portable single-file build.
await Promise.all([
  rm(path.join(outDir, "saltline-file.js"), { force: true }),
  rm(path.join(outDir, "saltline-file.js.map"), { force: true }),
  rm(path.join(outDir, "assets"), { recursive: true, force: true }),
  rm(path.join(outDir, "fonts"), { recursive: true, force: true }),
]);

console.log(`file:// build ready: ${path.join(outDir, "index.html")}`);
