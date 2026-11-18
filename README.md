# 공공조달·공모사업 통합조회 대시보드

나라장터(g2b.go.kr) 입찰·사전규격 공고와 주요 공공기관(기업마당·K-Startup·IPET 등)
공모·지원사업을 한 화면에서 검색·통계·엑셀 다운로드로 확인할 수 있는 정적 대시보드입니다.

- **통합조회**: 전체 공고를 필터 없이 최신순으로 조회
- **통계**: 전체 공고 KPI와 업무구분·구분·주간 추이·발주기관 TOP8 차트 (KPI 카드를 클릭하면 검색 페이지로 이동해 해당 조건이 자동 적용됩니다)
- **검색**: 키워드·기간·업무구분·구분·출처로 필터링, 정렬, 엑셀 내보내기
- **공공기관 공모·입찰**: 기업마당·K-Startup·IPET 등에서 수집한 주요 공모·지원사업 카드 목록
- **공고·공모 클러스터**: 기업마당·K-Startup·공공기관 홈페이지 게시판 공고를 매일 수집해 분야(16개)·유형·지역별로 자동 분류하고, 같은 사업의 중복·재공고·지역별 공고를 '유사공고 묶음'으로 합쳐 보여줍니다

## 폴더 구조

```
index.html                     대시보드 본체 (정적 HTML/CSS/JS, 외부 라이브러리는 CDN)
data/records.json              나라장터 입찰공고 데이터 (자동 수집)
data/pub_items.json            공공기관 공모·지원사업 데이터 (수동 큐레이션 스냅샷)
data/meta.json                 최근 수집 시각 등 메타 정보
data/notices.json              기업지원·공공기관 공고 (자동 수집 + 클러스터링)
data/notices_meta.json         공고 수집 결과(출처별 성공/실패)·클러스터 요약
assets/notices.js              '공고·공모 클러스터' 메뉴 화면 스크립트
scripts/collect_notices.py     기업마당·K-Startup·기관 게시판 공고 수집 스크립트
scripts/notice_cluster.py      분야·유형 분류 및 유사공고 묶음 계산
.github/workflows/collect_notices.yml  공고 매일 자동 수집 워크플로
scripts/collect_g2b.py         나라장터 Open API 수집 스크립트
.github/workflows/collect.yml  매주 자동 수집 GitHub Actions 워크플로
```

`index.html`은 실행 시 `data/*.json`을 `fetch()`로 불러와 화면을 그립니다. 즉, 매주
자동 수집 스크립트가 `data/records.json`과 `data/meta.json`만 갱신하면 페이지 코드를
건드리지 않고도 최신 데이터가 반영됩니다.

## GitHub Pages로 공개하기 (최초 1회, 수동)

이 저장소를 만든 계정에서 아래 절차를 한 번만 진행하면 됩니다 (Actions/REST API로는
자동화할 수 없어 GitHub 웹 UI에서 직접 설정해야 하는 유일한 단계입니다).

1. 저장소의 **Settings → Pages** 로 이동
2. **Source**를 `Deploy from a branch`로 선택
3. **Branch**를 `main`, 폴더는 `/ (root)`로 선택 후 저장
4. 잠시 후 `https://smartyoung25.github.io/bizsc/` 에서 접속 가능합니다

## 매주 자동 데이터 수집 설정

`.github/workflows/collect.yml`이 매주 월요일 00:10(KST)에 자동 실행되어
`scripts/collect_g2b.py`로 나라장터 Open API를 호출하고, 결과를 `data/records.json`,
`data/meta.json`에 반영한 뒤 저장소에 커밋·푸시합니다. 언제든 저장소의 **Actions** 탭에서
`나라장터 주간 데이터 수집` 워크플로를 수동으로도 실행할 수 있습니다 (`workflow_dispatch`).

### 필요한 Secret

