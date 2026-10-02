// 나라장터 검색/제외 키워드를 브라우저에서 관리하는 로컬 서버.
// keywords.json을 읽고 쓰며, fetch_g2b.js가 다음 실행 때 그대로 사용한다.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const KEYWORDS_PATH = path.join(__dirname, 'keywords.json');

function loadKeywords() {
  const raw = fs.readFileSync(KEYWORDS_PATH, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data.include)) data.include = [];
  if (!Array.isArray(data.exclude)) data.exclude = [];
  return data;
}

function saveKeywords(data) {
  const clean = {
    include: [...new Set(data.include.map((s) => String(s).trim()).filter(Boolean))],
    exclude: [...new Set(data.exclude.map((s) => String(s).trim()).filter(Boolean))],
  };
  fs.writeFileSync(KEYWORDS_PATH, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  return clean;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/keywords') {
      sendJson(res, 200, loadKeywords());
      return;
    }

    if (req.method === 'PUT' && req.url === '/api/keywords') {
      const body = JSON.parse(await readBody(req));
      const saved = saveKeywords(body);
      sendJson(res, 200, saved);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`나라장터 키워드 관리 페이지: http://localhost:${PORT}`);
});
