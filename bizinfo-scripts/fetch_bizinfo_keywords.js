// 기업마당(bizinfo.go.kr) 지원사업 공고를 나라장터와 동일한 키워드로 검색해 수집하는 스크립트.
// keywords.json(g2b-scripts)의 검색/제외 키워드를 그대로 재사용한다.
'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const OUTPUT_DIR = path.join(__dirname, '..');
const KEYWORDS_PATH = path.join(__dirname, '..', 'g2b-scripts', 'keywords.json');
const BASE_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do';
const DETAIL_BASE_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do';
const ROWS_PER_PAGE = 15;
const MAX_PAGES = 30; // 안전장치

const { include: KEYWORDS, exclude: EXCLUDE_KEYWORDS } = JSON.parse(fs.readFileSync(KEYWORDS_PATH, 'utf8'));

function isExcluded(title) {
  return EXCLUDE_KEYWORDS.some((w) => title.includes(w));
}

function decodeEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

// 신청기간(예: "2026-09-08 ~ 2026-09-30")에서 마감일자를 추출한다.
function extractDeadline(신청기간) {
  const m = String(신청기간 || '').match(/~\s*(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function buildUrl(keyword, cpage) {
  const params = new URLSearchParams({
    hashCode: '', // 빈 값 = 전체 지원분야 대상 검색
    rowsSel: '6',
    rows: String(ROWS_PER_PAGE),
    cpage: String(cpage),
    cat: '',
    schJrsdCodeTy: '',
    schWntyAt: '',
    schAreaDetailCodes: '',
    schEndAt: 'N', // 마감 제외 (진행중인 공고만)
    orderGb: '',
    sort: '',
    schPblancDiv: '',
    condition: 'searchPblancNm',
    condition1: 'AND',
    preKeywords: '',
    keyword,
  });
  return `${BASE_URL}?${params.toString()}`;
}

async function fetchPage(keyword, cpage) {
  const url = buildUrl(keyword, cpage);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for keyword=${keyword} cpage=${cpage}`);
  return res.text();
}

function parseRows(html) {
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbodyMatch) return [];
  const tbody = tbodyMatch[1];

  const rows = [];
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let trMatch;
  while ((trMatch = trRe.exec(tbody)) !== null) {
    const trContent = trMatch[1];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    const tds = [];
    let tdMatch;
    while ((tdMatch = tdRe.exec(trContent)) !== null) tds.push(tdMatch[1]);
    if (tds.length < 7) continue;

    const 지원분야 = stripTags(tds[1]);
    const titleMatch = tds[2].match(/title="([^"]*?)\s*페이지 이동"/);
    const 지원사업명 = titleMatch ? decodeEntities(titleMatch[1]) : stripTags(tds[2]);
    const idMatch = tds[2].match(/pblancId=([^&"]+)/);
    const pblancId = idMatch ? idMatch[1] : `noid-${stripTags(tds[0])}`;
    const 신청기간 = stripTags(tds[3]);

    rows.push({
      pblancId,
      지원분야,
      지원사업명,
      신청기간,
      마감일자: extractDeadline(신청기간),
      '소관부처·지자체': stripTags(tds[4]),
      사업수행기관: stripTags(tds[5]),
      등록일: stripTags(tds[6]),
      url: `${DETAIL_BASE_URL}?pblancId=${pblancId}`,
    });
  }
  return rows;
}

async function fetchAllForKeyword(keyword) {
  const all = [];
  for (let cpage = 1; cpage <= MAX_PAGES; cpage += 1) {
    const html = await fetchPage(keyword, cpage);
    const rows = parseRows(html);
    if (rows.length === 0) break;
    all.push(...rows);
    if (rows.length < ROWS_PER_PAGE) break;
  }
  return all;
}

async function main() {
  console.log(`기업마당(bizinfo.go.kr) 진행중 지원사업 공고를 나라장터와 동일한 키워드 ${KEYWORDS.length}개로 검색`);
  console.log(`키워드: ${KEYWORDS.join(', ')}`);

  const seen = new Map(); // pblancId -> row

  for (const kw of KEYWORDS) {
    try {
      const rows = await fetchAllForKeyword(kw);
      let matched = 0;
      let excluded = 0;
      for (const row of rows) {
        if (isExcluded(row.지원사업명)) { excluded += 1; continue; }
        if (!seen.has(row.pblancId)) {
          seen.set(row.pblancId, row);
          matched += 1;
        }
      }
      console.log(`  "${kw}" -> ${rows.length}건 (신규채택 ${matched}건, 제외 ${excluded}건)`);
    } catch (err) {
      console.error(`  "${kw}" 조회 실패: ${err.message}`);
    }
  }

  const rows = Array.from(seen.values()).map(({ pblancId, ...rest }) => rest);
  rows.sort((a, b) => {
    const da = a.마감일자 || '9999-99-99';
    const db = b.마감일자 || '9999-99-99';
    if (da !== db) return da < db ? -1 : 1;
    return a.지원사업명.localeCompare(b.지원사업명, 'ko');
  });

  const headers = ['지원분야', '지원사업명', '신청기간', '마감일자', '소관부처·지자체', '사업수행기관', '등록일', 'url'];
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  ws['!cols'] = [
    { wch: 10 }, { wch: 55 }, { wch: 22 }, { wch: 12 }, { wch: 18 }, { wch: 22 }, { wch: 12 }, { wch: 55 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '지원사업공고');

  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  const outPath = path.join(OUTPUT_DIR, `bizinfo_지원사업_${stamp}.xlsx`);
  XLSX.writeFile(wb, outPath);

  console.log(`\n총 ${rows.length}건 저장 완료 -> ${outPath}`);
}

main().catch((err) => {
  console.error('실행 실패:', err);
  process.exit(1);
});
