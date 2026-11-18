// 공고·공모 클러스터 페이지 (data/notices.json, data/notices_meta.json)
(async function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let ITEMS = [], META = {};
  try {
    const [a, b] = await Promise.all([fetch("data/notices.json"), fetch("data/notices_meta.json")]);
    ITEMS = await a.json();
    META = await b.json();
  } catch (e) {
    console.error("공고 클러스터 데이터 로드 실패:", e);
  }

  const CLUSTER_ORDER = (META.clusters || []).map((c) => c.name);
  const TYPE_ORDER = ["모집·공모", "입찰·용역", "시행계획", "설명회·행사", "결과발표", "기타공지"];
  const STATUS = [
    { key: "open", label: "접수중" },
    { key: "soon", label: "마감임박(7일)" },
    { key: "always", label: "상시·미정" },
    { key: "closed", label: "마감" },
  ];
  const PAGE_PER_SECTION = 8;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  function dday(dl) {
    if (!dl) return null;
    const d = new Date(dl + "T00:00:00");
    return isNaN(d) ? null : Math.round((d - today) / 86400000);
  }
  ITEMS.forEach((it) => {
    const d = dday(it.deadline);
    it._dday = d;
    it._status = d == null ? "always" : d < 0 ? "closed" : d <= 7 ? "soon" : "open";
    it._ministry = it.ministry || it.org || "기타";
    it._hay = `${it.title} ${it.org} ${it.ministry} ${it.field} ${it.cluster} ${it.region}`.toLowerCase();
  });

  const st = { clusters: new Set(), types: new Set(), sources: new Set(), status: new Set(), region: "", ministry: "", q: "", sort: "posted", grouped: true, expanded: new Set(), openGroups: new Set() };

  const count = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});

  // ---------- KPI ----------
  function renderKpis() {
    const live = ITEMS.filter((i) => i._status !== "closed");
    const soon = ITEMS.filter((i) => i._status === "soon").length;
    const groups = new Set(ITEMS.map((i) => i.group)).size;
    const kpis = [
      ["hero", ITEMS.length, "전체 공고·공모", `출처 ${new Set(ITEMS.map((i) => i.source)).size}곳`],
      ["", live.length, "접수중·상시", "마감 전 공고"],
      ["", soon, "마감임박 (7일 이내)", "", "soon"],
      ["", CLUSTER_ORDER.length, "분야 클러스터", `유사공고 묶음 ${groups.toLocaleString()}개`],
    ];
    $("cl-kpis").innerHTML = kpis.map(([cls, n, lbl, delta, act]) => `
      <div class="kpi ${cls} ${act ? "kpi-link" : ""}" ${act ? `role="button" tabindex="0" data-act="${act}"` : ""}>
        <div class="num">${Number(n).toLocaleString()}</div>
        <div class="lbl">${esc(lbl)}</div>
        ${delta ? `<div class="delta">${esc(delta)}</div>` : ""}
        ${act ? `<span class="goto">마감임박만 보기</span>` : ""}
      </div>`).join("");
    const card = $("cl-kpis").querySelector("[data-act=soon]");
    if (card) {
      const go = () => { st.status = new Set(["soon"]); st.sort = "deadline"; $("cl-sort").value = "deadline"; syncChips(); renderAll(); $("cl-results").scrollIntoView({ behavior: "smooth", block: "start" }); };
      card.addEventListener("click", go);
      card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    }
  }

  // ---------- 필터 ----------
  function filtered(ignore) {
    const q = st.q.trim().toLowerCase();
    const terms = q ? q.split(/\s+/) : [];
    return ITEMS.filter((i) => {
      if (ignore !== "cluster" && st.clusters.size && !st.clusters.has(i.cluster)) return false;
      if (st.types.size && !st.types.has(i.type)) return false;
      if (st.sources.size && !st.sources.has(i.source)) return false;
      if (st.status.size && !st.status.has(i._status)) return false;
      if (st.region && i.region !== st.region) return false;
      if (st.ministry && i._ministry !== st.ministry) return false;
      if (terms.length && !terms.every((t) => i._hay.includes(t))) return false;
      return true;
    });
  }

  function sortRows(rows) {
    const k = st.sort;
    return rows.slice().sort((a, b) => {
      if (k === "title") return a.title.localeCompare(b.title, "ko");
      if (k === "deadline") {
        const da = a._dday == null || a._dday < 0 ? 1e9 : a._dday;
        const db = b._dday == null || b._dday < 0 ? 1e9 : b._dday;
        return da - db || (b.posted || "").localeCompare(a.posted || "");
      }
      return (b.posted || "").localeCompare(a.posted || "");
    });
  }

  // ---------- 클러스터 지도 ----------
  function renderMap() {
    const rows = filtered("cluster");
    const c = count(rows, (i) => i.cluster);
    const max = Math.max(1, ...Object.values(c));
    const kw = Object.fromEntries((META.clusters || []).map((x) => [x.name, x.keywords || []]));
    $("cl-map").innerHTML = CLUSTER_ORDER.map((name) => {
      const n = c[name] || 0;
      const g = new Set(rows.filter((i) => i.cluster === name).map((i) => i.group)).size;
      return `<button type="button" class="cl-tile" data-cl="${esc(name)}" aria-pressed="${st.clusters.has(name)}">
        <span class="cl-head"><span class="cl-name">${esc(name)}</span><span class="cl-n">${n}</span></span>
        <span class="cl-bar"><span style="width:${Math.round((n / max) * 100)}%"></span></span>
        <span class="cl-kw">${esc((kw[name] || []).slice(0, 5).join(" · "))}</span>
        <span class="cl-sub">유사묶음 ${g}개</span>
      </button>`;
    }).join("");
  }

  // ---------- 목록 ----------
  function statusBadge(i) {
    if (i._status === "closed") return `<span class="st st-closed">마감</span>`;
    if (i._status === "always") return `<span class="st st-always">상시·공고문 확인</span>`;
    const label = i._dday === 0 ? "D-Day" : `D-${i._dday}`;
    return `<span class="st ${i._status === "soon" ? "st-soon" : "st-open"}">${label}</span>`;
  }

  function itemHtml(i, members) {
    const others = members ? members.filter((m) => m.id !== i.id) : [];
    const open = st.openGroups.has(i.group);
    const meta = [i.org || i.ministry, i.source, i.region !== "전국" ? i.region : "전국", i.period && !/^\d{4}-\d{2}-\d{2}$/.test(i.period) ? i.period : ""]
      .filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join("");
    return `<li class="cl-item">
      <div class="t"><span class="cl-badges"><span class="tb tb-${esc(i.type)}">${esc(i.type)}</span>${others.length ? `<button type="button" class="grp-btn" data-grp="${esc(i.group)}" aria-expanded="${open}">유사 ${others.length + 1}건 ${open ? "▴" : "▾"}</button>` : ""}</span><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a></div>
      <div class="m">${meta}</div>
      <div class="r">${statusBadge(i)}<span>${i.deadline ? "마감 " + esc(i.deadline) : ""}</span><span>${i.posted ? "게시 " + esc(i.posted) : ""}</span></div>
      ${open && others.length ? `<ul class="grp-list">${others.map((m) => `<li><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a> <span style="color:var(--faint)">· ${esc(m.org || m.source)}${m.deadline ? " · 마감 " + esc(m.deadline) : ""}</span></li>`).join("")}</ul>` : ""}
    </li>`;
  }

  function renderList() {
    const rows = sortRows(filtered());
    $("cl-empty").hidden = rows.length > 0;
    const byCluster = {};
    rows.forEach((r) => (byCluster[r.cluster] = byCluster[r.cluster] || []).push(r));
    const html = CLUSTER_ORDER.filter((c) => byCluster[c]).map((c) => {
      let list = byCluster[c];
      let groups = null;
      if (st.grouped) {
        groups = {};
        list.forEach((r) => (groups[r.group] = groups[r.group] || []).push(r));
        const seen = new Set();
        list = list.filter((r) => (seen.has(r.group) ? false : seen.add(r.group)));
      }
      const all = st.expanded.has(c);
      const shown = all ? list : list.slice(0, PAGE_PER_SECTION);
      return `<div class="cl-section">
        <h3>${esc(c)} <span class="n">${byCluster[c].length}건${st.grouped ? ` · ${list.length}묶음` : ""}</span></h3>
        <ul class="cl-list">${shown.map((r) => itemHtml(r, groups ? groups[r.group] : null)).join("")}</ul>
        ${list.length > PAGE_PER_SECTION ? `<button type="button" class="cl-more" data-more="${esc(c)}">${all ? "접기" : `${list.length - PAGE_PER_SECTION}건 더 보기`}</button>` : ""}
      </div>`;
    }).join("");
    $("cl-results").innerHTML = html;
  }

  function renderAll() { renderMap(); renderList(); }

  // ---------- 칩·컨트롤 ----------
  function chipHtml(kind, val, label, n) {
    return `<button type="button" class="chip" data-k="${kind}" data-v="${esc(val)}" aria-pressed="false">${esc(label)} <span class="n">${n}</span></button>`;
  }
  const SETS = { type: () => st.types, source: () => st.sources, status: () => st.status };
  function syncChips() {
    document.querySelectorAll("#page-cluster .chip[data-k]").forEach((c) => c.setAttribute("aria-pressed", String(SETS[c.dataset.k]().has(c.dataset.v))));
  }

  function buildControls() {
    const sc = count(ITEMS, (i) => i._status);
    $("cl-status-chips").innerHTML = STATUS.map((s) => chipHtml("status", s.key, s.label, sc[s.key] || 0)).join("");
    const tc = count(ITEMS, (i) => i.type);
    $("cl-type-chips").innerHTML = TYPE_ORDER.filter((t) => tc[t]).map((t) => chipHtml("type", t, t, tc[t])).join("");
    const srcc = count(ITEMS, (i) => i.source);
    $("cl-source-chips").innerHTML = Object.keys(srcc).sort((a, b) => srcc[b] - srcc[a]).map((s) => chipHtml("source", s, s, srcc[s])).join("");
    const rc = count(ITEMS, (i) => i.region);
    $("cl-region").innerHTML = `<option value="">전체 지역</option>` +
      Object.keys(rc).sort((a, b) => (a === "전국" ? -1 : b === "전국" ? 1 : rc[b] - rc[a])).map((r) => `<option value="${esc(r)}">${esc(r)} (${rc[r]})</option>`).join("");

    document.querySelectorAll("#page-cluster .chip[data-k]").forEach((c) => c.addEventListener("click", () => {
      const set = SETS[c.dataset.k]();
      set.has(c.dataset.v) ? set.delete(c.dataset.v) : set.add(c.dataset.v);
      syncChips(); renderAll();
    }));
    $("cl-map").addEventListener("click", (e) => {
      const t = e.target.closest(".cl-tile");
      if (!t) return;
      const v = t.dataset.cl;
      st.clusters.has(v) ? st.clusters.delete(v) : st.clusters.add(v);
      renderAll();
    });
    $("cl-results").addEventListener("click", (e) => {
      const g = e.target.closest(".grp-btn");
      if (g) { st.openGroups.has(g.dataset.grp) ? st.openGroups.delete(g.dataset.grp) : st.openGroups.add(g.dataset.grp); renderList(); return; }
      const m = e.target.closest(".cl-more");
      if (m) { st.expanded.has(m.dataset.more) ? st.expanded.delete(m.dataset.more) : st.expanded.add(m.dataset.more); renderList(); }
    });
    $("cl-q").addEventListener("input", (e) => { st.q = e.target.value; renderAll(); });
    const mc = count(ITEMS, (i) => i._ministry);
    const ministries = Object.keys(mc).sort((a, b) => {
      const ka = /(부|처|청|위원회)$/.test(a) ? 0 : 1, kb = /(부|처|청|위원회)$/.test(b) ? 0 : 1;
      return ka - kb || mc[b] - mc[a];
    });
    $("cl-ministry").innerHTML = `<option value="">전체 소관부처·기관</option>` +
      ministries.map((m) => `<option value="${esc(m)}">${esc(m)} (${mc[m]})</option>`).join("");
    $("cl-ministry").addEventListener("change", (e) => { st.ministry = e.target.value; renderAll(); });
    $("cl-region").addEventListener("change", (e) => { st.region = e.target.value; renderAll(); });
    $("cl-sort").addEventListener("change", (e) => { st.sort = e.target.value; renderList(); });
    $("cl-group-toggle").addEventListener("change", (e) => { st.grouped = e.target.checked; renderList(); });
    $("cl-export").addEventListener("click", exportXlsx);
  }

  function exportXlsx() {
    if (typeof XLSX === "undefined") { alert("엑셀 라이브러리를 불러오지 못했습니다."); return; }
    const rows = sortRows(filtered()).map((i) => ({
      분야클러스터: i.cluster, 공고유형: i.type, 상태: STATUS.find((s) => s.key === i._status).label,
      공고명: i.title, 기관: i.org, 소관부처: i.ministry, 출처: i.source, 지역: i.region,
      신청기간: i.period, 마감일: i.deadline, 게시일: i.posted, 유사묶음수: i.group_size, 링크: i.url,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [14, 10, 10, 60, 22, 16, 12, 8, 26, 12, 12, 8, 60].map((w) => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "공고클러스터");
    const d = new Date();
    XLSX.writeFile(wb, `공고클러스터_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.xlsx`);
  }

  function renderSourceStatus() {
    const when = META.collected_at ? META.collected_at.replace("T", " ").slice(0, 16) : "-";
    const mode = META.mode === "seed" ? " · 초기 스냅샷" : "";
    $("cl-updated").textContent = `${when} 수집${mode}, 총 ${ITEMS.length.toLocaleString()}건`;
    $("cl-src-status").innerHTML = (META.sources || []).map((s) =>
      `<span class="${s.ok ? "ok" : "fail"}" title="${esc(s.error || s.url || "")}">${s.ok ? "✓" : "✕"} ${esc(s.source)} ${s.ok ? s.count + "건" : "실패"}</span>`).join("");
  }

  renderKpis();
  buildControls();
  renderSourceStatus();
  renderAll();
})();
