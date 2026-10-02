// 기업마당(bizinfo.go.kr) 지원사업 공고 주간 수집 스크립트
// 매주 월요일 실행: 인력·경영 분야 진행중인 지원사업 공고 중
//   1) 용산구 관련 공고 (우선순위)
//   2) 그 외에는 지역구분이 없는(전국 대상) 공고만
// 을 수집한다. 경기도 등 다른 특정 지역 공고는 제외한다.
'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const OUTPUT_DIR = path.join(__dirname, '..');
const BASE_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do';

// 지원분야 필터 (사이트 hashCode 값)
const FIELDS = [
  { hashCode: '03', label: '인력' },
  { hashCode: '10', label: '경영' },
];

const SEOUL_CODE = '6110000';
// 사이트가 제공하는 16개 시/도 지역 코드 전체 (지역이 명시된 공고를 가려내기 위한 기준 집합)
const ALL_AREA_CODES = [
  '6110000', // 서울
  '6260000', // 부산
  '6270000', // 대구
  '6280000', // 인천
  '6130000', // 전남광주
  '6300000', // 대전
  '6310000', // 울산
  '5690000', // 세종
  '6410000', // 경기
  '6420000', // 강원
  '6430000', // 충북
  '6440000', // 충남
  '6450000', // 전북
  '6470000', // 경북
  '6480000', // 경남
  '6500000', // 제주
].join(',');

const YONGSAN_KEYWORD = '용산';
const ROWS_PER_PAGE = 15;
const MAX_PAGES = 40; // 안전장치 (무한루프 방지)

// 지원사업명에 아래 단어가 포함되면 분야·지역 조건과 무관하게 제외한다.
const EXCLUDE_KEYWORDS = ['제조', '대경권', '장애인', '강원', '영동권', '의료기기산업', '외국전문인력'];

const DETAIL_BASE_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do';

function isExcluded(title) {
  return EXCLUDE_KEYWORDS.some((w) => title.includes(w));
}

// 지원사업명 맨 앞 대괄호(예: "[경기]", "[서울ㆍ경기ㆍ인천ㆍ강원]", "[비수도권]", "[호남권]")는
// bizinfo에서 예외 없이 지역 표시 용도로 쓰인다. 자체 지역코드 필터에 안 걸리더라도
// (중앙부처 시행사업 등) 대괄호가 있으면 지역이 지정된 공고로 간주한다.
const REGION_BRACKET_PATTERN = /^\[[^\]]+\]/;

function hasRegionTagInTitle(title) {
  return REGION_BRACKET_PATTERN.test(title);
}

