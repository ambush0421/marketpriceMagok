// 마곡동 실거래 대시보드 파일을 로컬 HTTP로 확인하기 위한 정적 서버다.
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 8787);
const types = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const decoded = decodeURIComponent(url.pathname);
  const target = path.resolve(root, decoded === "/" ? "docs/ai-output/20260608-magok-commercial-price-dashboard.html" : decoded.slice(1));

  if (!target.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(target, (error, body) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(target)] || "application/octet-stream" });
    res.end(body);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`dashboard server listening on http://127.0.0.1:${port}`);
});
