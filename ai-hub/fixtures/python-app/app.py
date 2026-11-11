import os
from flask import Flask, jsonify

app = Flask(__name__)


@app.get("/")
def index():
    return """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>运营助手</title>
<style>body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f7f7f5;display:flex;min-height:100vh;align-items:center;justify-content:center;color:#2c2c2a}
.card{background:#fff;border:1px solid #e5e3dc;border-radius:16px;padding:36px 44px;text-align:center}
h1{font-size:20px;font-weight:500;margin-bottom:8px}
p{font-size:13px;color:#5f5e5a;margin-bottom:4px}
code{background:#f1efe8;border-radius:6px;padding:2px 8px;font-size:12px}</style></head>
<body><div class="card">
<h1>运营助手（Python / Flask）</h1>
<p>由中台 MCP 自动创建 venv、安装依赖并启动</p>
<p>PID <code>%d</code> · PORT <code>%s</code></p>
<p style="margin-top:10px"><a href="/api/info" style="color:#185fa5">/api/info</a></p>
</div></body></html>""" % (os.getpid(), os.environ.get("PORT", "5000"))


@app.get("/api/info")
def info():
    return jsonify(app="ops-assistant", runtime="flask", pid=os.getpid(), port=os.environ.get("PORT"))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")))
