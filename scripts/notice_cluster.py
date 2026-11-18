# -*- coding: utf-8 -*-
"""
공고·공모 정보 클러스터링 모듈 (표준 라이브러리만 사용).

세 가지 축으로 공고를 묶는다.
  1) 분야 클러스터  : 공고명·지원분야·기관명에 나타난 키워드 점수로 16개 분야 중 하나에 배정
  2) 공고 유형      : 모집·공모 / 입찰·용역 / 시행계획 / 설명회·행사 / 결과발표 / 기타공지
  3) 유사공고 묶음  : 제목을 정규화한 뒤 글자 2-gram 자카드 유사도로 같은 사업의 중복·재공고·
                      차수별 공고를 하나의 그룹으로 묶음 (기업마당과 기관 홈페이지에 동시 게시된
                      같은 사업도 여기서 묶인다)
"""

import re
from collections import Counter

# (클러스터명, 키워드 목록) — 같은 점수면 위에 있는 분야가 우선
CLUSTERS = [
    ("입찰·용역", ["입찰", "용역", "제안요청", "협상에 의한", "구매", "위탁운영", "운영대행", "수의계약", "단가계약"]),
    ("R&D·기술개발", ["기술개발", "R&D", "연구개발", "연구과제", "신규과제", "과제", "실증", "기술혁신", "원천기술", "연구", "테스트베드", "시제품"]),
    ("기술사업화·이전", ["사업화", "기술이전", "기술거래", "상용화", "스케일업", "기술지주", "기술가치", "이전기술", "기술평가"]),
    ("창업·벤처", ["창업", "스타트업", "벤처", "액셀러", "엑셀러", "TIPS", "팁스", "보육", "입주기업", "입주", "예비창업", "초기창업", "재도전"]),
    ("지식재산·특허", ["특허", "지식재산", "IP", "발명", "상표", "디자인권", "출원", "직무발명"]),
    ("농림·식품·해양", ["농업", "농촌", "농식품", "스마트팜", "축산", "임업", "산림", "수산", "해양", "식품", "농가", "귀농", "농산물", "어업", "푸드", "비료", "유기농", "직불", "농자재", "육묘", "수산물", "수산자원", "축산물", "양식", "원예", "과수", "가축"]),
    ("바이오·헬스", ["바이오", "의료", "헬스", "제약", "의약", "화장품", "건강", "임상", "의료기기"]),
    ("디지털·AI·데이터", ["AI", "인공지능", "데이터", "디지털", "클라우드", "SW", "소프트웨어", "메타버스", "스마트공장", "스마트제조", "ICT", "정보통신", "빅데이터", "로봇", "반도체", "플랫폼", "자율"]),
    ("에너지·환경·탄소", ["에너지", "탄소", "환경", "친환경", "녹색", "재생", "수소", "기후", "ESG", "순환경제", "그린"]),
    ("국토·건설·교통", ["국토", "건설", "교통", "도시", "주택", "스마트시티", "철도", "도로", "공간정보", "모빌리티", "드론", "물류", "항공", "부동산", "건축", "산업단지"]),
    ("수출·해외진출", ["수출", "해외", "글로벌", "바이어", "무역", "박람회", "전시회", "해외인증", "통상", "K-"]),
    ("판로·마케팅", ["판로", "마케팅", "홍보", "온라인", "쇼핑", "라이브커머스", "입점", "유통", "공공구매", "우수제품", "브랜드", "상품"]),
    ("금융·투자", ["융자", "보증", "투자", "펀드", "자금", "대출", "이차보전", "IR", "크라우드", "출자", "정책자금"]),
    ("인력·교육", ["인력", "채용", "일자리", "교육", "아카데미", "훈련", "인재", "양성", "멘토링", "청년", "고용", "인턴"]),
    ("경영·컨설팅·인증", ["컨설팅", "경영", "진단", "인증", "바우처", "품질", "시험", "분석지원", "혁신"]),
    ("지역·소상공인", ["소상공인", "전통시장", "상권", "골목", "자영업", "지역특화", "로컬", "지역", "음식점", "외식업", "업소", "착한가격", "아동친화"]),
]
CLUSTER_NAMES = [c for c, _ in CLUSTERS] + ["기타"]

