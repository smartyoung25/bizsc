// 공공기관별 공고 현황 (institutions.json + data/notices.json + data/notices_meta.json)
(async function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const root = $("inst-root");
  if (!root) return;

  let INSTS = [], ITEMS = [], META = {};
  try {
    const [a, b, c] = await Promise.all([fetch("institutions.json"), fetch("data/notices.json"), fetch("data/notices_meta.json")]);
    INSTS = ((await a.json()).기관목록 || []).filter((i) => i.활성화 !== false);
    ITEMS = await b.json();
    META = await c.json();
  } catch (e) {
    console.error("기관별 공고 데이터 로드 실패:", e);
    root.innerHTML = `<div class="empty">데이터를 불러오지 못했습니다.</div>`;
    return;
  }

  const FIELD_ORDER = ["농업", "특허·지식재산", "기술사업화", "창업·엑셀러레이터", "산업·국토"];
  const SHOW = 5;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dday = (dl) => {
    if (!dl) return null;
    const d = new Date(dl + "T00:00:00");
    return isNaN(d) ? null : Math.round((d - today) / 86400000);
  };
  const base = (n) => (n || "").replace(/\s*\(구[^)]*\)\s*/g, "").trim();
  // 같은 기관의 다른 표기
  const ALIAS = { "지식재산처": ["특허청"], "산업통상자원부": ["산업통상부"], "K-Startup 창업지원포털": ["창업진흥원(K-Startup)"] };

  // 기관별 공고 모으기: 기관 홈페이지 수집분(org 일치) + 기업마당 등에서 수행기관이 그 기관인 공고
  const byInst = new Map();
  INSTS.forEach((inst) => {
    const names = new Set([inst.기관명, base(inst.기관명), ...(ALIAS[base(inst.기관명)] || [])]);
    const seen = new Set();
    const rows = ITEMS.filter((it) => {
      if (!(names.has(it.org) || names.has(base(it.org)))) return false;
      const k = it.group || it.id;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).map((it) => ({ ...it, _dday: dday(it.deadline) }))
      .sort((x, y) => {
        const ox = x._dday != null && x._dday < 0 ? 1 : 0, oy = y._dday != null && y._dday < 0 ? 1 : 0;
        return ox - oy || (y.posted || "").localeCompare(x.posted || "");
      });
    const srcs = (META.sources || []).filter((s) => s.source.split(" · ")[0] === inst.기관명);
    byInst.set(inst.기관명, { inst, rows, srcs });
  });

  const st = { q: "", fields: new Set(), onlyWith: true, onlyOpen: false, expanded: new Set() };

  function statusOf(entry) {
    const ok = entry.srcs.filter((s) => s.ok && s.count > 0);
    const fail = entry.srcs.filter((s) => !s.ok);
    if (entry.rows.length || ok.length) return { cls: "ok", text: `✓ ${entry.rows.length}건` };
    if (fail.length && !entry.srcs.some((s) => s.ok)) {
      const err = fail[0].error || "";
      const why = /CERTIFICATE/.test(err) ? "사이트 인증서 문제" : /timed out/.test(err) ? "응답 시간 초과"
        : /Name or service/.test(err) ? "도메인 확인 불가" : /Disconnected|closed/.test(err) ? "서버가 연결을 끊음"
        : /403/.test(err) ? "접근 거부" : "수집 실패";
      return { cls: "fail", text: `✕ ${why}`, title: err };
    }
    return { cls: "zero", text: "공고 없음" };
  }

  function rowHtml(r) {
    const d = r._dday;
    const badge = d == null ? `<span class="st st-always">상시·공고문 확인</span>`
      : d < 0 ? `<span class="st st-closed">마감</span>`
      : `<span class="st ${d <= 7 ? "st-soon" : "st-open"}">${d === 0 ? "D-Day" : "D-" + d}</span>`;
    return `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>
      <span class="ir-meta">${badge}<span>${esc(r.posted || "")}</span>${r.source !== "기관 홈페이지" ? `<span class="ir-src">${esc(r.source)}</span>` : ""}</span></li>`;
  }

  function render() {
    const q = st.q.trim().toLowerCase();
    let total = 0, shownInst = 0;
    const html = FIELD_ORDER.concat([...new Set(INSTS.map((i) => i.분야))].filter((f) => !FIELD_ORDER.includes(f))).map((field) => {
      if (st.fields.size && !st.fields.has(field)) return "";
      const cards = INSTS.filter((i) => i.분야 === field).map((inst) => {
        const e = byInst.get(inst.기관명);
        let rows = e.rows;
        if (st.onlyOpen) rows = rows.filter((r) => r._dday == null || r._dday >= 0);
        const nameHit = !q || `${inst.기관명} ${inst.약칭 || ""}`.toLowerCase().includes(q);
        if (q && !nameHit) rows = rows.filter((r) => r.title.toLowerCase().includes(q));
        if (q && !nameHit && !rows.length) return "";
        if (st.onlyWith && !rows.length) return "";
        total += rows.length; shownInst += 1;
        const s = statusOf(e);
        const open = st.expanded.has(inst.기관명);
        const list = open ? rows : rows.slice(0, SHOW);
        const home = inst.홈페이지 ? (inst.홈페이지.startsWith("http") ? inst.홈페이지 : "https://" + inst.홈페이지) : "";
        const board = inst.공고게시판URL || inst.게시판URL || "";
        return `<article class="inst-card">
          <header>
            <h3>${esc(inst.기관명)}${inst.약칭 ? ` <span class="abbr">${esc(inst.약칭)}</span>` : ""}</h3>
            <span class="inst-st ${s.cls}" ${s.title ? `title="${esc(s.title)}"` : ""}>${esc(s.text)}</span>
          </header>
          ${rows.length ? `<ul class="inst-rows">${list.map(rowHtml).join("")}</ul>` : `<p class="inst-none">${st.onlyOpen ? "접수 중인 공고가 없습니다." : "수집된 공고가 없습니다."}</p>`}
          <footer>
            ${rows.length > SHOW ? `<button type="button" class="inst-more" data-inst="${esc(inst.기관명)}">${open ? "접기" : `${rows.length - SHOW}건 더 보기`}</button>` : "<span></span>"}
            <span class="inst-links">${board ? `<a href="${esc(board)}" target="_blank" rel="noopener">공고 게시판 ↗</a>` : ""}${home ? `<a href="${esc(home)}" target="_blank" rel="noopener">홈페이지 ↗</a>` : ""}</span>
          </footer>
        </article>`;
      }).join("");
      if (!cards) return "";
      return `<section class="inst-field"><h3 class="inst-field-h">${esc(field)}</h3><div class="inst-grid">${cards}</div></section>`;
    }).join("");
    $("inst-list").innerHTML = html || `<div class="empty">조건에 맞는 기관이 없습니다.</div>`;
    $("inst-summary").textContent = `${shownInst}개 기관 · 공고 ${total.toLocaleString()}건`;
  }

  // 툴바
  const fieldCount = {};
  INSTS.forEach((i) => { fieldCount[i.분야] = (fieldCount[i.분야] || 0) + 1; });
  $("inst-field-chips").innerHTML = FIELD_ORDER.filter((f) => fieldCount[f]).map((f) =>
    `<button type="button" class="chip" data-f="${esc(f)}" aria-pressed="false">${esc(f)} <span class="n">${fieldCount[f]}</span></button>`).join("");
  $("inst-field-chips").addEventListener("click", (e) => {
    const c = e.target.closest(".chip");
    if (!c) return;
    const f = c.dataset.f;
    st.fields.has(f) ? st.fields.delete(f) : st.fields.add(f);
    c.setAttribute("aria-pressed", String(st.fields.has(f)));
    render();
  });
  $("inst-q").addEventListener("input", (e) => { st.q = e.target.value; render(); });
  $("inst-only-with").addEventListener("change", (e) => { st.onlyWith = e.target.checked; render(); });
  $("inst-only-open").addEventListener("change", (e) => { st.onlyOpen = e.target.checked; render(); });
  $("inst-list").addEventListener("click", (e) => {
    const b = e.target.closest(".inst-more");
    if (!b) return;
    const n = b.dataset.inst;
    st.expanded.has(n) ? st.expanded.delete(n) : st.expanded.add(n);
    render();
  });

  const withData = [...byInst.values()].filter((e) => e.rows.length).length;
  const when = META.collected_at ? META.collected_at.replace("T", " ").slice(0, 16) : "-";
  $("inst-updated").textContent = `${when} 수집 · ${INSTS.length}개 기관 중 ${withData}곳 공고 확인`;
  render();
})();