- 이름: **`G2B_SERVICE_KEY`**
- 값: [data.go.kr](https://www.data.go.kr) 마이페이지에서 발급받은
  "나라장터 공공데이터개방표준서비스" Open API 서비스키(디코딩 키)
- 등록 위치: 저장소 **Settings → Secrets and variables → Actions → New repository secret**

> 이미 Secret을 등록하셨다면, 이름이 정확히 `G2B_SERVICE_KEY`인지
> **Settings → Secrets and variables → Actions**에서 확인해 주세요. 이름이 다르면
> `.github/workflows/collect.yml`의 `secrets.G2B_SERVICE_KEY` 부분을 실제 이름으로
> 바꾸거나, Secret을 같은 이름으로 다시 등록하시면 됩니다.

### 수집 대상 필터링

나라장터에는 매일 수천 건의 공고가 올라오기 때문에, `scripts/collect_g2b.py`의
`KEYWORDS` 목록에 포함된 단어가 공고명에 포함된 건만 수집합니다(창업·기술사업화·
지식재산·산학협력·R&D 등 이 대시보드의 원래 주제에 맞춘 필터). 다른 주제로 범위를
넓히거나 좁히고 싶다면 이 목록을 수정하세요.

### 데이터 보관 기간

오래된 공고가 무한정 쌓이지 않도록, 게시일시 기준 120일이 지난 레코드는 매 실행 시
자동으로 정리됩니다 (`scripts/collect_g2b.py`의 `RETENTION_DAYS`).

## 공공기관 공모·지원사업 데이터 (`data/pub_items.json`)

이 항목은 정기 자동 수집이 아니라 수동 스냅샷입니다. 최신 공고로 갱신하려면
`data/pub_items.json`을 직접 편집하고 `data/meta.json`의 `pub_snapshot_date`를
갱신 날짜로 바꿔주세요.

## 기업지원·공공기관 공고 클러스터 (`data/notices.json`)

`.github/workflows/collect_notices.yml`이 매일 00:40(KST)에 `scripts/collect_notices.py`를 실행해
아래 출처에서 공고를 모은 뒤 클러스터링하여 `data/notices.json`, `data/notices_meta.json`을 갱신합니다.

| 출처 | 방식 | 필요한 Secret (선택) |
|---|---|---|
| 기업마당 | 공식 API, 키가 없으면 '진행중' 목록 페이지 파싱 | `BIZINFO_API_KEY` (기업마당 API 인증키) |
| K-Startup | data.go.kr '창업진흥원_K-Startup 사업공고' API | `KSTARTUP_SERVICE_KEY` (없으면 `G2B_SERVICE_KEY`로 시도, 활용신청 필요) |
| 공공기관 홈페이지 | `institutions.json`의 `공고게시판URL`(사업·공모)과 `게시판URL`(입찰)을 범용 게시판 파서로 읽음 | 없음 |

- **수집 기관 추가**: `institutions.json`에서 해당 기관의 `공고게시판URL`에 게시판 '목록' 주소를 넣으면 다음 실행부터 반영됩니다.
  사전 입력된 6개 주소(중기부·NIPA·KIAT·NRF·KEIT·KOAT)는 아직 미검증이며, 화면 하단 수집 상태 배지(✓/✕)나
  `data/notices_meta.json`의 `sources`에서 동작 여부를 확인할 수 있습니다.
- **분류 방식**: 공고명·지원분야·기관명 키워드 점수로 16개 분야 클러스터에 배정하고, 공고 유형(모집·공모 / 입찰·용역 /
  시행계획 / 설명회·행사 / 결과발표)과 지역(제목 앞 `[지역]` 표기)을 추출합니다. 연도·차수·지역 표기를 뺀 제목의 글자 유사도가
  높으면 같은 사업으로 보고 '유사공고 묶음'으로 합칩니다. 분야 키워드는 `scripts/notice_cluster.py`의 `CLUSTERS`에서 조정합니다.
- **보관 기간**: 게시일 150일 경과 또는 마감 후 45일 경과 공고는 자동 정리됩니다.
- **초기 데이터**: 첫 화면은 저장소에 있던 기업마당 엑셀·`pub_items.json`으로 만든 스냅샷이며
  (`python scripts/collect_notices.py --seed`), 워크플로가 처음 실행되면 실시간 수집 데이터로 바뀝니다.

## 로컬에서 미리보기

```
python3 -m http.server 8080
# 브라우저에서 http://localhost:8080 접속
```

`file://`로 직접 열면 브라우저 보안 정책상 `fetch()`가 로컬 JSON 파일을 읽지 못할 수
있으니, 반드시 위와 같이 간단한 로컬 서버를 통해 확인하세요.

## 데이터 출처 및 유의사항

- 나라장터(g2b.go.kr) 공공데이터개방표준서비스 Open API로 수집한 입찰·사전규격 공고
- 기업마당·K-Startup·IPET 등에서 수집한 주요 공공기관 공모·지원사업(수동 스냅샷)
- 동일 나라장터 공고가 여러 주에 걸쳐 반복 수집된 경우 공고번호·구분·게시일시 기준으로
  중복을 제거합니다
- 이 페이지의 정보는 참고용입니다. 지원 전 반드시 원문 공고에서 접수기간과 마감 여부를
  다시 확인하세요