# 기업마당 '지원분야' 값 → 분야 클러스터 가중치
FIELD_HINTS = {
    "금융": "금융·투자", "기술": "R&D·기술개발", "인력": "인력·교육", "수출": "수출·해외진출",
    "내수": "판로·마케팅", "창업": "창업·벤처", "경영": "경영·컨설팅·인증",
    # 기존 pub_items.json 태그
    "기술사업화": "기술사업화·이전", "지식재산": "지식재산·특허", "농업": "농림·식품·해양",
}
# institutions.json '분야' 값 → 분야 클러스터 가중치(약하게)
ORG_FIELD_HINTS = {
    "농업": "농림·식품·해양", "특허·지식재산": "지식재산·특허",
    "기술사업화": "기술사업화·이전", "창업·엑셀러레이터": "창업·벤처",
}
# 기관명 → 분야 가중치 (산업·국토 분야 기관은 기관별로 성격이 달라 개별 지정)
ORG_HINTS = {
    "국토교통부": "국토·건설·교통", "국토교통과학기술진흥원": "국토·건설·교통", "한국국토정보공사": "국토·건설·교통",
    "한국토지주택공사": "국토·건설·교통", "대한무역투자진흥공사": "수출·해외진출", "한국산업기술시험원": "경영·컨설팅·인증",
}

TYPE_RULES = [
    ("결과발표", ["선정결과", "결과 발표", "결과발표", "결과 공고", "최종선정", "선정 결과", "합격자", "심사결과", "평가결과", "선정 공고"]),
    ("입찰·용역", ["입찰", "제안요청", "용역", "협상에 의한", "구매", "단가계약", "수의계약", "개찰"]),
    ("설명회·행사", ["설명회", "세미나", "포럼", "행사", "개최", "컨퍼런스", "콘퍼런스", "박람회", "데모데이", "간담회", "교육생"]),
    ("시행계획", ["시행계획", "통합공고", "통합 공고", "시행공고", "종합공고", "추진계획"]),
    ("모집·공모", ["모집", "공모", "신청", "접수", "참가", "선발", "지원사업", "참여기업", "수요조사", "추가모집", "재공고"]),
]
TYPE_NAMES = [t for t, _ in TYPE_RULES] + ["기타공지"]

REGION_RE = re.compile(r"^\s*\[([^\]]{1,20})\]")
REGIONS = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원",
           "충북", "충남", "전북", "전남", "경북", "경남", "제주"]


def _score(text: str, keywords) -> int:
    s = 0
    for kw in keywords:
        if kw.isascii():
            # 영문 약어는 단어 경계로만 매칭(예: 'IP'가 'TIPS'에 걸리지 않게)
            if re.search(rf"(?<![A-Za-z]){re.escape(kw)}(?![A-Za-z])", text):
                s += 2
        elif kw in text:
            s += 2 if len(kw) >= 3 else 1
    return s


def classify_cluster(title: str, field: str = "", org: str = "", org_field: str = "") -> str:
    scores = {}
    for name, kws in CLUSTERS:
        scores[name] = _score(title, kws) * 2 + _score(org, kws)
    if field:
        for k, v in FIELD_HINTS.items():
            if k in field:
                scores[v] += 1  # 제목 키워드가 없을 때의 보조 신호로만 사용
    if org_field and org_field in ORG_FIELD_HINTS:
        scores[ORG_FIELD_HINTS[org_field]] += 1
    for name, cl in ORG_HINTS.items():
        if name in org:
            scores[cl] += 2
    best = max(CLUSTER_NAMES[:-1], key=lambda n: (scores[n], -CLUSTER_NAMES.index(n)))
    return best if scores[best] > 0 else "기타"


def classify_type(title: str, default: str = "") -> str:
    for name, kws in TYPE_RULES:
        if any(k in title for k in kws):
            return name
    return default or "기타공지"


