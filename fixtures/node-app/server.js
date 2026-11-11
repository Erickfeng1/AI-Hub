import http from "node:http";

const port = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Node 演示应用</title>
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; background: #f7f7f5; color: #2c2c2a; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; border: 1px solid #e5e3dc; border-radius: 16px; padding: 40px 48px; text-align: center; }
  h1 { font-size: 20px; font-weight: 500; }
  p { color: #888780; font-size: 13px; margin-top: 10px; }
  code { background: #f1efe8; padding: 2px 8px; border-radius: 6px; font-size: 12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Node 演示应用</h1>
    <p>这是一个带服务端的 VibeCoding 项目，由中台 MCP 自动识别类型并拉起进程。</p>
    <p>PID <code>${process.pid}</code> · 监听端口 <code>${port}</code></p>
  </div>
</body>
</html>`);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`node-demo listening on ${port}`);
});
