#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
기업지원정보·공공기관 공고/공모 수집 + 클러스터링 스크립트.

수집 출처
  1) 기업마당(bizinfo.go.kr)  : BIZINFO_API_KEY 가 있으면 공식 API, 없으면 목록 페이지(HTML) 파싱
  2) K-Startup(창업진흥원)     : data.go.kr '창업진흥원_K-Startup 사업공고' API
                                 (KSTARTUP_SERVICE_KEY, 없으면 G2B_SERVICE_KEY 로 시도)
  3) 공공기관 홈페이지 게시판  : institutions.json 의 '공고게시판URL'(사업·공모 공고)과
                                 '게시판URL'(입찰 공고)을 범용 파서로 읽음

결과
  data/notices.json      : 공고 목록 (분야 클러스터·유형·지역·유사공고 묶음 포함)
  data/notices_meta.json : 수집 시각, 출처별 성공/실패, 클러스터 요약

실행
  python scripts/collect_notices.py            # 수집 + 기존 데이터와 병합
  python scripts/collect_notices.py --seed     # 저장소의 기업마당 엑셀·pub_items.json 으로 초기 데이터 생성
  python scripts/collect_notices.py --offline  # 네트워크 수집 없이 기존 데이터만 재클러스터링
"""

import argparse
import glob
import hashlib
import html as htmllib
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import notice_cluster as nc  # noqa: E402

KST = timezone(timedelta(hours=9))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
NOTICES_PATH = os.path.join(DATA_DIR, "notices.json")
META_PATH = os.path.join(DATA_DIR, "notices_meta.json")
INSTITUTIONS_PATH = os.path.join(ROOT, "institutions.json")

RETENTION_DAYS = 150          # 게시일 기준 보관 기간
CLOSED_KEEP_DAYS = 45         # 마감일이 이만큼 지난 공고는 정리
BIZINFO_MAX_PAGES = 30        # 기업마당 HTML 목록 최대 페이지 (15건/페이지)
BOARD_MAX_ROWS = 40           # 기관 게시판 1곳당 최대 건수
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0 Safari/537.36")

DATE_RE = re.compile(r"(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})")


def now_kst():
    return datetime.now(KST)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------- HTTP ----------------
def _ssl_ctx(legacy=False):
    ctx = ssl.create_default_context()
    if legacy:
        # 일부 공공기관 사이트는 구형 TLS 설정을 사용 → 보안수준을 낮춘 컨텍스트로 재시도
        try:
            ctx.set_ciphers("DEFAULT@SECLEVEL=1")
        except ssl.SSLError:
            pass
        ctx.options |= getattr(ssl, "OP_LEGACY_SERVER_CONNECT", 0)
    return ctx


def _opener(legacy):
    # 쿠키를 받아야 목록을 보여주는 사이트(예: 국토교통부 — 쿠키 없이 요청하면 307 무한 리다이렉트)를 위해
    # 요청마다 쿠키 저장소를 가진 opener를 쓴다.
    import http.cookiejar
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        urllib.request.HTTPSHandler(context=_ssl_ctx(legacy)),
    )


def http_get(url, timeout=25, retries=2):
    try:
        return _http_get(url, timeout, retries)
    except RuntimeError as e:
        # 'www.' 없는 도메인이 DNS에서 안 잡히는 경우 www. 를 붙여 한 번 더 시도
        host = urllib.parse.urlsplit(url).hostname or ""
        if "Name or service not known" in str(e) and host and not host.startswith("www."):
            return _http_get(url.replace(host, "www." + host, 1), timeout, 0)
        raise


def _http_get(url, timeout=25, retries=2):
    last = None
    for attempt in range(retries + 1):
        for legacy in (False, True):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9",
                                                       "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"})
                with _opener(legacy).open(req, timeout=timeout) as r:
                    raw = r.read()
                    ctype = r.headers.get("Content-Type", "")
                    return decode_body(raw, ctype), r.geturl()
            except ssl.SSLError as e:
                last = e
                continue
            except urllib.error.URLError as e:
                last = e
                if isinstance(getattr(e, "reason", None), ssl.SSLError):
                    continue
                break
            except Exception as e:  # noqa: BLE001
                last = e
                break
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{type(last).__name__}: {str(last)[:160]}")


def decode_body(raw: bytes, ctype: str = "") -> str:
    m = re.search(r"charset=([\w-]+)", ctype, re.I) or re.search(rb"charset=[\"']?([\w-]+)", raw[:3000], re.I)
    enc = m.group(1) if m else "utf-8"
    if isinstance(enc, bytes):
        enc = enc.decode("ascii", "ignore")
    enc = enc.lower()
    if enc in ("euc-kr", "ks_c_5601-1987", "ksc5601"):
        enc = "cp949"
    for e in (enc, "utf-8", "cp949"):
        try:
            return raw.decode(e)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", "replace")


def strip_tags(s: str) -> str:
    s = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", s or "", flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", htmllib.unescape(s)).strip()


def norm_date(s: str) -> str:
    m = DATE_RE.search(s or "")
    if not m:
        return ""
    y, mo, d = m.groups()
    try:
        return datetime(int(y), int(mo), int(d)).strftime("%Y-%m-%d")
    except ValueError:
        return ""


def period_dates(period: str):
    ds = [f"{y}-{int(m):02d}-{int(d):02d}" for y, m, d in DATE_RE.findall(period or "")]
    start = ds[0] if ds else ""
    end = ds[-1] if len(ds) >= 2 else ""
    return start, end


def make_id(source: str, key: str) -> str:
    return source[:2] + "-" + hashlib.md5(f"{source}|{key}".encode("utf-8")).hexdigest()[:12]


def item(source, title, url, org="", ministry="", field="", period="", posted="", deadline="",
         summary="", type_hint="", key=None):
    title = re.sub(r"\s+", " ", title or "").strip()
    if not deadline:
        _, deadline = period_dates(period)
    return {
        "id": make_id(source, key or url or title),
        "source": source,
        "title": title,
        "url": url,
        "org": org.strip(),
        "ministry": ministry.strip(),
        "field": field.strip(),
        "period": period.strip(),
        "posted": posted,
        "deadline": deadline,
        "summary": summary.strip()[:160],
        "type_hint": type_hint,
    }


# ---------------- 1) 기업마당 ----------------
BIZINFO_LIST = "https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do"
BIZINFO_DETAIL = "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId="
BIZINFO_API = "https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do"


def collect_bizinfo_api(key):
    q = urllib.parse.urlencode({"crtfcKey": key, "dataType": "json", "searchCnt": "1000"})
    body, _ = http_get(f"{BIZINFO_API}?{q}", timeout=60)
    data = json.loads(body)
    arr = data.get("jsonArray") or data.get("items") or []
    out = []
    for r in arr:
        pid = r.get("pblancId", "")
        url = r.get("pblancUrl") or (BIZINFO_DETAIL + pid if pid else "")
        if url.startswith("/"):
            url = "https://www.bizinfo.go.kr" + url
        out.append(item(
            "기업마당", r.get("pblancNm", ""), url,
            org=r.get("excInsttNm", "") or r.get("jrsdInsttNm", ""),
            ministry=r.get("jrsdInsttNm", ""),
            field=r.get("pldirSportRealmLclasCodeNm", ""),
            period=r.get("reqstBeginEndDe", ""),
            posted=norm_date(r.get("creatPnttm", "")),
            summary=strip_tags(r.get("bsnsSumryCn", "")),
            key=pid or url,
        ))
    return out


def _bizinfo_parse(html):
    tb = re.search(r"<tbody>([\s\S]*?)</tbody>", html)
    if not tb:
        return []
    rows = []
    for tr in re.findall(r"<tr[^>]*>([\s\S]*?)</tr>", tb.group(1)):
        tds = re.findall(r"<td[^>]*>([\s\S]*?)</td>", tr)
        if len(tds) < 7:
            continue
        tm = re.search(r'title="([^"]*?)\s*페이지 이동"', tds[2])
        title = htmllib.unescape(tm.group(1)) if tm else strip_tags(tds[2])
        im = re.search(r"pblancId=([^&\"']+)", tds[2])
        pid = im.group(1) if im else ""
        rows.append(item(
            "기업마당", title, BIZINFO_DETAIL + pid if pid else BIZINFO_LIST,
            org=strip_tags(tds[5]), ministry=strip_tags(tds[4]), field=strip_tags(tds[1]),
            period=strip_tags(tds[3]), posted=norm_date(strip_tags(tds[6])), key=pid or title,
        ))
    return rows


def collect_bizinfo_html():
    out = []
    for cpage in range(1, BIZINFO_MAX_PAGES + 1):
        q = urllib.parse.urlencode({"rows": "15", "cpage": str(cpage), "schEndAt": "N",
                                    "condition": "searchPblancNm", "condition1": "AND"})
        html, _ = http_get(f"{BIZINFO_LIST}?{q}")
        rows = _bizinfo_parse(html)
        if not rows:
            break
        out.extend(rows)
        if len(rows) < 15:
            break
        time.sleep(0.4)
    return out


# ---------------- 2) K-Startup ----------------
KSTARTUP_API = "https://apis.data.go.kr/B552735/kisedKstartupService01/getAnnouncementInformation01"


def collect_kstartup(key):
    key_part = key if "%" in key else urllib.parse.quote_plus(key)
    out = []
    for page in range(1, 11):
        q = urllib.parse.urlencode({"page": page, "perPage": 100, "returnType": "json",
                                    "cond[rcrt_prgs_yn::EQ]": "Y"})
        body, _ = http_get(f"{KSTARTUP_API}?serviceKey={key_part}&{q}", timeout=40)
        data = json.loads(body)
        arr = data.get("data") or []
        for r in arr:
            sn = str(r.get("pbanc_sn", ""))
            url = r.get("detl_pg_url") or (
                f"https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn={sn}")
            b, e = r.get("pbanc_rcpt_bgng_dt", ""), r.get("pbanc_rcpt_end_dt", "")
            fmt = lambda s: f"{s[:4]}-{s[4:6]}-{s[6:8]}" if re.fullmatch(r"\d{8}", s or "") else (s or "")
            out.append(item(
                "K-Startup", r.get("biz_pbanc_nm") or r.get("intg_pbanc_biz_nm", ""), url,
                org=r.get("pbanc_ntrp_nm", "") or r.get("sprv_inst", ""),
                ministry=r.get("sprv_inst", ""),
                field=f"창업 {r.get('supt_biz_clsfc', '')}",
                period=f"{fmt(b)} ~ {fmt(e)}" if b or e else "",
                posted=fmt(b), deadline=fmt(e),
                summary=strip_tags(r.get("pbanc_ctnt", "")), key=sn or url,
            ))
        if len(arr) < 100:
            break
    return out


# ---------------- 3) 공공기관 게시판 (범용 파서) ----------------
NAV_WORDS = ("로그인", "회원가입", "사이트맵", "개인정보", "이전", "다음", "처음", "마지막", "목록", "검색", "바로가기")


def _resolve_href(a_tag, base):
    hm = re.search(r'href\s*=\s*["\']([^"\']*)["\']', a_tag, re.I)
    href = htmllib.unescape(hm.group(1)).strip() if hm else ""
    if href and not href.lower().startswith(("javascript", "#")):
        return urllib.parse.urljoin(base, href)
    return ""


TITLE_CUT = re.compile(r"\s+(담당부서|담당자|공고번호|신청기간|접수기간|첨부파일|등록일|작성일|조회수?|작성자)\b.*$")
TITLE_TAIL = re.compile(r"(\.(pdf|hwpx?|docx?|xlsx?|zip|pptx?))?\s*(다운로드|내려받기|새로운\s*게시글|새글|new|N|첨부파일)?\s*$", re.I)
POSTED_LABEL = re.compile(r"(등록일|작성일|게시일|공고일|등록)\s*[:：]?\s*(20\d{2}\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2})")
RANGE_RE = re.compile(r"(20\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2})[^0-9]{0,12}~\s*(20\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2})")


def clean_title(t: str) -> str:
    t = TITLE_CUT.sub("", t).strip()
    for _ in range(3):  # "공고.pdf 다운로드", "모집 새로운게시글 N" 처럼 꼬리가 겹친 경우
        t2 = TITLE_TAIL.sub("", t).strip()
        if t2 == t:
            break
        t = t2
    return t


def block_dates(text: str):
    """블록 텍스트에서 (게시일, 신청기간 문자열)을 뽑는다. 신청기간 범위의 날짜는 게시일로 쓰지 않는다."""
    m = POSTED_LABEL.search(text)
    rng = RANGE_RE.search(text)
    period = f"{norm_date(rng.group(1))} ~ {norm_date(rng.group(2))}" if rng else ""
    if m:
        return norm_date(m.group(2)), period
    rest = text[:rng.start()] + " " + text[rng.end():] if rng else text
    posted = norm_date(rest) or (norm_date(rng.group(1)) if rng else "")
    return posted, period


def _rows_from_blocks(blocks, base_url, limit):
    out, seen = [], set()
    for b in blocks:
        text = strip_tags(b)
        date, period = block_dates(text)
        if not date:
            continue
        best = None
        for a in re.finditer(r"(<a\b[^>]*>)([\s\S]*?)</a>", b, re.I):
            t = clean_title(strip_tags(a.group(2)))
            tm = re.search(r'title\s*=\s*["\']([^"\']{8,})["\']', a.group(1))
            if tm:
                tt = clean_title(re.sub(r"\s*(새창|새 창|페이지 이동|바로가기)\s*$", "", strip_tags(tm.group(1))))
                if len(tt) > len(t):
                    t = tt
            if len(t) >= 8 and not any(t.startswith(w) for w in NAV_WORDS) and not DATE_RE.fullmatch(t):
                if not best or len(t) > len(best[0]):
                    best = (t, a.group(1))
        if not best:
            continue
        title = best[0]
        url = _resolve_href(best[1], base_url) or base_url
        k = (title, date)
        if k in seen:
            continue
        seen.add(k)
        out.append((title, url, date, period))
        if len(out) >= limit:
            break
    return out


def _anchor_blocks(html):
    """표·목록 구조가 아닌 <div> 카드형 게시판용: 긴 링크 하나와 그 주변(다음 링크 전까지)을 한 블록으로 본다.
    날짜는 링크 뒤쪽을 우선 쓰고, 뒤에 없을 때만 앞쪽 200자를 본다."""
    blocks = []
    for m in re.finditer(r"<a\b[^>]*>[\s\S]{8,}?</a>", html, re.I):
        after = html[m.end():m.end() + 600]
        nxt = re.search(r"<a\b", after, re.I)
        if nxt:
            after = after[:nxt.start()]
        link = html[m.start():m.end()]
        if DATE_RE.search(strip_tags(after)):
            blocks.append(link + after)
        else:
            before = html[max(0, m.start() - 200):m.start()].split("</a>")[-1]
            ds = list(DATE_RE.finditer(before))
            if ds:  # 앞쪽에 날짜가 여러 개면 링크에 가장 가까운 것만 남긴다
                before = before[ds[-1].start():]
            blocks.append(before + link)
    return blocks


def parse_board(html, base_url, limit=BOARD_MAX_ROWS):
    """게시판 목록 HTML에서 (제목, 링크, 게시일)을 뽑는다.
    표(<tr>) → 목록(<li>) → 링크 주변 텍스트 순으로 시도해 '날짜가 있고 충분히 긴 링크'를 게시글로 본다."""
    html = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", html, flags=re.I)
    for finder in (
        lambda h: re.findall(r"<tr[^>]*>([\s\S]*?)</tr>", h, re.I),
        lambda h: re.findall(r"<li[^>]*>([\s\S]*?)</li>", h, re.I),
        lambda h: re.findall(r"<dl[^>]*>([\s\S]*?)</dl>", h, re.I),
        _anchor_blocks,
    ):
        rows = _rows_from_blocks(finder(html), base_url, limit)
        if len(rows) >= 2:
            return rows
    return []


SKIP_FOLLOW = re.compile(r"login|logout|sso|search|member|join|sitemap|\.(css|js|png|jpe?g|gif)(\?|$)", re.I)


def find_followups(html, base_url):
    """목록이 iframe이나 자바스크립트 이동 뒤에 있는 경우 따라갈 주소 후보."""
    cands = []
    for pat in (r'<iframe[^>]+src=["\']([^"\']+)["\']',
                r'http-equiv=["\']refresh["\'][^>]*url=([^"\'>\s]+)',
                r'location(?:\.href)?\s*=\s*["\']([^"\']+)["\']'):
        for u in re.findall(pat, html, re.I):
            u = htmllib.unescape(u).strip()
            if u and not u.lower().startswith(("javascript", "about:", "#")) and not SKIP_FOLLOW.search(u):
                cands.append(urllib.parse.urljoin(base_url, u))
    return list(dict.fromkeys(cands))[:3]


def board_diag(html):
    """0건일 때 원인 파악용 요약 (로그·notices_meta.json에 기록)."""
    title = strip_tags((re.search(r"<title[^>]*>([\s\S]*?)</title>", html, re.I) or [None, ""])[1])[:60]
    ajax = re.findall(r'(?:url|action|href)\s*[:=]\s*["\']([^"\']*(?:[Ll]ist|ajax|Ajax|json|\.do|select)[^"\']*)["\']', html)
    return {
        "bytes": len(html), "title": title,
        "tr": len(re.findall(r"<tr\b", html, re.I)), "li": len(re.findall(r"<li\b", html, re.I)),
        "dates": len(DATE_RE.findall(strip_tags(html))),
        "long_links": len(re.findall(r"<a\b[^>]*>[^<]{8,}</a>", html, re.I)),
        "ajax_candidates": list(dict.fromkeys(ajax))[:8],
        "followups": find_followups(html, ""),
    }


HOMEPAGE_LABEL = "홈페이지 최신 공지"
# 메뉴 링크 문구 → 우선순위 (낮을수록 먼저 시도)
_MORE = r"(\s*(더보기|바로가기|목록|more|MORE|\+|>|›))?"
BOARD_MENU = [
    (re.compile(r"^(사업\s*공고|지원\s*사업\s*공고|사업\s*공모|공모\s*사업|사업\s*안내\s*공고|모집\s*공고|공고\s*/\s*모집|사업\s*공고\s*/\s*모집)" + _MORE + "$"), 0),
    (re.compile(r"^(공고|공고\s*사항|공고\s*게시판|공고\s*/?\s*공지|공지\s*/?\s*공고|알림\s*공고|공고\s*안내)" + _MORE + "$"), 1),
    (re.compile(r"^(지원\s*사업|사업\s*신청|사업\s*안내|사업\s*소개)" + _MORE + "$"), 2),
    (re.compile(r"^(공지\s*사항|공지|새소식|알림\s*마당|알림\s*소식|소식\s*알림|기관\s*소식)" + _MORE + "$"), 3),
    (re.compile(r"^(입찰\s*공고|입찰\s*정보|입찰)" + _MORE + "$"), 4),
]
MENU_HINT = re.compile(r"공고|공지|모집|공모|지원사업|사업신청|입찰|알림")


def _same_site(a: str, b: str) -> bool:
    a, b = a.removeprefix("www."), b.removeprefix("www.")
    return a == b or a.endswith("." + b) or b.endswith("." + a)


def discover_board(html, base_url, max_tries=4):
    """홈페이지에서 공고 게시판 메뉴 링크를 찾아 목록을 읽어 본다. 성공하면 (주소, 공고성 행 목록)."""
    cands = []
    host = urllib.parse.urlsplit(base_url).hostname or ""
    for m in re.finditer(r"(<a\b[^>]*>)([\s\S]{1,80}?)</a>", html, re.I):
        text = re.sub(r"\s+", " ", strip_tags(m.group(2))).strip()
        for pat, prio in BOARD_MENU:
            if pat.match(text):
                href = _resolve_href(m.group(1), base_url)
                if not href or SKIP_FOLLOW.search(href):
                    break
                h2 = urllib.parse.urlsplit(href).hostname or ""
                # 같은 기관 도메인만 (외부 포털 링크 제외)
                if h2 and host and not _same_site(h2, host):
                    break
                cands.append((prio, href))
                break
    seen = []
    for _, href in sorted(cands):
        if href in seen:
            continue
        seen.append(href)
        if len(seen) > max_tries:
            break
        try:
            h, final = http_get(href, retries=0)
        except Exception:  # noqa: BLE001
            continue
        rows = [r for r in parse_board(h, final) if NOTICE_WORDS.search(r[0])][:20]
        if len(rows) >= 2:
            return final, rows
        time.sleep(0.3)
    return None
NOTICE_WORDS = re.compile(r"공고|모집|공모|입찰|선정|신청|접수|지원사업|수요조사|참여기업|설명회|제안요청")


# ---------------- 브라우저 렌더링 (자바스크립트로 그리는 사이트용) ----------------
class Renderer:
    """Playwright(헤드리스 Chromium)로 페이지를 띄워 자바스크립트가 그린 뒤의 HTML을 얻는다.
    playwright가 설치돼 있지 않으면 조용히 비활성화된다 (로컬 실행 등)."""

    def __init__(self):
        self._pw = self._browser = None
        self.available = None

    def _start(self):
        if self.available is not None:
            return self.available
        try:
            from playwright.sync_api import sync_playwright
            self._pw = sync_playwright().start()
            # PW_CHROMIUM_PATH: 미리 설치된 Chromium을 쓸 때 (Actions에서는 비워 두면 playwright가 설치한 것을 사용)
            self._browser = self._pw.chromium.launch(executable_path=os.environ.get("PW_CHROMIUM_PATH") or None)
            self.available = True
        except Exception as e:  # noqa: BLE001
            log(f"[렌더링] 사용 불가 ({type(e).__name__}) — 정적 수집만 진행")
            self.available = False
        return self.available

    def _page(self):
        ctx = self._browser.new_context(user_agent=UA, locale="ko-KR", ignore_https_errors=False)
        page = ctx.new_page()
        page.set_default_timeout(20000)
        return ctx, page

    @staticmethod
    def _settle(page):
        try:
            page.wait_for_load_state("networkidle", timeout=12000)
        except Exception:  # noqa: BLE001
            pass
        page.wait_for_timeout(1200)

    def get(self, url):
        if not self._start():
            raise RuntimeError("렌더링 사용 불가")
        ctx, page = self._page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            self._settle(page)
            return page.content(), page.url
        finally:
            ctx.close()

    LINKS_JS = """() => Array.from(document.querySelectorAll('a')).map((a, i) => ({
        i, text: (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim(),
        href: a.getAttribute('href') || '', abs: a.href || ''}))"""
    # 날짜가 들어 있는 '가장 작은' 목록 상자를 찾아 텍스트와 첫 링크를 돌려준다 (<a> 없이 카드로 된 목록용)
    CARDS_JS = """() => {
      const re = /20\\d{2}\\s*[.\\-\\/년]\\s*\\d{1,2}\\s*[.\\-\\/월]\\s*\\d{1,2}/;
      const els = Array.from(document.querySelectorAll('li, tr, dl, article, div, a'));
      const hits = els.filter(e => { const t = (e.innerText || '').trim();
        return t.length >= 12 && t.length <= 400 && re.test(t); });
      const minimal = hits.filter(e => !hits.some(o => o !== e && e.contains(o)));
      return minimal.slice(0, 80).map(e => { const a = e.closest('a') || e.querySelector('a');
        return {text: e.innerText, href: a ? a.href : ''}; });
    }"""

    def _rows(self, page):
        rows = [r for r in parse_board(page.content(), page.url) if NOTICE_WORDS.search(r[0])][:20]
        if len(rows) >= 2:
            return rows
        try:
            cards = page.evaluate(self.CARDS_JS)
        except Exception:  # noqa: BLE001
            return rows
        out, seen = [], set()
        for c in cards:
            text = c.get("text") or ""
            date, period = block_dates(text)
            lines = [clean_title(x.strip()) for x in text.split("\n")]
            lines = [x for x in lines if len(x) >= 8 and not DATE_RE.fullmatch(x) and not RANGE_RE.search(x)]
            if not date or not lines:
                continue
            title = max(lines, key=len)[:200]
            href = c.get("href") or ""
            if not href or href.lower().startswith("javascript") or href.endswith("#"):
                href = page.url
            if (title, date) in seen or not NOTICE_WORDS.search(title):
                continue
            seen.add((title, date))
            out.append((title, href, date, period))
        return out[:20] if len(out) > len(rows) else rows

    def get_rows(self, url):
        """렌더링 후 목록 행을 돌려준다 (렌더링=true 게시판 수집용)."""
        if not self._start():
            raise RuntimeError("렌더링 사용 불가")
        ctx, page = self._page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            self._settle(page)
            return self._rows(page), page.url
        finally:
            ctx.close()

    def _go(self, page, home_url, ln):
        """메뉴 링크로 이동: 일반 주소는 goto, 'javascript:함수()'는 홈에서 그 코드를 실행, 그 외는 클릭."""
        href = ln["href"].strip()
        if href.lower().startswith("javascript:") and len(href) > 12:
            page.goto(home_url, wait_until="domcontentloaded", timeout=30000)
            self._settle(page)
            try:
                page.evaluate("code => { (0, eval)(code); }", urllib.parse.unquote(href[11:]))
            except Exception:  # noqa: BLE001  (이동하면서 실행 컨텍스트가 사라지는 경우)
                pass
        elif ln["abs"] and not href.startswith("#") and ln["abs"].split("#")[0] != home_url.split("#")[0]:
            page.goto(ln["abs"], wait_until="domcontentloaded", timeout=30000)
        else:
            page.goto(home_url, wait_until="domcontentloaded", timeout=30000)
            self._settle(page)
            page.locator("a").nth(ln["i"]).click(timeout=8000, force=True)
        self._settle(page)

    def discover(self, url, max_tries=6):
        """렌더링된 홈페이지에서 공고 메뉴를 찾아 (링크 이동·자바스크립트 실행·클릭으로) 들어가 목록을 읽는다."""
        if not self._start():
            return None
        ctx, page = self._page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            self._settle(page)
            home_url = page.url
            links = page.evaluate(self.LINKS_JS)
            if len(links) < 25:
                # 인트로·랜딩 페이지: 같은 사이트의 본 페이지로 한 번 더 들어간다
                host = urllib.parse.urlsplit(home_url).hostname or ""
                enter = [ln for ln in links if "//" in ln["abs"] and not SKIP_FOLLOW.search(ln["abs"])
                         and _same_site(urllib.parse.urlsplit(ln["abs"]).hostname or "", host)
                         and ln["abs"].split("#")[0] != home_url.split("#")[0]]
                enter.sort(key=lambda ln: 0 if re.search(r"메인|홈|바로가기|입장|들어가기|ENTER|enter|main|Main", ln["text"] + ln["abs"]) else 1)
                for ln in enter[:2]:
                    try:
                        page.goto(ln["abs"], wait_until="domcontentloaded", timeout=30000)
                        self._settle(page)
                        more = page.evaluate(self.LINKS_JS)
                    except Exception:  # noqa: BLE001
                        continue
                    if len(more) > len(links):
                        home_url, links = page.url, more
                        break
            host = urllib.parse.urlsplit(home_url).hostname or ""
            cands = []
            for ln in links:
                for pat, prio in BOARD_MENU:
                    if pat.match(ln["text"]):
                        absu = ln["abs"]
                        if absu.startswith("http") and not ln["href"].lower().startswith("javascript") and (
                                SKIP_FOLLOW.search(absu) or not _same_site(urllib.parse.urlsplit(absu).hostname or "", host)):
                            break
                        cands.append((prio, ln))
                        break
            tried = set()
            for prio, ln in sorted(cands, key=lambda c: c[0]):
                key = ln["href"] if ln["href"] and not ln["href"].startswith("#") else f"#{ln['i']}"
                if key in tried:
                    continue
                tried.add(key)
                if len(tried) > max_tries:
                    break
                try:
                    self._go(page, home_url, ln)
                except Exception:  # noqa: BLE001
                    continue
                rows = self._rows(page)
                if len(rows) >= 2:
                    return page.url, rows
            # 못 찾았으면 사람이 고를 수 있게 공고 관련 메뉴 후보를 로그로 남긴다
            hints = [f"{ln['text'][:20]}|{(ln['abs'] or ln['href'])[:120]}" for ln in links
                     if ln["text"] and len(ln["text"]) <= 20 and MENU_HINT.search(ln["text"])][:25]
            log(f"  [메뉴 진단] {url} (최종 {home_url}, 링크 {len(links)}개, 시도 {len(tried)}개): " + " ; ".join(hints))
            return None
        except Exception:  # noqa: BLE001
            return None
        finally:
            ctx.close()

    def close(self):
        try:
            if self._browser:
                self._browser.close()
            if self._pw:
                self._pw.stop()
        except Exception:  # noqa: BLE001
            pass


RENDERER = Renderer()


def collect_boards(institutions, status):
    out = []
    for inst in institutions:
        if not inst.get("활성화", True):
            continue
        targets = []
        if inst.get("공고게시판URL"):
            targets.append((inst["공고게시판URL"], "", "사업·공모 공고"))
        elif inst.get("홈페이지"):
            # 공고 게시판 주소를 모르는 기관은 홈페이지 첫 화면의 최신글 목록에서 공고성 글만 수집
            home = inst["홈페이지"]
            home = home if home.startswith("http") else "https://" + home
            targets.append((home, "", HOMEPAGE_LABEL))
        if inst.get("게시판URL"):
            targets.append((inst["게시판URL"], "입찰·용역", "입찰 공고"))
        for url, type_hint, label in targets:
            name = f"{inst['기관명']} · {label}"
            is_home = label == HOMEPAGE_LABEL
            try:
                use_render = bool(inst.get("렌더링")) and label != "입찰 공고"
                if use_render and not is_home:
                    rows, final = RENDERER.get_rows(url)
                    html = ""
                else:
                    html, final = RENDERER.get(url) if use_render else http_get(url)
                    rows = parse_board(html, final, limit=60 if is_home else BOARD_MAX_ROWS)
                if is_home:
                    rows = [r for r in rows if NOTICE_WORDS.search(r[0])][:20]
                    discovered = ""
                    if len(rows) < 3:
                        # 첫 화면에 공고가 거의 없으면 '사업공고·공고·공지사항' 메뉴 링크를 찾아 들어가 본다
                        found = discover_board(html, final)
                        if found:
                            discovered, brows = found
                            rows = brows
                            log(f"  [게시판 자동탐색] {name}: {discovered} → {len(rows)}건")
                    rendered = False
                    if len(rows) < 3 and not use_render:
                        # 그래도 없으면 브라우저로 띄워서(자바스크립트 실행 후) 다시 찾는다
                        try:
                            rh, rf = RENDERER.get(url)
                            rrows = [r for r in parse_board(rh, rf, limit=60) if NOTICE_WORDS.search(r[0])][:20]
                            if len(rrows) > len(rows):
                                rows, rendered = rrows, True
                            if len(rows) < 3:
                                found = RENDERER.discover(url)
                                if found:
                                    discovered, rows = found
                                    rendered = True
                                    log(f"  [게시판 자동탐색·렌더링] {name}: {discovered} → {len(rows)}건")
                        except Exception as e:  # noqa: BLE001
                            log(f"  [렌더링] {name}: 실패 - {str(e)[:100]}")
                    st = {"source": name, "url": url, "ok": True, "count": len(rows)}
                    if rendered:
                        st["rendered"] = True
                    if discovered:
                        st["discovered_board"] = discovered
                    elif not rows:
                        st["note"] = "첫 화면에 공고성 최신글 없음"
                    status.append(st)
                    log(f"  [홈페이지] {name}: {len(rows)}건")
                    for title, link, date, period in rows:
                        out.append(item("기관 홈페이지", title, link, org=inst["기관명"], field=inst.get("분야", ""),
                                        posted=date, period=period, key=f"{inst['기관명']}|{title}|{date}"))
                    time.sleep(0.5)
                    continue
                if rows and inst.get("공고필터"):
                    rows = [r for r in rows if NOTICE_WORDS.search(r[0])]
                if not rows:
                    for nxt in find_followups(html, final):
                        try:
                            h2, f2 = http_get(nxt)
                        except Exception:  # noqa: BLE001
                            continue
                        rows = parse_board(h2, f2)
                        if rows:
                            log(f"  [게시판] {name}: 연결 페이지에서 목록 발견 → {nxt}")
                            break
                if not rows and not use_render:
                    try:
                        rows, _ = RENDERER.get_rows(url)
                        if rows and inst.get("공고필터"):
                            rows = [r for r in rows if NOTICE_WORDS.search(r[0])]
                        if rows:
                            log(f"  [게시판] {name}: 렌더링으로 목록 확인 (institutions.json에 렌더링=true 권장)")
                    except Exception:  # noqa: BLE001
                        pass
                if not rows:
                    diag = board_diag(html)
                    log(f"  [게시판 진단] {name}: {json.dumps(diag, ensure_ascii=False)}")
                    status.append({"source": name, "url": url, "ok": False, "count": 0,
                                   "error": "목록을 찾지 못함 (자바스크립트로 불러오는 게시판일 수 있음)",
                                   "diag": diag})
                    # 게시판을 못 읽으면 홈페이지 첫 화면 최신글로 대신 수집 (예: 한국연구재단 — 목록을 JS로 불러옴)
                    if label == "사업·공모 공고" and inst.get("홈페이지"):
                        home = inst["홈페이지"]
                        targets.append((home if home.startswith("http") else "https://" + home, "", HOMEPAGE_LABEL))
                    time.sleep(0.5)
                    continue
                for title, link, date, period in rows:
                    out.append(item(
                        "기관 홈페이지", title, link, org=inst["기관명"], field=inst.get("분야", ""),
                        posted=date, period=period, type_hint=type_hint, key=f"{inst['기관명']}|{title}|{date}",
                    ))
                status.append({"source": name, "url": url, "ok": True, "count": len(rows)})
                log(f"  [게시판] {name}: {len(rows)}건")
            except Exception as e:  # noqa: BLE001
                status.append({"source": name, "url": url, "ok": False, "count": 0, "error": str(e)[:160]})
                log(f"  [게시판] {name}: 실패 - {e}")
            time.sleep(0.5)
    return out


# ---------------- 시드 (저장소 내 로컬 자료) ----------------
def seed_from_repo():
    out = []
    try:
        import openpyxl  # noqa: F401
    except ImportError:
        log("openpyxl 미설치 → 엑셀 시드 생략")
        openpyxl = None
    if openpyxl:
        import openpyxl as ox
        for f in sorted(glob.glob(os.path.join(ROOT, "bizinfo_*.xlsx"))):
            ws = ox.load_workbook(f, read_only=True).worksheets[0]
            rows = list(ws.iter_rows(values_only=True))
            hdr = [str(h or "") for h in rows[0]]
            for r in rows[1:]:
                d = dict(zip(hdr, [("" if v is None else str(v)) for v in r]))
                url = d.get("url", "")
                pid = (re.search(r"pblancId=([^&]+)", url) or [None, url])[1]
                out.append(item(
                    "기업마당", d.get("지원사업명", ""), url, org=d.get("사업수행기관", ""),
                    ministry=d.get("소관부처·지자체", ""), field=d.get("지원분야", ""),
                    period=d.get("신청기간", ""), posted=norm_date(d.get("등록일", "")),
                    deadline=norm_date(d.get("마감일자", "")), summary=d.get("내용요약", ""), key=pid,
                ))
    pub_path = os.path.join(DATA_DIR, "pub_items.json")
    if os.path.exists(pub_path):
        snap = json.load(open(os.path.join(DATA_DIR, "meta.json"), encoding="utf-8")).get("pub_snapshot_date", "")
        for p in json.load(open(pub_path, encoding="utf-8")):
            src = "기업마당" if "bizinfo" in p["link"] else ("K-Startup" if "k-startup" in p["link"] else "기관 홈페이지")
            pid = (re.search(r"pblancId=([^&]+)", p["link"]) or [None, p["link"]])[1]
            out.append(item(src, p["title"], p["link"], org=p.get("org", ""), field=p.get("tag", ""),
                            period=p.get("period", ""), posted=snap, key=pid))
    return out


# ---------------- 병합·정리 ----------------
def sanitize_board_items(items):
    """기관 게시판에서 온 항목의 제목 꼬리(첨부파일명·'새로운게시글'·담당부서/등록일 등)를 정리하고
    제목 안에 섞여 있던 등록일·신청기간을 게시일·마감일로 옮긴다. id도 정리된 제목 기준으로 다시 만든다."""
    out = {}
    for it in items:
        if it.get("source") == "기관 홈페이지":
            raw = it["title"]
            posted, period = block_dates(raw)
            if POSTED_LABEL.search(raw):
                it["posted"] = posted
            if period and not it.get("period"):
                it["period"] = period
                it["deadline"] = period_dates(period)[1]
            it["title"] = clean_title(raw)
            it["id"] = make_id("기관 홈페이지", f"{it['org']}|{it['title']}|{it.get('posted', '')}")
        out[it["id"]] = it
    return list(out.values())



def merge(old, new):
    by_id = {o["id"]: o for o in old}
    for n in new:
        prev = by_id.get(n["id"])
        if prev:
            n["first_seen"] = prev.get("first_seen") or n.get("first_seen")
            for k in ("summary", "posted", "deadline", "period"):
                if not n.get(k) and prev.get(k):
                    n[k] = prev[k]
        by_id[n["id"]] = n
    return list(by_id.values())


def prune(items):
    today = now_kst().date()
    keep = []
    for it in items:
        if not it.get("title") or not it.get("url"):
            continue
        posted = it.get("posted") or it.get("first_seen", "")
        if posted:
            try:
                if (today - datetime.strptime(posted, "%Y-%m-%d").date()).days > RETENTION_DAYS:
                    continue
            except ValueError:
                pass
        dl = it.get("deadline", "")
        if dl:
            try:
                if (today - datetime.strptime(dl, "%Y-%m-%d").date()).days > CLOSED_KEEP_DAYS:
                    continue
            except ValueError:
                pass
        keep.append(it)
    return keep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", action="store_true", help="저장소 내 기업마당 엑셀·pub_items.json으로 시드")
    ap.add_argument("--offline", action="store_true", help="네트워크 수집 없이 재클러스터링만")
    ap.add_argument("--only", default=os.environ.get("NOTICE_ONLY", ""),
                    help="쉼표로 구분한 기관명만 시험 수집(저장하지 않음). 게시판 탐색 점검용")
    args = ap.parse_args()

    old = []
    if os.path.exists(NOTICES_PATH):
        old = json.load(open(NOTICES_PATH, encoding="utf-8"))
    prev_meta = json.load(open(META_PATH, encoding="utf-8")) if os.path.exists(META_PATH) else {}

    insts = json.load(open(INSTITUTIONS_PATH, encoding="utf-8"))["기관목록"]
    org_fields = {i["기관명"]: i.get("분야", "") for i in insts}
    if args.only.strip():
        names = [n.strip() for n in args.only.split(",") if n.strip()]
        sel = [i for i in insts if any(n in i["기관명"] for n in names)]
        log(f"[시험 수집] {len(sel)}개 기관: {', '.join(i['기관명'] for i in sel)} (결과는 저장하지 않음)")
        st = []
        try:
            rows = collect_boards(sel, st)
        finally:
            RENDERER.close()
        for x in st:
            log(f"  결과: {x['source']} → {'성공' if x['ok'] else '실패'} {x['count']}건"
                + (f" | 찾은 게시판 {x['discovered_board']}" if x.get("discovered_board") else "")
                + (f" | {x.get('error', '')}" if not x["ok"] else ""))
        for r in rows[:60]:
            log(f"    - [{r['org']}] {r['title'][:60]} ({r['posted']})")
        return

    status, new = [], []
    stamp = now_kst().strftime("%Y-%m-%d")

    if args.seed:
        s = seed_from_repo()
        new.extend(s)
        status.append({"source": "저장소 스냅샷(기업마당 엑셀·pub_items.json)", "ok": True, "count": len(s)})

    if not args.offline and not args.seed:
        # 1) 기업마당
        bkey = os.environ.get("BIZINFO_API_KEY", "").strip()
        try:
            rows = collect_bizinfo_api(bkey) if bkey else collect_bizinfo_html()
            new.extend(rows)
            status.append({"source": "기업마당" + (" (API)" if bkey else " (목록 페이지)"), "ok": True, "count": len(rows)})
            log(f"[기업마당] {len(rows)}건")
        except Exception as e:  # noqa: BLE001
            status.append({"source": "기업마당", "ok": False, "count": 0, "error": str(e)[:160]})
            log(f"[기업마당] 실패 - {e}")
        # 2) K-Startup
        kkey = (os.environ.get("KSTARTUP_SERVICE_KEY") or os.environ.get("G2B_SERVICE_KEY") or "").strip()
        if kkey:
            try:
                rows = collect_kstartup(kkey)
                new.extend(rows)
                status.append({"source": "K-Startup (data.go.kr API)", "ok": True, "count": len(rows)})
                log(f"[K-Startup] {len(rows)}건")
            except Exception as e:  # noqa: BLE001
                status.append({"source": "K-Startup (data.go.kr API)", "ok": False, "count": 0,
                               "error": str(e)[:160] + " (data.go.kr에서 'K-Startup 사업공고' 활용신청 필요)"})
                log(f"[K-Startup] 실패 - {e}")
        else:
            status.append({"source": "K-Startup (data.go.kr API)", "ok": False, "count": 0, "error": "서비스키 없음"})
        # 3) 공공기관 게시판
        try:
            new.extend(collect_boards(insts, status))
        finally:
            RENDERER.close()

    for n in new:
        n.setdefault("first_seen", stamp)

    old = sanitize_board_items(old)
    items = prune(merge(old, new))
    for it in items:  # 재분류를 위해 이전 계산 필드 제거
        for k in ("cluster", "type", "region", "group", "group_size"):
            it.pop(k, None)
    nc.enrich(items, org_fields)
    items.sort(key=lambda r: (r.get("posted") or r.get("first_seen") or ""), reverse=True)

    with open(NOTICES_PATH, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, separators=(",", ":"))

    if args.offline:
        status = prev_meta.get("sources", [])
    meta = {
        "collected_at": now_kst().isoformat(timespec="seconds") if not args.offline else prev_meta.get("collected_at", ""),
        "mode": "seed" if args.seed else ("offline" if args.offline else "live"),
        "total": len(items),
        "groups": len({i["group"] for i in items}),
        "sources": status,
        "clusters": nc.build_cluster_summary(items),
    }
    with open(META_PATH, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    log(f"완료: {len(items)}건, 유사묶음 {meta['groups']}개, 클러스터 {len(meta['clusters'])}개")


if __name__ == "__main__":
    main()