function buildUrl(hashCode, areaCodes, cpage) {
  const params = new URLSearchParams({
    hashCode,
    rowsSel: '6',
    rows: String(ROWS_PER_PAGE),
    cpage: String(cpage),
    cat: '',
    schJrsdCodeTy: '',
    schWntyAt: '',
    schAreaDetailCodes: areaCodes,
    schEndAt: 'N', // 마감 제외 (진행중인 공고만)
    orderGb: '',
    sort: '',
    schPblancDiv: '',
    condition: 'searchPblancNm',
    condition1: 'AND',
    preKeywords: '',
    keyword: '',
  });
  return `${BASE_URL}?${params.toString()}`;
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

// 신청기간(예: "2026-07-28 ~ 2026-08-11")에서 마감일자를 추출한다.
// "예산 소진시까지", "상시 접수" 등 고정 마감일이 없는 경우는 빈 문자열을 반환한다.
function extractDeadline(신청기간) {
  const m = String(신청기간 || '').match(/~\s*(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

const SUMMARY_MAX_LEN = 120;

// 상세페이지의 "사업개요" 영역 첫 문단을 간단 요약으로 사용한다.
async function fetchSummary(pblancId) {
  const res = await fetch(`${DETAIL_BASE_URL}?pblancId=${pblancId}`);
  if (!res.ok) return '';
  const html = await res.text();
  const sectionMatch = html.match(/<span class="s_title">사업개요<\/span>\s*<div class="txt">([\s\S]*?)<\/div>\s*<\/li>/);
  if (!sectionMatch) return '';
  const pMatches = sectionMatch[1].match(/<p[^>]*>([\s\S]*?)<\/p>/g) || [];
  for (const p of pMatches) {
    const text = stripTags(p);
    if (text) {
      return text.length > SUMMARY_MAX_LEN ? `${text.slice(0, SUMMARY_MAX_LEN)}...` : text;
    }
  }
  return '';
}

// 동시 실행 개수를 제한하며 items를 처리한다 (사이트 부하 방지).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = '';
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function fetchPage(hashCode, areaCodes, cpage) {
  const url = buildUrl(hashCode, areaCodes, cpage);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for hashCode=${hashCode} areaCodes=${areaCodes} cpage=${cpage}`);
  }
  return res.text();
}

function parseRows(html, fieldLabel) {
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
    while ((tdMatch = tdRe.exec(trContent)) !== null) {
      tds.push(tdMatch[1]);
    }
    if (tds.length < 8) continue;

    const 지원분야 = stripTags(tds[1]) || fieldLabel;
    const titleMatch = tds[2].match(/title="([^"]*?)\s*페이지 이동"/);
    const 지원사업명 = titleMatch ? decodeEntities(titleMatch[1]) : stripTags(tds[2]);
    const idMatch = tds[2].match(/pblancId=([^&"]+)/);
    const pblancId = idMatch ? idMatch[1] : `${fieldLabel}-${stripTags(tds[0])}`;
    const 신청기간 = stripTags(tds[3]);
    const 소관부처지자체 = stripTags(tds[4]);
    const 사업수행기관 = stripTags(tds[5]);
    const 등록일 = stripTags(tds[6]);

    rows.push({
      pblancId,
      지원분야,
      지원사업명,
      신청기간,
      마감일자: extractDeadline(신청기간),
      '소관부처·지자체': 소관부처지자체,
      사업수행기관,
      등록일,
      url: `${DETAIL_BASE_URL}?pblancId=${pblancId}`,
    });
  }
  return rows;
}

async function fetchAll(hashCode, areaCodes, fieldLabel) {
  const all = [];
  for (let cpage = 1; cpage <= MAX_PAGES; cpage += 1) {
    const html = await fetchPage(hashCode, areaCodes, cpage);
    const rows = parseRows(html, fieldLabel);
    if (rows.length === 0) break;
    all.push(...rows);
    if (rows.length < ROWS_PER_PAGE) break; // 마지막 페이지
  }
  return all;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSectionHtml(fieldLabel, fieldRows) {
  if (fieldRows.length === 0) return '';
  const rowsHtml = fieldRows.map((r) => {
    const badgeClass = r.구분 === '용산구' ? 'badge badge-yongsan' : 'badge badge-nationwide';
    return `
        <tr>
          <td><span class="${badgeClass}">${escapeHtml(r.구분)}</span></td>
          <td class="title-cell"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.지원사업명)}</a></td>
          <td class="summary-cell">${escapeHtml(r.내용요약)}</td>
          <td>${escapeHtml(r.신청기간)}</td>
          <td>${escapeHtml(r.마감일자)}</td>
          <td>${escapeHtml(r['소관부처·지자체'])}</td>
          <td>${escapeHtml(r.사업수행기관)}</td>
          <td>${escapeHtml(r.등록일)}</td>
        </tr>`;
  }).join('');

  return `
    <section class="field-section">
      <h2>${escapeHtml(fieldLabel)} <span class="count">${fieldRows.length}건</span></h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>구분</th>
              <th>지원사업명</th>
              <th>내용요약</th>
              <th>신청기간</th>
              <th>마감일자</th>
              <th>소관부처·지자체</th>
              <th>사업수행기관</th>
              <th>등록일</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}
          </tbody>
        </table>
      </div>
    </section>`;
}

function buildHtml(rows, dateLabel) {
  const gyeongyeong = rows.filter((r) => r.지원분야 === '경영');
  const inryeok = rows.filter((r) => r.지원분야 === '인력');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>기업마당 지원사업 공고 - ${escapeHtml(dateLabel)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f8fa;
    --card-bg: #ffffff;
    --text: #1a1a1a;
    --muted: #6b7280;
    --border: #e5e7eb;
    --accent: #2563eb;
    --stripe: #f9fafb;
    --badge-yongsan-bg: #fee2e2;
    --badge-yongsan-text: #991b1b;
    --badge-nationwide-bg: #dbeafe;
    --badge-nationwide-text: #1e40af;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115;
      --card-bg: #181b21;
      --text: #e6e6e6;
      --muted: #9aa1ab;
      --border: #2a2e37;
      --accent: #60a5fa;
      --stripe: #1d2129;
      --badge-yongsan-bg: #4c1d1d;
      --badge-yongsan-text: #fca5a5;
      --badge-nationwide-bg: #1e3a5f;
      --badge-nationwide-text: #93c5fd;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif;
    line-height: 1.5;
  }
  .page { max-width: 1400px; margin: 0 auto; }
  header { margin-bottom: 24px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  .subtitle { color: var(--muted); font-size: 0.9rem; }
  .field-section {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 20px;
  }
  h2 { font-size: 1.15rem; margin: 0 0 12px; }
  .count { color: var(--muted); font-weight: normal; font-size: 0.9rem; }
  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
  th { color: var(--muted); font-weight: 600; white-space: nowrap; }
  tbody tr:nth-child(even) { background: var(--stripe); }
  .title-cell { min-width: 220px; }
  .title-cell a { color: var(--accent); text-decoration: none; }
  .title-cell a:hover { text-decoration: underline; }
  .summary-cell { min-width: 260px; color: var(--muted); }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .badge-yongsan { background: var(--badge-yongsan-bg); color: var(--badge-yongsan-text); }
  .badge-nationwide { background: var(--badge-nationwide-bg); color: var(--badge-nationwide-text); }
</style>
</head>
<body>
  <div class="page">
    <header>
      <h1>기업마당 지원사업 공고</h1>
      <div class="subtitle">${escapeHtml(dateLabel)} 기준 · 총 ${rows.length}건 · 용산구 우선 + 전국(지역구분 없음) 공고</div>
    </header>
    ${buildSectionHtml('경영', gyeongyeong)}
    ${buildSectionHtml('인력', inryeok)}
  </div>
</body>
</html>
`;
}

async function main() {
  console.log('조회 조건: 분야 = 인력·경영, 상태 = 진행중(마감 제외)');
  console.log('필터: 용산구 관련 공고 우선 + 그 외 지역구분 없는(전국 대상) 공고만 (경기도 등 특정 지역 공고 제외)');

  const finalRows = new Map(); // pblancId -> row (with 구분 태그)

  for (const field of FIELDS) {
    // 1) 전체(지역 필터 없음) - 지역구분 없는 공고를 가려내기 위한 기준
    const allRows = await fetchAll(field.hashCode, '', field.label);
    // 2) 16개 시/도 전체 필터 - 지역이 명시된 공고 전체
    const regionalRows = await fetchAll(field.hashCode, ALL_AREA_CODES, field.label);
    const regionalIds = new Set(regionalRows.map((r) => r.pblancId));
    // 3) 서울만 필터 - 용산구 언급 공고를 가려내기 위한 기준
    const seoulRows = await fetchAll(field.hashCode, SEOUL_CODE, field.label);

    let yongsanCount = 0;
    let excludedCount = 0;
    for (const row of seoulRows) {
      if (row.지원사업명.includes(YONGSAN_KEYWORD)) {
        if (isExcluded(row.지원사업명)) { excludedCount += 1; continue; }
        finalRows.set(row.pblancId, { ...row, 구분: '용산구' });
        yongsanCount += 1;
      }
    }

    let nationwideCount = 0;
    for (const row of allRows) {
      if (
        !regionalIds.has(row.pblancId)
        && !finalRows.has(row.pblancId)
        && !hasRegionTagInTitle(row.지원사업명)
      ) {
        if (isExcluded(row.지원사업명)) { excludedCount += 1; continue; }
        finalRows.set(row.pblancId, { ...row, 구분: '전국(지역구분 없음)' });
        nationwideCount += 1;
      }
    }

    console.log(`  [${field.label}] 전체 ${allRows.length}건 / 지역표시 ${regionalRows.length}건 -> 용산구 ${yongsanCount}건, 전국(지역구분 없음) ${nationwideCount}건 채택 (제외키워드 매칭 ${excludedCount}건 제외)`);
  }

  const withoutSummary = Array.from(finalRows.values());

  console.log(`\n상세페이지에서 내용 요약 수집 중... (${withoutSummary.length}건)`);
  const summaries = await mapWithConcurrency(withoutSummary, 5, (row) => fetchSummary(row.pblancId));

  const rows = withoutSummary.map(({ pblancId, ...rest }, i) => ({ ...rest, 내용요약: summaries[i] }));

  // 지원분야별로 모아서(경영 -> 인력), 그 안에서는 마감일자 오름차순, 공고명 가나다순 정렬
  const FIELD_ORDER = { 경영: 0, 인력: 1 };
  rows.sort((a, b) => {
    const fieldDiff = (FIELD_ORDER[a.지원분야] ?? 99) - (FIELD_ORDER[b.지원분야] ?? 99);
    if (fieldDiff !== 0) return fieldDiff;
    const da = a.마감일자 || '9999-99-99'; // 마감일자 없는 공고는 뒤로
    const db = b.마감일자 || '9999-99-99';
    if (da !== db) return da.localeCompare(db);
    return a.지원사업명.localeCompare(b.지원사업명, 'ko');
  });

  const headers = ['구분', '지원분야', '지원사업명', '내용요약', '신청기간', '마감일자', '소관부처·지자체', '사업수행기관', '등록일', 'url'];
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  ws['!cols'] = [
    { wch: 16 }, { wch: 8 }, { wch: 60 }, { wch: 60 }, { wch: 24 }, { wch: 12 }, { wch: 14 }, { wch: 22 }, { wch: 12 }, { wch: 60 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '지원사업공고');

  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  const dateLabel = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const outPath = path.join(OUTPUT_DIR, `bizinfo_지원사업공고_${stamp}.xlsx`);
  XLSX.writeFile(wb, outPath);

  const htmlPath = path.join(OUTPUT_DIR, `bizinfo_지원사업공고_${stamp}.html`);
  fs.writeFileSync(htmlPath, buildHtml(rows, dateLabel), 'utf8');

  console.log(`\n총 ${rows.length}건 저장 완료 -> ${outPath}`);
  console.log(`웹 페이지 저장 완료 -> ${htmlPath}`);
}

main().catch((err) => {
  console.error('실행 실패:', err);
  process.exit(1);
});
