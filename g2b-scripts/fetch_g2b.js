// 나라장터(g2b.go.kr) 입찰공고 주간 수집 스크립트
// 매주 월요일 실행: 최근 7일간 등록된 입찰공고를 키워드로 검색해 Excel로 저장한다.
'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ENV_PATH = path.join(__dirname, '..', 'g2b-k.env');
const OUTPUT_DIR = path.join(__dirname, '..');
const BASE_URL = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService';
const PRESPEC_BASE_URL = 'https://apis.data.go.kr/1230000/ao/HrcspSsstndrdInfoService';

// 업무구분별 오퍼레이션 (키워드 검색 지원 버전 = PPSSrch)
const OPERATIONS = [
  { code: 'getBidPblancListInfoServcPPSSrch', label: '용역' },
  { code: 'getBidPblancListInfoThngPPSSrch', label: '물품' },
  { code: 'getBidPblancListInfoCnstwkPPSSrch', label: '공사' },
  { code: 'getBidPblancListInfoFrgcptPPSSrch', label: '외자' },
  { code: 'getBidPblancListInfoEtcPPSSrch', label: '기타' },
];

// 사전규격(사전공고) 오퍼레이션. 이 API는 bidNtceNm 키워드 파라미터가 서버에서 무시되므로
// 기간 내 전체 목록을 받아온 뒤 KEYWORDS/EXCLUDE_KEYWORDS로 직접 걸러낸다.
const PRESPEC_OPERATIONS = [
  { code: 'getPublicPrcureThngInfoServcPPSSrch', label: '용역(사전규격)' },
  { code: 'getPublicPrcureThngInfoThngPPSSrch', label: '물품(사전규격)' },
  { code: 'getPublicPrcureThngInfoCnstwkPPSSrch', label: '공사(사전규격)' },
  { code: 'getPublicPrcureThngInfoFrgcptPPSSrch', label: '외자(사전규격)' },
];

// 키워드 목록은 keywords.json에서 읽어온다 (keywords-server.js UI로 편집 가능).
// 나라장터 검색은 완전 일치 부분문자열이라 "AI 지식재산" 같은 복합 문구는 그대로 검색 시
// 결과가 0건이라, keywords.json에는 단어 단위로 쪼개 등록해야 한다.
const KEYWORDS_PATH = path.join(__dirname, 'keywords.json');
const { include: KEYWORDS, exclude: EXCLUDE_KEYWORDS } = JSON.parse(fs.readFileSync(KEYWORDS_PATH, 'utf8'));

function isExcluded(name) {
  const n = name || '';
  return EXCLUDE_KEYWORDS.some((w) => n.includes(w));
}

function isMatched(name) {
  const n = name || '';
  return KEYWORDS.some((w) => n.includes(w));
}

function readServiceKey() {
  return fs.readFileSync(ENV_PATH, 'utf8').trim();
}

function fmtDt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

// [inqryBgnDt, inqryEndDt) : 지난 7일 (오늘 포함하지 않는 직전 7일 00:00~23:59 스타일 아님, 실행 시각 기준 -7일 ~ 실행 시각)
function lastWeekRange(now) {
  const end = new Date(now);
  const begin = new Date(now);
  begin.setDate(begin.getDate() - 7);
  return { inqryBgnDt: fmtDt(begin), inqryEndDt: fmtDt(end) };
}

async function callApi(serviceKey, opCode, keyword, bgnDt, endDt, pageNo = 1, numOfRows = 100) {
  const params = new URLSearchParams({
    ServiceKey: serviceKey,
    inqryDiv: '1',
    inqryBgnDt: bgnDt,
    inqryEndDt: endDt,
    type: 'json',
    pageNo: String(pageNo),
    numOfRows: String(numOfRows),
    bidNtceNm: keyword,
  });
  const url = `${BASE_URL}/${opCode}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${opCode} / ${keyword}`);
  }
  const data = await res.json();
  const header = data?.response?.header;
  if (!header || header.resultCode !== '00') {
    throw new Error(`API error for ${opCode} / ${keyword}: ${JSON.stringify(header)}`);
  }
  const body = data.response.body;
  let items = body.items || [];
  if (!Array.isArray(items)) items = [items];
  return { items, totalCount: Number(body.totalCount || 0) };
}

