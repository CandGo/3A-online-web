import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    // 局域网联机：开放绑定（MP-CONTRACT §3）；/ws 反代到独立端口的房间服务器
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:8787",
        ws: true,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  build: {
    sourcemap: true,
  },
});