def extract_region(title: str, org: str = "") -> str:
    m = REGION_RE.match(title or "")
    if m:
        tag = m.group(1)
        for r in REGIONS:
            if r in tag:
                return r
        return tag[:8]
    for r in REGIONS:
        if (org or "").startswith(r):
            return r
    return "전국"


# ---------------- 유사공고 묶음 ----------------
_NORM_DROP = re.compile(
    r"\[[^\]]*\]|\([^)]*\)|〔[^〕]*〕|20\d{2}\s*년?(도)?|제?\s*\d+\s*(차|회|기)|"
    r"공고|모집|안내|알림|재공고|추가|변경|연장|수정|참여기업|참가기업|신청|접수|지원사업|사업"
)


def normalize_title(title: str) -> str:
    t = _NORM_DROP.sub(" ", title or "")
    t = re.sub(r"[^0-9A-Za-z가-힣]+", "", t)
    return t.lower()


def _bigrams(s: str):
    return {s[i:i + 2] for i in range(len(s) - 1)} if len(s) > 1 else {s}


def group_similar(items, threshold: float = 0.62):
    """items: dict 목록 (title 필드 필요). 각 item에 group(대표 id)·group_size를 채운다."""
    n = len(items)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    grams = [_bigrams(normalize_title(it["title"])) for it in items]
    # 역색인으로 후보만 비교 (O(n^2) 회피)
    index = {}
    for i, g in enumerate(grams):
        for b in g:
            index.setdefault(b, []).append(i)
    for i, g in enumerate(grams):
        if len(g) < 4:
            continue
        cand = Counter()
        for b in g:
            lst = index[b]
            if len(lst) > 300:  # 너무 흔한 2-gram은 후보 생성에서 제외
                continue
            for j in lst:
                if j > i:
                    cand[j] += 1
        for j, inter in cand.items():
            union = len(g) + len(grams[j]) - inter
            if union and inter / union >= threshold:
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[rj] = ri

    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    for members in groups.values():
        # 대표 = 가장 최근 게시 건
        rep = max(members, key=lambda k: items[k].get("posted") or "")
        gid = items[rep]["id"]
        for k in members:
            items[k]["group"] = gid
            items[k]["group_size"] = len(members)
    return items


_STOP = set("공고 모집 안내 사업 지원 지원사업 참여기업 참가기업 신청 접수 년 년도 및 의 등 위한 대한 관련 기업 2차 1차 3차 추가 재공고 변경".split())


def top_keywords(titles, k: int = 6):
    c = Counter()
    for t in titles:
        t = re.sub(r"\[[^\]]*\]|\([^)]*\)|20\d{2}년?도?", " ", t)
        for w in re.findall(r"[가-힣A-Za-z][가-힣A-Za-z0-9·]+", t):
            w = re.sub(r"(을|를|이|가|은|는|의|에|에서|으로|로|과|와)$", "", w)
            if len(w) < 2 or w in _STOP:
                continue
            c[w] += 1
    return [w for w, _ in c.most_common(k)]


def build_cluster_summary(items):
    out = []
    for name in CLUSTER_NAMES:
        rows = [i for i in items if i["cluster"] == name]
        if not rows:
            continue
        out.append({
            "name": name,
            "count": len(rows),
            "groups": len({r["group"] for r in rows}),
            "sources": dict(Counter(r["source"] for r in rows).most_common()),
            "types": dict(Counter(r["type"] for r in rows).most_common()),
            "keywords": top_keywords([r["title"] for r in rows]),
        })
    return out


def enrich(items, org_fields=None):
    org_fields = org_fields or {}
    for it in items:
        it["cluster"] = classify_cluster(it["title"], it.get("field", ""), it.get("org", ""),
                                         org_fields.get(it.get("org", ""), ""))
        it["type"] = classify_type(it["title"], it.get("type_hint", ""))
        it["region"] = extract_region(it["title"], it.get("ministry", "") or it.get("org", ""))
        it.pop("type_hint", None)
    group_similar(items)
    return items
