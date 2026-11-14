// src/app/tick-worker.js — BACKGROUND-TICK 心跳 Worker（联网后台保活）
// 背景：Chrome 对后台标签页冻结 rAF → 房主窗口被切后台时整个房间失去权威
// 模拟（客户端看到全员卡死）。模块 Worker 的 setInterval 不受后台标签节流，
// 故以 15ms 节拍 postMessage("tick") 唤醒主线程跑降级模拟帧
// step(dt, { render: false })（接线见 runtime.js BACKGROUND-TICK ②）。
// 协议（主线程 → worker）：
//   postMessage("start") → 开始 15ms 心跳（幂等，重复 start 不叠加定时器）
//   postMessage("stop")  → 清除心跳（幂等；主线程侧另有 terminate 兜底）
let heartbeat = null;
self.onmessage = (event) => {
  let data = event && event.data;
  if (data === "start") {
    if (heartbeat != null) return;
    heartbeat = setInterval(() => postMessage("tick"), 15);
  } else if (data === "stop" && heartbeat != null) {
    (clearInterval(heartbeat), (heartbeat = null));
  }
};
