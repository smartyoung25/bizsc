#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
나라장터(g2b.go.kr) 공공데이터개방표준서비스 Open API에서
입찰공고정보(getDataSetOpnStdBidPblancInfo)를 수집해
data/records.json / data/meta.json 을 갱신하는 스크립트.

- 실행 주체: GitHub Actions (.github/workflows/collect.yml, 매주 1회)
- 필요 환경변수: G2B_SERVICE_KEY (data.go.kr에서 발급받은 서비스키,
  GitHub Actions Secret으로 등록되어 있어야 함)

이 스크립트는 나라장터 전체 공고가 아니라, 대시보드가 다루는 주제
(창업·기술사업화·지식재산·산학협력·R&D 등)에 해당하는 공고만
공고명(bidNtceNm) 키워드 매칭으로 걸러서 저장합니다.
필요에 따라 KEYWORDS 목록을 조정하세요.
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))

BASE_URL = "https://apis.data.go.kr/1230000/ao/PubDataOpnStdService"
ENDPOINT = "getDataSetOpnStdBidPblancInfo"

# 대시보드가 다루는 주제와 맞는 공고만 남기기 위한 키워드 필터.
# 공고명(bidNtceNm)에 아래 키워드 중 하나라도 포함되면 수집 대상으로 봅니다.
KEYWORDS = [
    "창업", "기술사업화", "지식재산", "특허", "산학협력", "기술개발",
    "기술이전", "벤처", "스타트업", "기술지원", "기술평가", "R&D",
    "연구개발", "사업화", "기술혁신", "기술료", "지식재산권", "발명",
    "농업기술", "농산업", "스마트팜",
]

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
RECORDS_PATH = os.path.join(DATA_DIR, "records.json")
META_PATH = os.path.join(DATA_DIR, "meta.json")

# 오래된 레코드가 무한히 쌓이지 않도록, 게시일시 기준 이 일수보다 오래된
# 레코드는 매 실행 시 정리합니다 (원문 공고는 어차피 마감되므로 보관 의미가 적음).
RETENTION_DAYS = 120

# API는 1회 호출당 입찰공고일시 범위를 최대 1개월로 제한합니다.
# 매주 실행되므로 최근 10일치를 겹치게 조회해 유실을 방지합니다.
LOOKBACK_DAYS = 10


def api_request(service_key: str, params: dict) -> dict:
    query = {
        "ServiceKey": service_key,
        "type": "json",
        **params,
    }
    url = f"{BASE_URL}/{ENDPOINT}?{urllib.parse.urlencode(query)}"
    req = urllib.request.Request(url, headers={"User-Agent": "bizsc-collector/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8")
    return json.loads(raw)


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


def unwrap_items(data: dict):
    response = data.get("response", data)
    header = response.get("header", {})
    code = str(header.get("resultCode", ""))

    if code == "03":
        # No Data는 오류가 아니라 "해당 기간에 결과 없음"으로 처리
        return [], 0

    if code not in ("00", ""):
        msg = ERROR_MESSAGES.get(code, header.get("resultMsg", "알 수 없는 오류"))
        raise RuntimeError(f"API 오류 (코드 {code}): {msg}")

    body = response.get("body", {})
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


def fetch_all(service_key: str, begin_dt: str, end_dt: str):
    all_items = []
    page_no = 1
    num_of_rows = 500
    while True:
        data = api_request(service_key, {
            "bidNtceBgnDt": begin_dt,
            "bidNtceEndDt": end_dt,
            "numOfRows": num_of_rows,
            "pageNo": page_no,
        })
        items, total_count = unwrap_items(data)
        all_items.extend(items)
        if len(all_items) >= total_count or not items:
            break
        page_no += 1
        time.sleep(0.3)
    return all_items


def fmt_datetime(date_str, time_str=None):
    """API의 날짜(YYYYMMDD)/시간(HHMM) 필드를 'YYYY-MM-DD HH:MM:SS' 형태로 정규화."""
    if not date_str:
        return ""
    date_str = str(date_str).strip()
    # 이미 'YYYY-MM-DD ...' 형태로 오는 필드도 있음
    if "-" in date_str:
        return date_str[:19]
    if len(date_str) != 8:
        return date_str
    y, m, d = date_str[0:4], date_str[4:6], date_str[6:8]
    hh, mm = "00", "00"
    if time_str:
        time_str = str(time_str).strip()
        if len(time_str) >= 4:
            hh, mm = time_str[0:2], time_str[2:4]
    return f"{y}-{m}-{d} {hh}:{mm}:00"


def build_link(item: dict) -> str:
    url = item.get("bidNtceUrl") or ""
    if url:
        return url
    # bidNtceUrl이 없는 경우, 공고번호 기반으로 g2b 상세 링크를 재구성 (베스트 에포트)
    bid_no = item.get("bidNtceNo") or ""
    bid_ord = item.get("bidNtceOrd") or "000"
    if not bid_no:
        return ""
    if bid_no.startswith("R") and "BD" in bid_no:
        return f"https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo={bid_no}&bidPbancOrd={bid_ord}"
    return f"https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo={bid_no}&bidPbancOrd={bid_ord}"


def matches_keywords(title: str) -> bool:
    if not title:
        return False
    return any(kw in title for kw in KEYWORDS)


def map_item(item: dict) -> dict:
    title = item.get("bidNtceNm", "")
    gubun = item.get("bidNtceSttusNm", "") or "등록공고"
    posted = fmt_datetime(item.get("bidNtceDate"), item.get("bidNtceBgn"))
    closed = fmt_datetime(item.get("bidClseDate"), item.get("bidClseTm"))
    return {
        "업무구분": item.get("bsnsDivNm", "") or "기타",
        "구분": gubun,
        "입찰공고번호": item.get("bidNtceNo", ""),
        "공고명": title,
        "공고기관": item.get("ntceInsttNm", ""),
        "수요기관": item.get("dmndInsttNm", "") or item.get("ntceInsttNm", ""),
        "게시일시": posted,
        "입찰마감일시": closed,
        "링크": build_link(item),
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
              file=sys.stderr)
        sys.exit(1)

    now = datetime.now(KST)
    begin = now - timedelta(days=LOOKBACK_DAYS)
    begin_dt = begin.strftime("%Y%m%d0000")
    end_dt = now.strftime("%Y%m%d2359")

    print(f"[수집 범위] {begin_dt} ~ {end_dt}")

    try:
        raw_items = fetch_all(service_key, begin_dt, end_dt)
    except Exception as e:
        print(f"API 호출 실패: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"[API 원본 수신] {len(raw_items)}건")

    filtered = [map_item(it) for it in raw_items if matches_keywords(it.get("bidNtceNm", ""))]
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
    meta["raw_count"] = len(raw_items)
    meta["last_collected_at"] = now.isoformat()
    meta.setdefault("pub_snapshot_date", now.strftime("%Y-%m-%d"))
    meta.setdefault("source", "나라장터(g2b.go.kr) 공공데이터개방표준서비스 Open API")
    save_json(META_PATH, meta)
    print("[저장 완료] data/meta.json")


if __name__ == "__main__":
    main()
