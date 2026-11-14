// deploy/ecosystem.config.cjs — pm2 进程配置（Saltline 多人服务器）
// 为什么是 .cjs 不是 .js：仓库 package.json 声明了 "type": "module"，
// 而 pm2 用 require() 读取配置文件，ESM 的 export default 会被包成
// { __esModule, default } 导致 pm2 报 "No script path - aborting"
// （实测 pm2 7.1.2 如此）。CommonJS 后缀 .cjs 是 type:module 仓库下的标准解法。
// 用法（服务器 /opt/saltline 下）：pm2 startOrReload deploy/ecosystem.config.cjs --update-env
// 前提：/opt/saltline/logs 目录已存在（remote-setup.sh / deploy.sh 会创建）。

module.exports = {
  apps: [
    {
      name: "saltline-mp", // 进程名：pm2 logs / reload / status 都用它
      script: "server/index.js", // 相对 cwd 解析
      cwd: "/opt/saltline",
      instances: 1, // 房间态在单进程内存里（房主权威 + WS 中继），禁止多实例
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 8787, // 对外端口：腾讯云防火墙/安全组放行 TCP 8787
      },
      autorestart: true, // 崩溃自动拉起
      max_restarts: 10,
      restart_delay: 2000,
      max_memory_restart: "300M", // 超内存自动重启（2G 轻量机留足余量）
      out_file: "/opt/saltline/logs/saltline-mp-out.log",
      error_file: "/opt/saltline/logs/saltline-mp-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
  ],
};
