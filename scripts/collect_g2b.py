#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
나라장터(g2b.go.kr) 입찰공고정보서비스(BidPublicInfoService) Open API에서
입찰공고를 수집해 data/records.json / data/meta.json 을 갱신하는 스크립트.

- 실행 주체: GitHub Actions (.github/workflows/collect.yml, 매일 1회)
- 필요 환경변수: G2B_SERVICE_KEY (data.go.kr에서 발급받은 서비스키,
  GitHub Actions Secret으로 등록되어 있어야 함)

과거에는 PubDataOpnStdService(공공데이터개방표준서비스)를 호출했으나, 해당
서비스는 이 키로 활용신청이 되어 있지 않아 "서비스 접근 거부" 오류로 계속
실패했다. BidPublicInfoService는 같은 서비스키로 이미 정상 동작이 확인된
엔드포인트이므로 이걸로 교체한다(/g2b-scripts/fetch_g2b.js 와 동일 패턴).

이 API는 bidNtceNm(공고명) 키워드가 완전 일치 부분문자열 검색이라, 복합
문구가 아닌 단어 단위로 KEYWORDS에 등록해야 한다. KEYWORDS/EXCLUDE_KEYWORDS는
g2b-scripts/keywords.json 과 동일한 목록을 유지한다(해당 파일을 수정하면
여기도 같이 갱신할 것).
"""

import http.client
import json
import os
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))

BASE_URL = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService"

# 업무구분별 오퍼레이션 (키워드 검색 지원 버전 = PPSSrch)
OPERATIONS = [
    ("getBidPblancListInfoServcPPSSrch", "용역"),
    ("getBidPblancListInfoThngPPSSrch", "물품"),
    ("getBidPblancListInfoCnstwkPPSSrch", "공사"),
    ("getBidPblancListInfoFrgcptPPSSrch", "외자"),
    ("getBidPblancListInfoEtcPPSSrch", "기타"),
]

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(os.path.dirname(SCRIPTS_DIR), "data")
KEYWORDS_PATH = os.path.join(SCRIPTS_DIR, "keywords.json")

with open(KEYWORDS_PATH, "r", encoding="utf-8") as f:
    _kw_config = json.load(f)

KEYWORD_AREAS = {item["keyword"]: item["area"] for item in _kw_config["include"]}
KEYWORDS = list(KEYWORD_AREAS.keys())
EXCLUDE_KEYWORDS = _kw_config["exclude"]

RECORDS_PATH = os.path.join(DATA_DIR, "records.json")
META_PATH = os.path.join(DATA_DIR, "meta.json")

# 오래된 레코드가 무한히 쌓이지 않도록, 게시일시 기준 이 일수보다 오래된
# 레코드는 매 실행 시 정리합니다 (원문 공고는 어차피 마감되므로 보관 의미가 적음).
RETENTION_DAYS = 120

# 매일 실행되지만, 누락 방지를 위해 최근 10일치를 겹치게 조회합니다.
LOOKBACK_DAYS = 12

# 일시적 오류 재시도: 최대 3회 재시도, 재시도 전 대기 시간(초)
RETRY_SLEEPS = [2, 5, 10]
RETRY_HTTP_CODES = {403, 429, 500, 502, 503, 504}
# (operation, keyword) 호출 사이의 간격(초) - 연속 호출로 인한 속도 제한 완화
CALL_INTERVAL_SEC = 0.5


class RangeError(RuntimeError):
    """API 오류 코드 07(입력범위값 초과) — 조회기간·건수 조건을 줄이면 해결되는 오류."""


class TransientError(Exception):
    """재시도할 가치가 있는 일시적 오류 (HTTP 403/429/5xx, 네트워크 오류, 타임아웃, JSON이 아닌 응답)."""


def _http_get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "bizsc-collector/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read()
    except urllib.error.HTTPError as e:
        if e.code in RETRY_HTTP_CODES:
            raise TransientError(f"HTTP {e.code} {e.reason}") from None
        raise
    except (urllib.error.URLError, OSError, http.client.HTTPException) as e:
        raise TransientError(f"네트워크 오류 ({type(e).__name__})") from None

    try:
        return json.loads(body.decode("utf-8"))
    except ValueError:
        # JSONDecodeError / UnicodeDecodeError 모두 ValueError 하위 클래스
        raise TransientError("JSON이 아닌 응답 (HTML 오류 페이지 등)") from None


def api_request(service_key: str, op_code: str, params: dict) -> dict:
    # 이미 URL 인코딩된 키(Encoding 키)는 그대로 쓰고, 원본 키는 인코딩한다 (이중 인코딩 방지)
    key_part = service_key if "%" in service_key else urllib.parse.quote_plus(service_key)
    query = {
        "type": "json",
        **params,
    }
    url = f"{BASE_URL}/{op_code}?ServiceKey={key_part}&{urllib.parse.urlencode(query)}"

    for attempt in range(len(RETRY_SLEEPS) + 1):
        try:
            return _http_get_json(url)
        except TransientError as e:
            if attempt >= len(RETRY_SLEEPS):
                # 로그에 URL(서비스키 포함)을 남기지 않도록 요약 메시지만 전달
                raise RuntimeError(f"재시도 {len(RETRY_SLEEPS)}회 후에도 실패: {e}") from None
            wait = RETRY_SLEEPS[attempt]
            print(f"  [재시도 {attempt + 1}/{len(RETRY_SLEEPS)}] {e} → {wait}초 후 다시 시도",
                  file=sys.stderr, flush=True)
            time.sleep(wait)


ERROR_MESSAGES = {
    "01": "Application Error - 서비스 제공 상태가 원활하지 않습니다",
    "02": "DB Error - 서비스 제공 상태가 원활하지 않습니다",
    "03": "No Data - 데이터가 없습니다",
    "04": "HTTP Error - 서비스 제공 상태가 원활하지 않습니다",
    "05": "Service timeout - 서비스 시간 초과",
    "06": "날짜 형식 오류",
    "07": "입력값 범위 초과",
    "08": "필수값 누락",
    "10": "ServiceKey 파라미터 누락",
    "11": "필수 파라미터 누락",
    "12": "해당 서비스가 없거나 폐기됨",
    "20": "서비스 접근 거부 - API 활용 승인 필요",
    "22": "일일 트래픽 초과",
    "30": "등록되지 않은 서비스키",
    "31": "기한 만료된 서비스키",
    "32": "등록되지 않은 도메인 또는 IP",
}


def _find_header(obj, depth=0):
    """응답 어디에 있든 resultCode를 가진 header를 찾는다.
    정상 응답은 {"response": {"header": ...}} 이지만, 오류 응답은
    {"nkoneps.com.response.ResponseError": {"header": ...}} 등 다른 형태로 온다."""
    if not isinstance(obj, dict) or depth > 4:
        return None
    h = obj.get("header")
    if isinstance(h, dict) and "resultCode" in h:
        return h
    if "resultCode" in obj:
        return obj
    for v in obj.values():
        found = _find_header(v, depth + 1)
        if found:
            return found
    return None


def unwrap_items(data: dict):
    response = data.get("response") if isinstance(data, dict) else None
    header = _find_header(data) or {}
    code = str(header.get("resultCode", "")).strip()

    if code == "03":
        # No Data는 오류가 아니라 "해당 기간에 결과 없음"으로 처리
        return [], 0

    if code not in ("00", "0", "000"):
        # 헤더가 아예 없거나 정상 코드가 아니면 오류로 본다 (이전에는 빈 결과로 조용히 넘어갔음)
        msg = ERROR_MESSAGES.get(code, header.get("resultMsg") or header.get("returnAuthMsg") or "")
        snippet = json.dumps(data, ensure_ascii=False)[:300]
        if code == "07":
            raise RangeError(f"API 오류 (코드 07): {msg} | 응답: {snippet}")
        raise RuntimeError(f"API 오류 (코드 {code or '없음'}): {msg} | 응답: {snippet}")

    body = (response or {}).get("body", {}) or {}
    items = body.get("items", [])
    if isinstance(items, dict) and "item" in items:
        item_list = items["item"]
        if not isinstance(item_list, list):
            item_list = [item_list]
    elif isinstance(items, list):
        item_list = items
    else:
        item_list = []

    total_count = int(body.get("totalCount", 0) or 0)
    return item_list, total_count


_SAMPLE_LOGGED = False


def fetch_all(service_key: str, op_code: str, keyword: str, begin_dt: str, end_dt: str,
              num_of_rows: int = 100):
    all_items = []
    page_no = 1
    while True:
        data = api_request(service_key, op_code, {
            "inqryDiv": "1",
            "inqryBgnDt": begin_dt,
            "inqryEndDt": end_dt,
            "pageNo": page_no,
            "numOfRows": num_of_rows,
            "bidNtceNm": keyword,
        })
        global _SAMPLE_LOGGED
        if not _SAMPLE_LOGGED:
            _SAMPLE_LOGGED = True
            print(f"[응답 예시] {json.dumps(data, ensure_ascii=False)[:400]}", flush=True)
        items, total_count = unwrap_items(data)
        all_items.extend(items)
        if len(all_items) >= total_count or not items:
            break
        page_no += 1
        time.sleep(0.2)
    return all_items


# 2026-11-10 무렵부터 API가 기존 조건(10일 기간, 종료시각 당일 23:59, 100건/페이지)에
# 오류 07(입력범위값 초과)을 반환하기 시작했다. 허용 범위가 공지 없이 바뀔 수 있으므로,
# 실행할 때마다 아래 후보를 순서대로 시험해 처음 통과하는 조건으로 수집한다.
#   (조회기간 일수, 종료시각을 현재시각으로 제한할지, 페이지당 건수)
QUERY_CANDIDATES = [
    (LOOKBACK_DAYS, True, 100),
    (7, True, 100),
    (3, True, 100),
    (1, True, 100),
    (1, True, 50),
    (1, True, 10),
    (LOOKBACK_DAYS, False, 100),  # 예전 방식
]


def build_windows(now, window_days: int, end_now: bool):
    """최근 LOOKBACK_DAYS 를 window_days 단위 구간으로 나눈다. (최신 구간부터)"""
    start_all = (now - timedelta(days=LOOKBACK_DAYS)).replace(hour=0, minute=0, second=0, microsecond=0)
    end_all = now if end_now else now.replace(hour=23, minute=59)
    windows = []
    end = end_all
    while end > start_all:
        start = max(start_all, end - timedelta(days=window_days) + timedelta(minutes=1))
        windows.append((start.strftime("%Y%m%d%H%M"), end.strftime("%Y%m%d%H%M")))
        end = start - timedelta(minutes=1)
    return windows


def probe_query_config(service_key: str, now):
    op_code = OPERATIONS[0][0]
    kw = KEYWORDS[0]
    for window_days, end_now, rows in QUERY_CANDIDATES:
        b, e = build_windows(now, window_days, end_now)[0]
        try:
            fetch_all(service_key, op_code, kw, b, e, rows)
            print(f"[조회조건 확인] 기간 {window_days}일 단위 / 종료시각 {'현재' if end_now else '당일 23:59'} / "
                  f"{rows}건씩 → 사용 가능", flush=True)
            return window_days, end_now, rows
        except RangeError as ex:
            print(f"[조회조건 확인] 기간 {window_days}일 / 종료 {'현재' if end_now else '23:59'} / {rows}건 → {ex}",
                  file=sys.stderr, flush=True)
        time.sleep(CALL_INTERVAL_SEC)
    return None


def is_excluded(title: str) -> bool:
    title = title or ""
    return any(kw in title for kw in EXCLUDE_KEYWORDS)


def map_item(item: dict, business_label: str, keyword: str) -> dict:
    return {
        "업무구분": business_label,
        "검색키워드": keyword,
        "검색영역": KEYWORD_AREAS.get(keyword, ""),
        "구분": item.get("ntceKindNm", ""),
        "입찰공고번호": item.get("bidNtceNo", ""),
        "공고명": item.get("bidNtceNm", ""),
        "공고기관": item.get("ntceInsttNm", ""),
        "수요기관": item.get("dminsttNm", "") or item.get("ntceInsttNm", ""),
        "게시일시": item.get("bidNtceDt", ""),
        "입찰마감일시": item.get("bidClseDt", ""),
        "링크": item.get("bidNtceDtlUrl") or item.get("bidNtceUrl") or "",
    }


def dedup_key(row: dict):
    return (row.get("입찰공고번호", ""), row.get("구분", ""), row.get("게시일시", ""))


def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))


def main():
    service_key = os.environ.get("G2B_SERVICE_KEY", "").strip()
    if not service_key:
        print("환경변수 G2B_SERVICE_KEY 가 설정되지 않았습니다. "
              "GitHub Actions Secret에 등록된 값이 워크플로에서 전달되고 있는지 확인하세요.",
              file=sys.stderr, flush=True)
        sys.exit(1)
    print(f"[서비스키] 길이 {len(service_key)}자로 확인됨", flush=True)

    now = datetime.now(KST)
    config = probe_query_config(service_key, now)
    if not config:
        print("모든 조회조건 후보가 오류 07(입력범위값 초과)로 거부되었습니다. data.go.kr의 "
              "입찰공고정보서비스 명세 변경 여부를 확인하세요.", file=sys.stderr, flush=True)
        sys.exit(1)
    window_days, end_now, num_rows = config
    windows = build_windows(now, window_days, end_now)
    print(f"[수집 범위] {windows[-1][0]} ~ {windows[0][1]} ({len(windows)}개 구간)", flush=True)

    raw_count = 0
    filtered = []
    seen_in_run = set()
    total_calls = len(OPERATIONS) * len(KEYWORDS)
    succeeded_calls = 0
    failed_calls = []

    for op_code, business_label in OPERATIONS:
        for kw in KEYWORDS:
            time.sleep(CALL_INTERVAL_SEC)
            print(f"[조회] {business_label} / {kw}", flush=True)
            try:
                items = []
                for begin_dt, end_dt in windows:
                    items.extend(fetch_all(service_key, op_code, kw, begin_dt, end_dt, num_rows))
                    if len(windows) > 1:
                        time.sleep(0.2)
            except Exception as e:
                # 한 호출의 실패로 전체 실행을 중단하지 않고, 기록만 남기고 다음으로 진행
                failed_calls.append(f"{op_code}/{kw}")
                print(f"[실패] {business_label} / {kw} (건너뜀): {e}",
                      file=sys.stderr, flush=True)
                continue

            succeeded_calls += 1
            raw_count += len(items)
            for item in items:
                title = item.get("bidNtceNm", "")
                if is_excluded(title):
                    continue
                key = (item.get("bidNtceNo", ""), item.get("bidNtceOrd", "000"))
                if key in seen_in_run:
                    continue
                seen_in_run.add(key)
                filtered.append(map_item(item, business_label, kw))

    print(f"[호출 결과] 성공 {succeeded_calls}/{total_calls}건, 실패 {len(failed_calls)}건",
          flush=True)
    if failed_calls:
        print(f"[실패 목록] {', '.join(failed_calls)}", file=sys.stderr, flush=True)
    if succeeded_calls == 0:
        print("모든 API 호출이 실패하여 데이터를 저장하지 않고 종료합니다.",
              file=sys.stderr, flush=True)
        sys.exit(1)

    print(f"[API 원본 수신] {raw_count}건 (업무구분×키워드 조회 총합, 중복 포함)")
    if raw_count == 0:
        # 10일치 × 75개 조회가 모두 0건인 것은 정상적이지 않다 (2026-11-10 이후 이런 상태로
        # '성공' 처리되며 데이터가 멈춰 있었음). 기존 데이터를 보존하고 실패로 종료해 알림이 가게 한다.
        print("모든 조회 결과가 0건입니다. API 응답 형식이나 서비스키 상태를 확인하세요 "
              "(위 [응답 예시] 참고). 데이터를 저장하지 않고 종료합니다.", file=sys.stderr, flush=True)
        sys.exit(1)
    print(f"[키워드 필터 통과] {len(filtered)}건")

    existing = load_json(RECORDS_PATH, [])
    existing_keys = {dedup_key(r) for r in existing}

    new_rows = [r for r in filtered if dedup_key(r) not in existing_keys]
    print(f"[신규 레코드] {len(new_rows)}건")

    merged = existing + new_rows

    # 보관 기간이 지난 오래된 레코드 정리
    cutoff = now - timedelta(days=RETENTION_DAYS)
    cutoff_str = cutoff.strftime("%Y-%m-%d")

    def is_recent(row):
        posted = row.get("게시일시", "")
        return (not posted) or (posted[:10] >= cutoff_str)

    merged = [r for r in merged if is_recent(r)]

    # 게시일시 내림차순 정렬
    merged.sort(key=lambda r: r.get("게시일시", ""), reverse=True)

    save_json(RECORDS_PATH, merged)
    print(f"[저장 완료] data/records.json 총 {len(merged)}건")

    meta = load_json(META_PATH, {})
    meta["raw_count"] = raw_count
    meta["last_collected_at"] = now.isoformat()
    meta["pub_snapshot_date"] = now.strftime("%Y-%m-%d")
    meta["source"] = "나라장터(g2b.go.kr) 입찰공고정보서비스(BidPublicInfoService) Open API"
    meta["failed_calls"] = failed_calls
    save_json(META_PATH, meta)
    print("[저장 완료] data/meta.json")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException:
        print("예상치 못한 오류로 중단되었습니다:", file=sys.stderr, flush=True)
        traceback.print_exc()
        sys.stderr.flush()
        sys.exit(1)
