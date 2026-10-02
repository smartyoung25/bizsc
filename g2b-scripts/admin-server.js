// 입찰·지원사업·공모 통합 수집 시스템 관리자 화면 로컬 서버.
// keywords.json / institutions.json / settings.json을 읽고 쓴다.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const PORT = 8765;
const KEYWORDS_PATH = path.join(__dirname, 'keywords.json');
const INSTITUTIONS_PATH = path.join(__dirname, '..', 'institutions.json');
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const RESULTS_DIR = path.join(__dirname, '..');
const RESULT_FILE_RE = /^g2b_입찰공고_(\d{8})\.xlsx$/;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function loadKeywords() {
  const data = readJson(KEYWORDS_PATH);
  if (!Array.isArray(data.include)) data.include = [];
  if (!Array.isArray(data.exclude)) data.exclude = [];
  return data;
}
function saveKeywords(data) {
  const clean = {
    include: [...new Set(data.include.map((s) => String(s).trim()).filter(Boolean))],
    exclude: [...new Set(data.exclude.map((s) => String(s).trim()).filter(Boolean))],
  };
  writeJson(KEYWORDS_PATH, clean);
  return clean;
}

function loadInstitutions() {
  return readJson(INSTITUTIONS_PATH);
}
function saveInstitutions(data) {
  writeJson(INSTITUTIONS_PATH, data);
  return data;
}

function loadSettings() {
  return readJson(SETTINGS_PATH);
}
function saveSettings(data) {
  writeJson(SETTINGS_PATH, data);
  return data;
}

function listResultFiles() {
  return fs.readdirSync(RESULTS_DIR)
    .map((name) => {
      const m = name.match(RESULT_FILE_RE);
      if (!m) return null;
      const d = m[1];
      return { date: d, label: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, filename: name };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

function loadResultFile(date) {
  const files = listResultFiles();
  const target = date === 'latest' ? files[0] : files.find((f) => f.date === date);
  if (!target) return null;
  const wb = XLSX.readFile(path.join(RESULTS_DIR, target.filename));
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return { date: target.date, label: target.label, filename: target.filename, rows };
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

const ROUTES = {
  'GET /api/keywords': (req, res) => sendJson(res, 200, loadKeywords()),
  'PUT /api/keywords': async (req, res) => sendJson(res, 200, saveKeywords(JSON.parse(await readBody(req)))),
  'GET /api/institutions': (req, res) => sendJson(res, 200, loadInstitutions()),
  'PUT /api/institutions': async (req, res) => sendJson(res, 200, saveInstitutions(JSON.parse(await readBody(req)))),
  'GET /api/settings': (req, res) => sendJson(res, 200, loadSettings()),
  'PUT /api/settings': async (req, res) => sendJson(res, 200, saveSettings(JSON.parse(await readBody(req)))),
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === 'GET' && parsedUrl.pathname === '/api/results/list') {
      sendJson(res, 200, listResultFiles());
      return;
    }
    if (req.method === 'GET' && parsedUrl.pathname === '/api/results') {
      const date = parsedUrl.searchParams.get('date') || 'latest';
      const result = loadResultFile(date);
      if (!result) { sendJson(res, 404, { error: `no result file for ${date}` }); return; }
      sendJson(res, 200, result);
      return;
    }

    const key = `${req.method} ${parsedUrl.pathname}`;
    if (ROUTES[key]) {
      await ROUTES[key](req, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`관리자 화면: http://localhost:${PORT}`);
});
