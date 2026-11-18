// 기업마당 지원사업 지도 (data/notices.json 중 source === "기업마당")
(async function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  if (!$("bz-root")) return;

  let ITEMS = [], META = {};
  try {
    const [a, b] = await Promise.all([fetch("data/notices.json"), fetch("data/notices_meta.json")]);
    ITEMS = (await a.json()).filter((i) => i.source === "기업마당");
    META = await b.json();
  } catch (e) {
    console.error("기업마당 데이터 로드 실패:", e);
    $("bz-root").innerHTML = `<div class="empty">데이터를 불러오지 못했습니다.</div>`;
    return;
  }

  // 기업마당 '지원분야' → 화면 표시 분야
  const FIELD_MAP = {
    "금융": "자금·금융", "기술": "기술개발", "기술사업화": "기술개발", "지식재산": "기술개발", "인력": "인력",
    "수출": "수출", "내수": "판로·마케팅", "창업": "창업", "경영": "경영지원",
  };
  const FIELD_ORDER = ["자금·금융", "기술개발", "인력", "수출", "판로·마케팅", "창업", "경영지원", "기타"];
  const FIELD_DESC = {
    "자금·금융": "정책자금·융자·보증·이차보전", "기술개발": "R&D·기술사업화·지식재산", "인력": "채용·교육·일자리",
    "수출": "해외진출·바이어·전시회", "판로·마케팅": "내수 판로·홍보·입점", "창업": "예비·초기 창업·보육",
    "경영지원": "컨설팅·인증·시설·지역 지원", "기타": "",
  };
  const REGIONS = ["전국", "서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주"];
  const STATUS = [{ key: "open", label: "접수중" }, { key: "soon", label: "마감임박(7일)" }, { key: "always", label: "상시·미정" }, { key: "closed", label: "마감" }];
  const STOP = new Set("공고 모집 안내 사업 지원 지원사업 참여기업 참가기업 신청 접수 년 년도 및 의 등 위한 대한 관련 기업 추가 재공고 변경 연장 시행 계획 대상 참여 참가 수혜기업 기업체 2차 1차 3차 4차".split(" "));
  const PAGE = 10;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  ITEMS.forEach((it) => {
    it._field = FIELD_MAP[(it.field || "").trim()] || "기타";
    const d = it.deadline ? Math.round((new Date(it.deadline + "T00:00:00") - today) / 86400000) : null;
    it._dday = Number.isNaN(d) ? null : d;
    it._status = it._dday == null ? "always" : it._dday < 0 ? "closed" : it._dday <= 7 ? "soon" : "open";
    it._ministry = it.ministry || "기타";
    it._hay = `${it.title} ${it.org} ${it.ministry} ${it.cluster}`.toLowerCase();
  });

  const st = { fields: new Set(), topics: new Set(), regions: new Set(), status: new Set(["open", "soon", "always"]), ministry: "", q: "", sort: "deadline", expanded: new Set() };
  const count = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});

  function keywords(rows, k = 5) {
    const c = {};
    rows.forEach((r) => {
      const t = r.title.replace(/\[[^\]]*\]|\([^)]*\)|20\d{2}\s*년?도?|제?\d+\s*(차|회|분기)/g, " ");
      (t.match(/[가-힣A-Za-z][가-힣A-Za-z0-9·]+/g) || []).forEach((w) => {
        w = w.replace(/(을|를|이|가|은|는|의|에|에서|으로|로|과|와)$/, "");
        if (w.length < 2 || STOP.has(w) || /^(군|시|구)$/.test(w) || /(시|군|구)$/.test(w) && w.length <= 4) return;
        c[w] = (c[w] || 0) + 1;
      });
    });
    return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, k).map((e) => e[0]);
  }

  function filtered(ignore) {
    const terms = st.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return ITEMS.filter((i) => {
      if (ignore !== "field" && st.fields.size && !st.fields.has(i._field)) return false;
      if (ignore !== "topic" && st.topics.size && !st.topics.has(i.cluster)) return false;
      if (ignore !== "region" && st.regions.size && !st.regions.has(i.region)) return false;
      if (ignore !== "status" && st.status.size && !st.status.has(i._status)) return false;
      if (st.ministry && i._ministry !== st.ministry) return false;
      if (terms.length && !terms.every((t) => i._hay.includes(t))) return false;
      return true;
    });
  }

  function sortRows(rows) {
    return rows.slice().sort((a, b) => {
      if (st.sort === "posted") return (b.posted || "").localeCompare(a.posted || "");
      const da = a._dday == null || a._dday < 0 ? 1e9 : a._dday, db = b._dday == null || b._dday < 0 ? 1e9 : b._dday;
      return da - db || (b.posted || "").localeCompare(a.posted || "");
    });
  }

  // ---------- 지원분야 지도 ----------
  function renderMap() {
    const rows = filtered("field");
    const c = count(rows, (i) => i._field);
    const max = Math.max(1, ...Object.values(c));
    $("bz-map").classList.toggle("has-sel", st.fields.size > 0);
    $("bz-map").innerHTML = FIELD_ORDER.filter((f) => ITEMS.some((i) => i._field === f)).map((f) => {
      const fr = rows.filter((i) => i._field === f);
      const open = fr.filter((i) => i._status === "open" || i._status === "soon").length;
      return `<button type="button" class="cl-tile" data-f="${esc(f)}" aria-pressed="${st.fields.has(f)}">
        <span class="cl-head"><span class="cl-name">${esc(f)}</span><span class="cl-n">${c[f] || 0}</span></span>
        <span class="cl-bar"><span style="width:${Math.round(((c[f] || 0) / max) * 100)}%"></span></span>
        <span class="cl-kw">${esc(FIELD_DESC[f] || "")}${fr.length ? " — " + esc(keywords(fr, 4).join(" · ")) : ""}</span>
        <span class="cl-sub">접수중 ${open}건</span>
      </button>`;
    }).join("");
  }

  // ---------- 세부 주제·지역 ----------
  function renderTopics() {
    const rows = filtered("topic");
    const c = count(rows, (i) => i.cluster);
    const names = Object.keys(c).sort((a, b) => c[b] - c[a]);
    st.topics.forEach((t) => { if (!c[t]) names.push(t); });
    $("bz-topics").innerHTML = names.map((n) =>
      `<button type="button" class="chip" data-t="${esc(n)}" aria-pressed="${st.topics.has(n)}">${esc(n)} <span class="n">${c[n] || 0}</span></button>`).join("")
      || `<span class="inst-none">해당 조건의 세부 주제가 없습니다.</span>`;
    $("bz-topics").classList.toggle("has-sel", st.topics.size > 0);
  }
  function renderRegions() {
    const rows = filtered("region");
    const c = count(rows, (i) => i.region);
    $("bz-regions").innerHTML = REGIONS.filter((r) => ITEMS.some((i) => i.region === r)).map((r) =>
      `<button type="button" class="chip" data-r="${esc(r)}" aria-pressed="${st.regions.has(r)}">${esc(r)} <span class="n">${c[r] || 0}</span></button>`).join("");
  }
  function renderStatus() {
    const rows = filtered("status");
    const c = count(rows, (i) => i._status);
    $("bz-status").innerHTML = STATUS.map((s) =>
      `<button type="button" class="chip" data-s="${s.key}" aria-pressed="${st.status.has(s.key)}">${s.label} <span class="n">${c[s.key] || 0}</span></button>`).join("");
  }

  // ---------- 목록 ----------
  function badge(i) {
    if (i._status === "closed") return `<span class="st st-closed">마감</span>`;
    if (i._status === "always") return `<span class="st st-always">상시·공고문 확인</span>`;
    return `<span class="st ${i._status === "soon" ? "st-soon" : "st-open"}">${i._dday === 0 ? "D-Day" : "D-" + i._dday}</span>`;
  }
  function renderList() {
    const rows = sortRows(filtered());
    $("bz-empty").hidden = rows.length > 0;
    const by = {};
    rows.forEach((r) => (by[r._field] = by[r._field] || []).push(r));
    $("bz-results").innerHTML = FIELD_ORDER.filter((f) => by[f]).map((f) => {
      const list = by[f];
      const all = st.expanded.has(f);
      return `<div class="cl-section">
        <h3>${esc(f)} <span class="n">${list.length}건</span></h3>
        <ul class="cl-list">${(all ? list : list.slice(0, PAGE)).map((i) => `<li class="cl-item">
          <div class="t"><span class="cl-badges"><span class="tb tb-${esc(i.type)}">${esc(i.type)}</span></span><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a></div>
          <div class="m"><span>${esc(i.ministry || "")}</span><span>${esc(i.org || "")}</span><span>${esc(i.region)}</span><span>${esc(i.cluster)}</span>${i.period && !/^\d{4}-\d{2}-\d{2}$/.test(i.period) ? `<span>${esc(i.period)}</span>` : ""}</div>
          <div class="r">${badge(i)}<span>${i.deadline ? "마감 " + esc(i.deadline) : ""}</span><span>${i.posted ? "등록 " + esc(i.posted) : ""}</span></div>
        </li>`).join("")}</ul>
        ${list.length > PAGE ? `<button type="button" class="cl-more" data-more="${esc(f)}">${all ? "접기" : `${list.length - PAGE}건 더 보기`}</button>` : ""}
      </div>`;
    }).join("");
  }

  function renderSelbar() {
    const parts = [];
    if (st.fields.size) parts.push(`<span>지원분야</span>${[...st.fields].map((n) => `<span class="sel-chip">${esc(n)}</span>`).join("")}`);
    if (st.topics.size) parts.push(`<span>세부 주제</span>${[...st.topics].map((n) => `<span class="sel-chip">${esc(n)}</span>`).join("")}`);
    if (st.regions.size) parts.push(`<span>지역</span>${[...st.regions].map((n) => `<span class="sel-chip">${esc(n)}</span>`).join("")}`);
    const bar = $("bz-selbar");
    const n = filtered().length;
    bar.hidden = !parts.length;
    if (parts.length) bar.innerHTML = parts.join("") + `<span>· ${n.toLocaleString()}건</span><button type="button" class="btn btn-ghost btn-sm" data-clear>선택 해제</button>`;
    $("bz-map-desc").innerHTML = st.fields.size
      ? `<span class="cl-map-hint">✓ ${st.fields.size}개 분야 선택 · ${n.toLocaleString()}건 — 아래 목록에 표시</span>`
      : "타일을 누르면 해당 지원분야만 아래 목록에 보여줍니다 (여러 개 선택 가능)";
  }

  function renderKpis() {
    const live = ITEMS.filter((i) => i._status !== "closed");
    const soon = ITEMS.filter((i) => i._status === "soon").length;
    const nation = live.filter((i) => i.region === "전국").length;
    $("bz-kpis").innerHTML = [
      ["hero", ITEMS.length, "기업마당 지원사업", "진행 중 공고 기준 수집"],
      ["", live.length, "접수중·상시", ""],
      ["", soon, "마감임박 (7일 이내)", ""],
      ["", nation, "전국 대상 (접수중)", "지역 제한 없는 사업"],
    ].map(([c, n, l, d]) => `<div class="kpi ${c}"><div class="num">${Number(n).toLocaleString()}</div><div class="lbl">${esc(l)}</div>${d ? `<div class="delta">${esc(d)}</div>` : ""}</div>`).join("");
  }

  function renderAll() { renderMap(); renderTopics(); renderRegions(); renderStatus(); renderSelbar(); renderList(); }

  function scrollToResults() {
    const bar = $("bz-selbar");
    const t = bar.hidden ? $("bz-results") : bar;
    window.scrollTo({ top: Math.max(0, t.getBoundingClientRect().top + window.scrollY - 70), behavior: "smooth" });
  }
  const toggle = (set, v) => (set.has(v) ? set.delete(v) : set.add(v));

  // ---------- 이벤트 ----------
  $("bz-map").addEventListener("click", (e) => {
    const t = e.target.closest(".cl-tile");
    if (!t) return;
    toggle(st.fields, t.dataset.f);
    st.topics.clear();
    renderAll();
    scrollToResults();
  });
  $("bz-topics").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (!c) return; toggle(st.topics, c.dataset.t); renderAll(); });
  $("bz-regions").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (!c) return; toggle(st.regions, c.dataset.r); renderAll(); });
  $("bz-status").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (!c) return; toggle(st.status, c.dataset.s); renderAll(); });
  $("bz-results").addEventListener("click", (e) => {
    const m = e.target.closest(".cl-more");
    if (!m) return;
    toggle(st.expanded, m.dataset.more);
    renderList();
  });
  $("bz-selbar").addEventListener("click", (e) => {
    if (!e.target.closest("[data-clear]")) return;
    st.fields.clear(); st.topics.clear(); st.regions.clear();
    renderAll();
    $("bz-map").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("bz-q").addEventListener("input", (e) => { st.q = e.target.value; renderAll(); });
  $("bz-sort").addEventListener("change", (e) => { st.sort = e.target.value; renderList(); });
  const mc = count(ITEMS, (i) => i._ministry);
  $("bz-ministry").innerHTML = `<option value="">전체 소관부처·지자체</option>` +
    Object.keys(mc).sort((a, b) => mc[b] - mc[a]).map((m) => `<option value="${esc(m)}">${esc(m)} (${mc[m]})</option>`).join("");
  $("bz-ministry").addEventListener("change", (e) => { st.ministry = e.target.value; renderAll(); });
  $("bz-export").addEventListener("click", () => {
    if (typeof XLSX === "undefined") { alert("엑셀 라이브러리를 불러오지 못했습니다."); return; }
    const rows = sortRows(filtered()).map((i) => ({
      지원분야: i._field, 세부주제: i.cluster, 상태: STATUS.find((s) => s.key === i._status).label, 지원사업명: i.title,
      소관부처: i.ministry, 수행기관: i.org, 지역: i.region, 신청기간: i.period, 마감일: i.deadline, 등록일: i.posted, 링크: i.url,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [10, 14, 10, 60, 16, 22, 8, 26, 12, 12, 60].map((w) => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "기업마당 지원사업");
    const d = new Date();
    XLSX.writeFile(wb, `기업마당_지원사업_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.xlsx`);
  });

  const when = META.collected_at ? META.collected_at.replace("T", " ").slice(0, 16) : "-";
  $("bz-updated").textContent = `${when} 수집, 총 ${ITEMS.length.toLocaleString()}건`;
  renderKpis();
  renderAll();
})();