async function fetchAll(serviceKey, opCode, keyword, bgnDt, endDt) {
  const numOfRows = 100;
  let pageNo = 1;
  let all = [];
  while (true) {
    const { items, totalCount } = await callApi(serviceKey, opCode, keyword, bgnDt, endDt, pageNo, numOfRows);
    all = all.concat(items);
    if (all.length >= totalCount || items.length === 0) break;
    pageNo += 1;
  }
  return all;
}

// 사전규격 오퍼레이션은 키워드 파라미터가 무시되므로 전체 목록을 페이지네이션으로 받아온다.
async function callPreSpecApi(serviceKey, opCode, bgnDt, endDt, pageNo, numOfRows) {
  const params = new URLSearchParams({
    ServiceKey: serviceKey,
    inqryDiv: '1',
    inqryBgnDt: bgnDt,
    inqryEndDt: endDt,
    type: 'json',
    pageNo: String(pageNo),
    numOfRows: String(numOfRows),
  });
  const url = `${PRESPEC_BASE_URL}/${opCode}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${opCode}`);
  }
  const data = await res.json();
  const header = data?.response?.header;
  if (!header || header.resultCode !== '00') {
    throw new Error(`API error for ${opCode}: ${JSON.stringify(header)}`);
  }
  const body = data.response.body;
  let items = body.items || [];
  if (!Array.isArray(items)) items = [items];
  return { items, totalCount: Number(body.totalCount || 0) };
}

async function fetchAllPreSpec(serviceKey, opCode, bgnDt, endDt) {
  const numOfRows = 500;
  let pageNo = 1;
  let all = [];
  while (true) {
    const { items, totalCount } = await callPreSpecApi(serviceKey, opCode, bgnDt, endDt, pageNo, numOfRows);
    all = all.concat(items);
    if (all.length >= totalCount || items.length === 0) break;
    pageNo += 1;
  }
  return all;
}

function mapPreSpecRow(item) {
  const 게시일시 = item.rcptDt || '';
  const 의견마감 = item.opninRgstClseDt || '';
  return {
    업무구분: item.bsnsDivNm || '',
    업무여부: 'Y',
    구분: '사전규격공고',
    입찰공고번호: item.bfSpecRgstNo || '',
    공고명: item.prdctClsfcNoNm || '',
    공고기관: item.orderInsttNm || '',
    수요기관: item.rlDminsttNm || '',
    게시일시: 게시일시,
    입찰마감일시: 의견마감, // 사전규격공고는 실제로는 의견등록마감일시 (구분 컬럼이 "사전규격공고"임)
    단계: '',
    세부절차: '',
    세부절차상태: '',
    링크: '', // 사전규격공고는 나라장터 API에 상세페이지 링크 필드가 없어 비워둠 (첨부파일 다운로드 링크는 제외 범위라 넣지 않음)
    _deadline: 의견마감 || null,
  };
}

function mapRow(item, businessLabel) {
  const 게시일시 = item.bidNtceDt || '';
  const 마감일시 = item.bidClseDt || '';
  return {
    업무구분: businessLabel,
    업무여부: 'Y',
    구분: item.ntceKindNm || '',
    입찰공고번호: item.bidNtceNo || '',
    공고명: item.bidNtceNm || '',
    공고기관: item.ntceInsttNm || '',
    수요기관: item.dminsttNm || '',
    게시일시: 게시일시,
    입찰마감일시: 마감일시,
    단계: '',
    세부절차: '',
    세부절차상태: '',
    링크: item.bidNtceDtlUrl || item.bidNtceUrl || '',
    _deadline: 마감일시 || null,
    _postedAt: 게시일시 || null,
  };
}

async function main() {
  const serviceKey = readServiceKey();
  const now = new Date();
  const { inqryBgnDt, inqryEndDt } = lastWeekRange(now);

  console.log(`조회 기간: ${inqryBgnDt} ~ ${inqryEndDt}`);
  console.log(`키워드: ${KEYWORDS.join(', ')}`);

  const seen = new Map(); // key: bidNtceNo|bidNtceOrd -> row

  for (const op of OPERATIONS) {
    for (const kw of KEYWORDS) {
      try {
        const items = await fetchAll(serviceKey, op.code, kw, inqryBgnDt, inqryEndDt);
        let excluded = 0;
        for (const item of items) {
          if (isExcluded(item.bidNtceNm)) { excluded += 1; continue; }
          const key = `${item.bidNtceNo}|${item.bidNtceOrd || '000'}`;
          if (!seen.has(key)) {
            seen.set(key, mapRow(item, op.label));
          }
        }
        console.log(`  [${op.label}] "${kw}" -> ${items.length}건 (제외 ${excluded}건)`);
      } catch (err) {
        console.error(`  [${op.label}] "${kw}" 조회 실패: ${err.message}`);
      }
    }
  }

  console.log('\n사전규격(사전공고) 조회 (서버 키워드 검색 미지원 - 전체 수신 후 직접 필터링):');
  for (const op of PRESPEC_OPERATIONS) {
    try {
      const items = await fetchAllPreSpec(serviceKey, op.code, inqryBgnDt, inqryEndDt);
      let matched = 0;
      let excluded = 0;
      for (const item of items) {
        if (!isMatched(item.prdctClsfcNoNm)) continue;
        if (isExcluded(item.prdctClsfcNoNm)) { excluded += 1; continue; }
        matched += 1;
        const key = `PRESPEC|${item.bfSpecRgstNo}`;
        if (!seen.has(key)) {
          seen.set(key, mapPreSpecRow(item));
        }
      }
      console.log(`  [${op.label}] 전체 ${items.length}건 중 매칭 ${matched}건 (제외 ${excluded}건)`);
    } catch (err) {
      console.error(`  [${op.label}] 조회 실패: ${err.message}`);
    }
  }

  let rows = Array.from(seen.values());

  // 사전규격공고가 이미 정식 등록공고로 전환된 경우(공고명 동일), 사전규격공고 쪽을 제거한다.
  const bidNtceNames = new Set(rows.filter((r) => r.구분 !== '사전규격공고').map((r) => r.공고명));
  const beforeDedup = rows.length;
  rows = rows.filter((r) => !(r.구분 === '사전규격공고' && bidNtceNames.has(r.공고명)));
  const dedupedOut = beforeDedup - rows.length;
  if (dedupedOut > 0) {
    console.log(`\n사전규격공고 중 등록공고와 공고명이 동일한 ${dedupedOut}건 제거`);
  }

  // 같은 입찰공고번호로 등록공고/재공고/변경공고가 여러 건 잡힌 경우, 게시일시가 가장 최근인 1건만 남긴다.
  // (사전규격공고는 입찰공고번호 자리에 별도 ID 체계인 사전규격등록번호가 들어가므로 이 로직에서 제외)
  const byBidNo = new Map();
  for (const r of rows) {
    if (r.구분 === '사전규격공고') continue;
    const list = byBidNo.get(r.입찰공고번호) || [];
    list.push(r);
    byBidNo.set(r.입찰공고번호, list);
  }
  let revisionRemoved = 0;
  const dropSet = new Set();
  for (const [, list] of byBidNo) {
    if (list.length <= 1) continue;
    let latest = list[0];
    for (const r of list) {
      if ((r._postedAt || '') > (latest._postedAt || '')) latest = r;
    }
    for (const r of list) {
      if (r !== latest) dropSet.add(r);
    }
    revisionRemoved += list.length - 1;
  }
  if (revisionRemoved > 0) {
    rows = rows.filter((r) => !dropSet.has(r));
    console.log(`동일 입찰공고번호의 이전 버전(등록공고/재공고/변경공고 등) ${revisionRemoved}건 제거, 최신 게시일시 건만 유지`);
  }

  // 공고명이 같은 취소공고/등록공고 쌍 처리:
  // - 등록공고 게시일시가 더 최신이면 취소공고만 제거하고 등록공고는 유지
  // - 취소공고 게시일시가 더 최신이면(=등록 후 취소된 것) 둘 다 제거
  const byName = new Map();
  for (const r of rows) {
    if (r.구분 !== '등록공고' && r.구분 !== '취소공고') continue;
    const list = byName.get(r.공고명) || [];
    list.push(r);
    byName.set(r.공고명, list);
  }
  const cancelDropSet = new Set();
  let cancelPairsHandled = 0;
  for (const [, list] of byName) {
    const registered = list.filter((r) => r.구분 === '등록공고');
    const cancelled = list.filter((r) => r.구분 === '취소공고');
    if (registered.length === 0 || cancelled.length === 0) continue;
    const latestRegisteredAt = registered.reduce((m, r) => ((r._postedAt || '') > m ? (r._postedAt || '') : m), '');
    const latestCancelledAt = cancelled.reduce((m, r) => ((r._postedAt || '') > m ? (r._postedAt || '') : m), '');
    cancelPairsHandled += 1;
    if (latestRegisteredAt > latestCancelledAt) {
      cancelled.forEach((r) => cancelDropSet.add(r));
    } else {
      registered.forEach((r) => cancelDropSet.add(r));
      cancelled.forEach((r) => cancelDropSet.add(r));
    }
  }
  if (cancelDropSet.size > 0) {
    rows = rows.filter((r) => !cancelDropSet.has(r));
    console.log(`취소공고/등록공고 쌍 ${cancelPairsHandled}건 처리, ${cancelDropSet.size}건 제거`);
  }

  // 입찰마감일(또는 사전규격 의견등록마감일)이 실행 시점보다 지난 건은 제거한다.
  // 마감일 정보가 없는 건은 판단 불가하므로 남겨둔다.
  const beforePastFilter = rows.length;
  rows = rows.filter((r) => {
    if (!r._deadline) return true;
    const d = new Date(r._deadline.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) || d >= now;
  });
  const pastRemoved = beforePastFilter - rows.length;
  if (pastRemoved > 0) {
    console.log(`마감일이 지난 ${pastRemoved}건 제거`);
  }

  // 정렬: 입찰마감일 오름차순 -> 입찰공고명. 마감일 없는 건은 맨 뒤로.
  rows.sort((a, b) => {
    const da = a._deadline || '9999-99-99';
    const db = b._deadline || '9999-99-99';
    if (da !== db) return da < db ? -1 : 1;
    return a.공고명.localeCompare(b.공고명, 'ko');
  });

  rows = rows.map((r) => {
    const { _deadline, _postedAt, ...rest } = r;
    return rest;
  });

  const headers = [
    '업무구분', '업무여부', '구분', '입찰공고번호', '공고명', '공고기관',
    '수요기관', '게시일시', '입찰마감일시', '단계', '세부절차', '세부절차상태', '링크',
  ];
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  ws['!cols'] = [
    { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 16 }, { wch: 50 },
    { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 40 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '입찰공고목록');

  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  const outPath = path.join(OUTPUT_DIR, `g2b_입찰공고_${stamp}.xlsx`);
  XLSX.writeFile(wb, outPath);

  console.log(`\n총 ${rows.length}건 저장 완료 -> ${outPath}`);
}

main().catch((err) => {
  console.error('실행 실패:', err);
  process.exit(1);
});
