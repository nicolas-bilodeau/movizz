// Bump ?v= on every import (and in index.html) with each release: GitHub Pages lets browsers cache modules.
import { Tmdb, TmdbError, img, summarize, providersFrom, fromResult, TV } from "./tmdb.js?v=5";
import { state, save, onChange, statusOf, backlog, watched, putFilm, patchFilm, removeFilm, touchSettings, refCache, saveRefCache, provCache, saveProvCache, exportJSON, importJSON } from "./store.js?v=5";
import { configured as syncConfigured, startSync, onSyncChange, syncState, signIn, signOut, createHousehold, joinHousehold, syncNow, frMessage } from "./sync.js?v=5";
import { buildCategories, mood } from "./reco.js?v=5";

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const uniq = a => [...new Set(a)];
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2800); }
const errMsg = e => (e instanceof TmdbError ? e.message : "TMDB est injoignable pour l'instant. Vérifiez votre connexion.");
const fmtRuntime = m => (m ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : "");

let tmdb = state.settings.key ? new Tmdb(state.settings.key) : null;
let GENRES = {};           // id -> name
let PROVIDERS = [];        // CA providers from TMDB
const PROV_BY_ID = {};
let catalogue = { lists: [], films: [] };

/* ---------- film presentation ---------- */
const gname = id => GENRES[id] || "";
function posterHTML(f, cls = "poster") {
  const url = img(f.poster, cls === "poster" ? "w342" : "w154");
  if (url) return `<div class="${cls} has-img"><img src="${url}" alt="" loading="lazy"></div>`;
  const h = [...String(f.t)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0) % 360;
  const bg = `linear-gradient(160deg, hsl(${h} 32% 24%), #100e0a)`;
  if (cls !== "poster") return `<div class="${cls}" style="background:${bg}"></div>`;
  return `<div class="poster" style="background:${bg}"><div class="pt">${esc(f.t)}</div><div class="py">${esc(f.y || "")}</div></div>`;
}
function provOf(f) { return state.films[f.id]?.prov || f.prov || provCache[f.id] || null; }
function available(f) {
  const p = provOf(f); if (!p) return false;
  const subs = state.settings.subs;
  if (p.flat.some(id => subs.includes(id))) return true;
  return state.settings.rent && (p.rent.length > 0 || p.buy.length > 0);
}
function provsHTML(f) {
  const p = provOf(f);
  if (!p) return "";
  if (!p.flat.length) return `<span class="note">${p.rent.length || p.buy.length ? "En location ou à l'achat" : "Pas offert en diffusion au Canada"}</span>`;
  const mine = new Set(state.settings.subs);
  const sorted = [...p.flat].sort((a, b) => (mine.has(b) ? 1 : 0) - (mine.has(a) ? 1 : 0)).slice(0, 6);
  return `<span class="provs">${sorted.map(id => {
    const pr = PROV_BY_ID[id];
    return pr?.logo_path ? `<img class="prov-logo ${mine.has(id) ? "mine" : ""}" src="${img(pr.logo_path, "w45")}" alt="${esc(pr.provider_name)}" title="${esc(pr.provider_name)}">` : `<span class="tag prov">${esc(pr?.provider_name || id)}</span>`;
  }).join("")}</span>`;
}
function jwLink(f) { return provOf(f)?.link || `https://www.justwatch.com/ca/recherche?q=${encodeURIComponent(f.t)}`; }
const castLine = f => (f.cast || []).slice(0, 3).map(c => c.name).join(", ");
const dirLine = f => (f.dirs || []).map(d => d.name).join(", ");
const LIST_SHORT = { tspdt: "TSPDT", rt: "RT", imdb: "IMDb" };
function refTags(f) {
  const out = [];
  for (const c of catalogue.films) if (refCache[c.id]?.id === f.id) for (const [k, r] of Object.entries(c.l)) out.push(`${LIST_SHORT[k] || k} #${r}`);
  return out;
}

/* ---------- TMDB-backed actions ---------- */
async function fullFilm(id) {
  const d = await tmdb.details(id);
  return { details: d, film: summarize(d) };
}
async function addToBacklog(idOrFilm, origin = "") {
  const id = typeof idOrFilm === "object" ? idOrFilm.id : idOrFilm;
  if (statusOf(id) === "backlog") { toast("Déjà dans le backlog."); return; }
  try {
    const { film } = await fullFilm(id);
    putFilm(film, { status: "backlog", addedAt: Date.now(), o: origin || state.films[id]?.o || "" });
    toast(`Ajouté au backlog : ${film.t}`);
  } catch (e) { toast(errMsg(e)); }
}
async function markWatched(id) {
  try {
    const film = state.films[id]?.cast ? state.films[id] : (await fullFilm(id)).film;
    putFilm(film, { status: "watched", watchedAt: Date.now(), addedAt: state.films[id]?.addedAt || Date.now() });
    toast(`Marqué comme vu : ${film.t}`);
    if (!lastManual) setLast(state.films[id], false);
  } catch (e) { toast(errMsg(e)); }
}

/* ---------- tabs ---------- */
let tab = "soir";
function showTab(t) {
  tab = t;
  $$("#tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === t));
  $$("section.view").forEach(s => (s.hidden = s.id !== "view-" + t));
  try { localStorage.setItem("movizz.tab", t); } catch {}
  render();
}
$("#tabs").addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (b) showTab(b.dataset.tab); });
const segValue = id => $(`#${id} button[aria-pressed="true"]`)?.dataset.v;
function wireSeg(id, cb) {
  $("#" + id).addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    $$(`#${id} button`).forEach(x => x.setAttribute("aria-pressed", x === b));
    cb && cb(b.dataset.v);
  });
}

/* ---------- autocomplete over TMDB search ---------- */
function wireSearch(root, onPick) {
  const input = $("input", root), list = $(".ac-list", root);
  let items = [], hl = -1, seq = 0;
  const draw = () => {
    list.innerHTML = items.map((f, i) => `<button type="button" data-i="${i}" class="${i === hl ? "hl" : ""}">${f.poster ? `<img src="${img(f.poster, "w92")}" alt="">` : `<span class="noimg"></span>`}<span>${esc(f.t)} <span class="sub">${esc(f.y || "")}${f.ot && f.ot !== f.t ? " · " + esc(f.ot) : ""}${statusOf(f.id) ? " · " + (statusOf(f.id) === "watched" ? "vu" : "au backlog") : ""}</span></span></button>`).join("");
    list.hidden = !items.length;
  };
  const run = debounce(async q => {
    const my = ++seq;
    if (q.length < 2 || !tmdb) { items = []; draw(); return; }
    try {
      const data = await tmdb.search(q);
      if (my !== seq) return;
      items = data.results.slice(0, 8).map(fromResult);
      hl = -1; draw();
    } catch (e) { toast(errMsg(e)); }
  }, 250);
  input.addEventListener("input", () => run(input.value.trim()));
  input.addEventListener("keydown", e => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { hl = Math.min(hl + 1, items.length - 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { hl = Math.max(hl - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === "Enter") { e.preventDefault(); const f = items[hl >= 0 ? hl : 0]; if (f) choose(f); }
    else if (e.key === "Escape") list.hidden = true;
  });
  list.addEventListener("mousedown", e => e.preventDefault());
  list.addEventListener("click", e => { const b = e.target.closest("button"); if (b) choose(items[+b.dataset.i]); });
  input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 150));
  function choose(f) { list.hidden = true; onPick(f, input); }
}

/* ---------- random draw ---------- */
const selGenres = new Set(), selOrigins = new Set();
let drawnId = null;
function drawPool() {
  const m = segValue("moodSeg");
  return backlog().filter(f => {
    if (m !== "any" && mood(f) !== m) return false;
    if ($("#shortOnly").checked && (!f.runtime || f.runtime > 105)) return false;
    if ($("#availOnly").checked && !available(f)) return false;
    if (selGenres.size && !(f.g || []).some(g => selGenres.has(g))) return false;
    if (selOrigins.size && !selOrigins.has(f.o || "")) return false;
    return true;
  });
}
function renderDraw() {
  const bl = backlog();
  const gs = uniq(bl.flatMap(f => f.g || [])).filter(gname).sort((a, b) => gname(a).localeCompare(gname(b)));
  $("#genreChips").innerHTML = gs.length ? gs.map(g => `<button class="chip" data-g="${g}" aria-pressed="${selGenres.has(g)}">${esc(gname(g))}</button>`).join("") : `<span class="note">Les genres apparaîtront quand le backlog aura des films.</span>`;
  const origins = uniq(bl.map(f => f.o).filter(Boolean)).sort();
  $("#originRow").hidden = !origins.length;
  $("#originChips").innerHTML = origins.map(o => `<button class="chip" data-o="${esc(o)}" aria-pressed="${selOrigins.has(o)}">${esc(o)}</button>`).join("");
  const n = drawPool().length;
  $("#drawPool").textContent = bl.length ? `${n} film${n > 1 ? "s" : ""} possible${n > 1 ? "s" : ""} sur ${bl.length}` : "";
  $("#drawBtn").disabled = !n;
  const box = $("#drawResult");
  if (!bl.length) box.innerHTML = `<div class="empty-state"><h3>Le backlog est vide</h3><p class="note">Ajoutez des films dans l'onglet Backlog, ou piochez dans les listes références.</p><div class="row"><button class="btn primary" data-act="gotab" data-tab="backlog">Ajouter des films</button><button class="btn" data-act="gotab" data-tab="listes">Parcourir les listes</button></div></div>`;
  else if (drawnId && state.films[drawnId]) box.innerHTML = ticketHTML(state.films[drawnId]);
  else if (!n) box.innerHTML = `<p class="note">Aucun film ne correspond à ces filtres.${$("#availOnly").checked && !state.settings.subs.length ? " Cochez d'abord vos plateformes dans Réglages." : " Essayez d'en retirer un."}</p>`;
  else box.innerHTML = "";
}
function ticketHTML(f, kicker = "Ce soir, on regarde") {
  const st = statusOf(f.id);
  return `<div class="ticket"><div class="stub">${posterHTML(f)}</div><div class="body">
    <div class="kicker">${esc(kicker)}</div>
    <p class="title">${esc(f.t)}</p>
    <div class="meta">${esc(f.y || "")}${f.runtime ? " · " + fmtRuntime(f.runtime) : ""}${dirLine(f) ? ` · de <b>${esc(dirLine(f))}</b>` : ""}</div>
    ${castLine(f) ? `<div class="meta">Avec ${esc(castLine(f))}</div>` : ""}
    ${f.overview ? `<p class="overview">${esc(f.overview)}</p>` : ""}
    <div class="tags">${(f.g || []).map(g => `<span class="tag">${esc(gname(g))}</span>`).join("")}${refTags(f).map(t => `<span class="tag list">${esc(t)}</span>`).join("")}${f.o ? `<span class="tag src">${esc(f.o)}</span>` : ""}</div>
    <div class="row">${provsHTML(f)}</div>
    <div class="row">
      ${st !== "watched" ? `<button class="btn primary small" data-act="watch" data-id="${f.id}">On l'a regardé</button>` : `<span class="tag">Déjà vu</span>`}
      ${st === null ? `<button class="btn small" data-act="add" data-id="${f.id}">Ajouter au backlog</button>` : ""}
      <button class="btn small ghost" data-act="seed-last" data-id="${f.id}">Recommandations à partir de ce film</button>
      <a class="btn small ghost" href="${jwLink(f)}" target="_blank" rel="noopener">Où le voir ↗</a>
    </div></div></div>`;
}
$("#genreChips").addEventListener("click", e => { const b = e.target.closest(".chip"); if (!b) return; const g = +b.dataset.g; selGenres.has(g) ? selGenres.delete(g) : selGenres.add(g); drawnId = null; renderDraw(); });
$("#originChips").addEventListener("click", e => { const b = e.target.closest(".chip"); if (!b) return; const o = b.dataset.o; selOrigins.has(o) ? selOrigins.delete(o) : selOrigins.add(o); drawnId = null; renderDraw(); });
wireSeg("moodSeg", () => { drawnId = null; renderDraw(); });
["shortOnly", "availOnly"].forEach(id => $("#" + id).addEventListener("change", () => { drawnId = null; renderDraw(); }));
$("#drawBtn").addEventListener("click", () => {
  let pool = drawPool(); if (!pool.length) return;
  if (pool.length > 1) pool = pool.filter(f => f.id !== drawnId);
  const f = pick(pool);
  const box = $("#drawResult");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || pool.length < 3) { drawnId = f.id; renderDraw(); return; }
  let i = 0;
  const iv = setInterval(() => {
    box.innerHTML = ticketHTML(pick(pool), "…");
    if (++i > 8) { clearInterval(iv); drawnId = f.id; renderDraw(); $(".ticket", box)?.classList.add("pop"); }
  }, 70);
});

/* ---------- reference lists (resolved to TMDB ids once, cached) ---------- */
let resolving = null;
function refEntries(listIds) {
  const out = [];
  for (const lid of listIds) {
    if (state.lists[lid]) state.lists[lid].items.forEach((it, i) => out.push({ key: `${lid}:${norm(it.t)}:${it.y || ""}`, t: it.t, y: it.y, rank: i + 1 }));
    else catalogue.films.filter(c => c.l[lid]).forEach(c => out.push({ key: c.id, t: c.t, y: c.y, rank: c.l[lid] }));
  }
  return out;
}
async function resolveOne(e) {
  if (e.key in refCache) return refCache[e.key];
  let hit = null;
  try {
    let data = await tmdb.search(e.t, e.y);
    if (!data.results.length && e.y) data = await tmdb.search(e.t);
    const r = data.results.find(r => e.y && r.release_date && Math.abs(+r.release_date.slice(0, 4) - e.y) <= 1) || data.results[0];
    hit = r ? fromResult(r) : null;
  } catch (err) {
    if (err instanceof TmdbError && err.status === 401) throw err;
    return null; // transient: retry next time
  }
  refCache[e.key] = hit;
  return hit;
}
async function resolveRefs(listIds, onProgress) {
  const entries = refEntries(listIds).filter(e => !(e.key in refCache));
  let done = 0;
  const queue = [...entries];
  const worker = async () => { while (queue.length) { await resolveOne(queue.shift()); done++; onProgress?.(done, entries.length); if (done % 20 === 0) saveRefCache(); } };
  await Promise.all(Array.from({ length: 6 }, worker));
  saveRefCache();
}
function refFilmsMap(listIds) {
  const m = new Map();
  for (const e of refEntries(listIds)) { const f = refCache[e.key]; if (f) m.set(f.id, state.films[f.id] || f); }
  return m;
}
function allRefLists() {
  return [...catalogue.lists.map(l => ({ ...l, custom: false })), ...Object.values(state.lists).map(l => ({ id: l.id, name: l.name, custom: true }))];
}

/* ---------- recommendations ---------- */
let last = null, lastManual = false, recoSeq = 0;
const offsets = {};
const selRefs = new Set(["tspdt", "rt"]);
let lastCats = null;
function setLast(f, manual) {
  last = f; lastManual = !!manual;
  Object.keys(offsets).forEach(k => delete offsets[k]);
  $("#lastInput").value = f ? f.t : "";
  computeReco();
}
wireSearch($("#lastAc"), f => setLast(f, true));
wireSeg("scopeSeg", () => { Object.keys(offsets).forEach(k => delete offsets[k]); computeReco(); });
$("#availOnly2").addEventListener("change", () => renderRecoGrid());
$("#refChips").addEventListener("click", e => { const b = e.target.closest(".chip"); if (!b) return; const l = b.dataset.l; selRefs.has(l) && selRefs.size > 1 ? selRefs.delete(l) : selRefs.add(l); computeReco(); });

async function computeReco() {
  const scope = segValue("scopeSeg");
  $("#refChips").hidden = scope !== "refs";
  $("#refChips").innerHTML = allRefLists().map(l => `<button class="chip" data-l="${esc(l.id)}" aria-pressed="${selRefs.has(l.id)}">${esc(l.name)}</button>`).join("");
  const head = $("#recoHead"), grid = $("#recoGrid");
  if (!tmdb) { head.innerHTML = ""; grid.innerHTML = ""; return; }
  if (!last) {
    const w = watched()[0];
    if (w) { setLast(w, false); return; }
    head.innerHTML = `<p class="note">Choisissez un film ci-dessus pour obtenir des suggestions.</p>`; grid.innerHTML = ""; return;
  }
  const my = ++recoSeq;
  head.innerHTML = `<p class="note"><span class="spin"></span> Recherche de pistes à partir de ${esc(last.t)}…</p>`;
  try {
    const { details, film: src } = await fullFilm(last.id);
    let refFilms = new Map(), refIds = new Set();
    if (scope === "refs") {
      await resolveRefs([...selRefs], (d, n) => { if (my === recoSeq) head.innerHTML = `<p class="note">Première utilisation : Movizz associe les listes à TMDB (${d}/${n}).</p><div class="progress"><div style="width:${Math.round((d / n) * 100)}%"></div></div>`; });
      refFilms = refFilmsMap([...selRefs]); refIds = new Set(refFilms.keys());
    }
    const excluded = new Set(watched().map(f => f.id));
    const cats = await buildCategories(scope, { tmdb, details, src, backlog: backlog(), refFilms, refIds, excluded, gname });
    if (my !== recoSeq) return;
    lastCats = { src, cats, scope };
    renderRecoGrid();
  } catch (e) {
    if (my === recoSeq) { head.innerHTML = `<p class="note">${esc(errMsg(e))}</p>`; grid.innerHTML = ""; }
  }
}
async function ensureProviders(films) {
  const need = films.filter(f => !provOf(f)).slice(0, 12);
  await Promise.all(need.map(async f => {
    try { provCache[f.id] = providersFrom(await tmdb.watchProviders(f.id)); } catch {}
  }));
  if (need.length) saveProvCache();
}
async function renderRecoGrid() {
  if (!lastCats) return;
  const { src, cats, scope } = lastCats;
  const my = recoSeq;
  const availOnly = $("#availOnly2").checked;
  const scopeName = { backlog: "votre backlog", refs: "les listes choisies", all: "TMDB" }[scope];
  const head = $("#recoHead"), grid = $("#recoGrid");
  head.innerHTML = `<div class="row"><span class="meta">À partir de <b>${esc(src.t)}</b>${src.y ? ` (${src.y})` : ""}${dirLine(src) ? `, de ${esc(dirLine(src))}` : ""}</span>
    ${statusOf(src.id) !== "watched" ? `<button class="btn small" data-act="watch" data-id="${src.id}">Marquer comme vu</button>` : ""}</div>`;
  if (availOnly) {
    if (!state.settings.subs.length) head.innerHTML += `<p class="note">Cochez d'abord vos plateformes dans Réglages.</p>`;
    grid.innerHTML = `<p class="note"><span class="spin"></span> Vérification des plateformes…</p>`;
    await Promise.all(cats.map(c => ensureProviders(c.items.slice(0, 12))));
    if (my !== recoSeq) return;
  }
  grid.innerHTML = cats.map(c => {
    const items = availOnly ? c.items.filter(available) : c.items;
    const n = items.length, off = (offsets[c.key] || 0) % Math.max(n, 1), f = items[off];
    if (!f) return `<div class="sugg empty"><div class="cat">${esc(c.title)}<small>${esc(c.sub)}</small></div><div class="sb"><div class="ft">Rien dans ${scopeName}${availOnly ? " sur vos plateformes" : ""}.</div>
      <div class="acts">${scope !== "all" ? `<button class="btn small" data-act="scope" data-v="${scope === "backlog" ? "refs" : "all"}">Chercher dans ${scope === "backlog" ? "les listes" : "tous les films"}</button>` : ""}</div></div></div>`;
    const st = statusOf(f.id);
    return `<div class="sugg"><div class="cat">${esc(c.title)}<small>${esc(c.sub)}</small></div>
      <div class="sp">${posterHTML(f, "mini-fill")}</div>
      <div class="sb">
        <div class="ft">${esc(f.t)} <span class="meta">${esc(f.y || "")}</span></div>
        <div class="why">${esc(c.why(f))}</div>
        <div class="row">${provsHTML(f)}</div>
        <div class="acts">
          ${st === null ? `<button class="btn small" data-act="add" data-id="${f.id}">+ Backlog</button>` : st === "backlog" ? `<span class="tag">Au backlog</span>` : ""}
          <button class="btn small" data-act="watch" data-id="${f.id}">Vu</button>
          ${n > 1 ? `<button class="btn small ghost" data-act="next" data-k="${c.key}">Autre (${off + 1}/${n})</button>` : ""}
        </div>
      </div></div>`;
  }).join("");
  // Show availability for the visible suggestions even when the filter is off.
  if (!availOnly) {
    const visible = cats.map(c => c.items[(offsets[c.key] || 0) % Math.max(c.items.length, 1)]).filter(Boolean);
    const missing = visible.filter(f => !provOf(f));
    if (missing.length) { await ensureProviders(missing); if (my === recoSeq && !$("#availOnly2").checked) renderRecoGrid(); }
  }
}

/* ---------- backlog ---------- */
wireSearch($("#addAc"), (f, input) => { addToBacklog(f.id, $("#addOrigin").value.trim()); input.value = ""; });
let blLimit = 60;
function rowHTML(f, opts = {}) {
  const st = statusOf(f.id);
  return `<div class="item ${st === "watched" ? "watched" : ""}">
    ${posterHTML(f, "mini")}
    <div style="min-width:0">
      <div class="it">${opts.rank ? `<span class="rank">#${opts.rank}</span> ` : ""}${esc(f.t)}<span class="yr">${esc(f.y || "")}${f.runtime ? " · " + fmtRuntime(f.runtime) : ""}</span></div>
      <div class="im">${esc([dirLine(f), castLine(f)].filter(Boolean).join(" · "))}</div>
      <div class="tags" style="margin-top:4px">${(f.g || []).slice(0, 3).map(g => `<span class="tag">${esc(gname(g))}</span>`).join("")}${f.o ? `<span class="tag src">${esc(f.o)}</span>` : ""}${opts.watchedAt && f.watchedAt ? `<span class="tag">vu le ${new Date(f.watchedAt).toLocaleDateString("fr-CA")}</span>` : ""}</div>
      ${st === "backlog" ? `<div class="row" style="margin-top:4px">${provsHTML(f)}</div>` : ""}
    </div>
    <div class="ia">
      ${opts.missing ? `<span class="note">Introuvable sur TMDB</span>` : opts.loading ? `<span class="spin" aria-label="Recherche"></span>` : ""}
      ${st === null && f.id ? `<button class="btn small" data-act="add" data-id="${f.id}">+ Backlog</button>` : ""}
      ${!f.id ? "" : st !== "watched" ? `<button class="btn small" data-act="watch" data-id="${f.id}">Vu</button>` : `<button class="btn small ghost" data-act="unwatch" data-id="${f.id}">Remettre à voir</button>`}
      ${st === "backlog" ? `<button class="btn small ghost" data-act="remove" data-id="${f.id}">Retirer</button>` : ""}
    </div></div>`;
}
function renderBacklog() {
  const q = norm($("#blSearch").value);
  let items = backlog();
  if (!items.length) { $("#blList").innerHTML = `<div class="empty-state"><h3>Le backlog est vide</h3><p class="note">Cherchez un film ci-dessus, importez une liste, ou piochez dans les listes références.</p></div>`; return; }
  if (q) items = items.filter(f => [f.t, f.ot, f.o, dirLine(f), castLine(f)].some(x => norm(x).includes(q)));
  if ($("#blAvail").checked) items = items.filter(available);
  const cmp = { added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0), title: (a, b) => norm(a.t).localeCompare(norm(b.t)), year: (a, b) => (a.y || 0) - (b.y || 0), runtime: (a, b) => (a.runtime || 999) - (b.runtime || 999) }[$("#blSort").value];
  items.sort(cmp);
  $("#blList").innerHTML = items.length ? `<div class="list">${items.slice(0, blLimit).map(f => rowHTML(f)).join("")}</div>${items.length > blLimit ? `<div class="pager"><button class="btn" data-act="more-bl">Afficher plus (${items.length - blLimit})</button></div>` : ""}` : `<p class="note">Aucun film ne correspond.</p>`;
}
$("#blSearch").addEventListener("input", () => { blLimit = 60; renderBacklog(); });
["blSort", "blAvail"].forEach(id => $("#" + id).addEventListener("change", () => { blLimit = 60; renderBacklog(); }));

/* ---------- import ---------- */
export function parseCSV(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
export function parseImport(text) {
  const rows = parseCSV(text.trim());
  const header = rows[0]?.map(h => h.trim().toLowerCase()) || [];
  const col = (...names) => names.map(n => header.indexOf(n)).find(i => i >= 0) ?? -1;
  const ti = col("title", "series_title", "name");
  if (ti >= 0 && rows.length > 1) {
    const yi = col("year", "released_year"), ty = col("title type");
    // Letterboxd diary: "Watched Date"; Letterboxd watched.csv: "Date" (when it was logged).
    const wi = col("watched date", "date");
    const items = rows.slice(1).filter(r => !(ty >= 0 && r[ty] && !/movie|film|documentary/i.test(r[ty]))).map(r => ({ t: (r[ti] || "").trim(), y: parseInt(r[yi]) || null, w: wi >= 0 ? Date.parse(r[wi] + "T20:00:00") || null : null })).filter(x => x.t);
    // A diary lists rewatches as separate entries: keep one per film, with the latest date.
    const byKey = new Map();
    for (const it of items) {
      const k = `${norm(it.t)}:${it.y || ""}`, prev = byKey.get(k);
      if (!prev || (it.w || 0) > (prev.w || 0)) byKey.set(k, it);
    }
    return [...byKey.values()];
  }
  return text.split(/\n+/).map(l => l.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean).map(line => {
    const m = line.match(/^(.*?)\s*[([]?((?:18|19|20)\d{2})[)\]]?\s*$/);
    return m && m[1] ? { t: m[1].replace(/[\s,\-–|]+$/, ""), y: +m[2] } : { t: line, y: null };
  });
}
wireSeg("impDest");
$("#impFile").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  $("#impText").value = await file.text();
  if (!$("#impName").value) $("#impName").value = file.name.replace(/\.[^.]+$/, "");
  e.target.value = "";
});
$("#impGo").addEventListener("click", async () => {
  if (!tmdb) { toast("Ajoutez d'abord votre clé TMDB."); return; }
  const items = parseImport($("#impText").value);
  const note = $("#impNote");
  if (!items.length) { note.textContent = "Aucun titre reconnu."; return; }
  const name = $("#impName").value.trim() || "Liste importée";
  if (segValue("impDest") === "ref") {
    const id = "l-" + Date.now().toString(36);
    state.lists[id] = { id, name, items, u: Date.now() };
    save();
    selRefs.add(id);
    note.textContent = `Liste « ${name} » créée (${items.length} films). Elle sera associée à TMDB à la première utilisation.`;
    $("#impText").value = "";
    return;
  }
  const asWatched = segValue("impDest") === "watched";
  $("#impGo").disabled = true;
  let ok = 0, missing = [];
  for (const [i, it] of items.entries()) {
    note.textContent = `Import… ${i + 1}/${items.length}`;
    const hit = await resolveOne({ key: `imp:${norm(it.t)}:${it.y || ""}`, t: it.t, y: it.y }).catch(() => null);
    if (!hit) { missing.push(it.t); continue; }
    const cur = state.films[hit.id];
    if (asWatched) {
      // Already seen on an equal or later date: nothing to change.
      if (cur?.status === "watched" && (cur.watchedAt || 0) >= (it.w || 0)) continue;
      try {
        const film = cur?.cast ? cur : (await fullFilm(hit.id)).film;
        const when = it.w || Date.now();
        putFilm(film, { status: "watched", watchedAt: when, addedAt: cur?.addedAt || when, o: cur?.o || name });
        ok++;
      } catch { missing.push(it.t); }
    } else if (!statusOf(hit.id)) {
      try { const { film } = await fullFilm(hit.id); putFilm(film, { status: "backlog", addedAt: Date.now(), o: name }); ok++; } catch { missing.push(it.t); }
    }
  }
  saveRefCache();
  $("#impGo").disabled = false;
  note.textContent = `${ok} films ${asWatched ? "marqués comme vus" : "ajoutés"}.${missing.length ? ` Introuvables : ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""}` : ""}`;
  $("#impText").value = "";
});

/* ---------- lists view ---------- */
let curList = "tspdt", lsLimit = 60;
async function renderLists() {
  const lists = allRefLists();
  if (!lists.find(l => l.id === curList)) curList = "tspdt";
  $("#listPick").innerHTML = lists.map(l => `<button class="chip" data-l="${esc(l.id)}" aria-pressed="${l.id === curList}">${esc(l.name)}</button>`).join("");
  const meta = lists.find(l => l.id === curList);
  const entries = refEntries([curList]).sort((a, b) => a.rank - b.rank);
  const q = norm($("#lsSearch").value);
  const hideSeen = $("#lsHideSeen").checked;
  let rows = entries.map(e => ({ e, f: refCache[e.key] ? state.films[refCache[e.key].id] || refCache[e.key] : undefined }));
  if (q) rows = rows.filter(({ e, f }) => norm(e.t).includes(q) || norm(f?.t).includes(q));
  if (hideSeen) rows = rows.filter(({ f }) => !f || statusOf(f.id) !== "watched");
  const seen = entries.filter(e => refCache[e.key] && statusOf(refCache[e.key].id) === "watched").length;
  $("#listNote").innerHTML = `${entries.length} films · vous en avez vu ${seen}` + (meta.url ? ` · <a href="${meta.url}" target="_blank" rel="noopener">source ↗</a>` : "") + (meta.custom ? ` · <button class="btn small ghost" data-act="del-list" data-id="${esc(meta.id)}">Supprimer cette liste</button>` : "");
  const shown = rows.slice(0, lsLimit);
  $("#lsList").innerHTML = shown.length ? `<div class="list">${shown.map(({ e, f }) => (f ? rowHTML(f, { rank: e.rank }) : rowHTML({ id: 0, t: e.t, y: e.y }, { rank: e.rank, missing: f === null, loading: f === undefined }))).join("")}</div>${rows.length > lsLimit ? `<div class="pager"><button class="btn" data-act="more-ls">Afficher plus (${rows.length - lsLimit})</button></div>` : ""}` : `<p class="note">Rien à afficher.</p>`;
  // Resolve the visible rows that are not matched yet, then redraw.
  const todo = shown.filter(r => r.f === undefined).map(r => r.e);
  if (todo.length && tmdb) {
    const my = ++listSeq;
    for (let i = 0; i < todo.length; i += 6) await Promise.all(todo.slice(i, i + 6).map(e => resolveOne(e).catch(() => null)));
    saveRefCache();
    if (my === listSeq && tab === "listes") renderLists();
  }
}
let listSeq = 0;
$("#listPick").addEventListener("click", e => { const b = e.target.closest(".chip"); if (!b) return; curList = b.dataset.l; lsLimit = 60; renderLists(); });
$("#lsSearch").addEventListener("input", debounce(renderLists, 200));
$("#lsHideSeen").addEventListener("change", renderLists);

/* ---------- watched ---------- */
function renderVus() {
  const w = watched();
  $("#vusList").innerHTML = w.length ? `<div class="list">${w.map(f => rowHTML(f, { watchedAt: true })).join("")}</div>` : `<div class="empty-state"><h3>Aucun film vu pour l'instant</h3><p class="note">Après une séance, appuyez sur « Vu » : le film ne sera plus proposé et servira de point de départ aux recommandations.</p></div>`;
}

/* ---------- settings ---------- */
function renderSettings() {
  $("#keyInput").value = state.settings.key || "";
  const q = norm($("#provSearch").value);
  const subs = new Set(state.settings.subs);
  const list = PROVIDERS.filter(p => subs.has(p.provider_id) || !q || norm(p.provider_name).includes(q));
  const shown = q ? list : list.filter((p, i) => subs.has(p.provider_id) || i < 40);
  $("#subsChips").innerHTML = PROVIDERS.length ? shown.map(p => `<button class="chip" data-sub="${p.provider_id}" aria-pressed="${subs.has(p.provider_id)}">${p.logo_path ? `<img src="${img(p.logo_path, "w45")}" alt="">` : ""}${esc(p.provider_name)}</button>`).join("") : `<span class="note">La liste des plateformes apparaîtra une fois la clé TMDB enregistrée.</span>`;
  $("#rentOk").checked = !!state.settings.rent;
}
$("#provSearch").addEventListener("input", renderSettings);
$("#subsChips").addEventListener("click", e => {
  const b = e.target.closest(".chip"); if (!b) return;
  const id = +b.dataset.sub, s = new Set(state.settings.subs);
  s.has(id) ? s.delete(id) : s.add(id);
  state.settings.subs = [...s]; touchSettings();
});
$("#rentOk").addEventListener("change", e => { state.settings.rent = e.target.checked; touchSettings(); });
$("#keySave").addEventListener("click", async () => {
  const key = $("#keyInput").value.trim();
  const note = $("#keyNote");
  if (!key) { note.textContent = "Collez d'abord la clé."; return; }
  note.innerHTML = `<span class="spin"></span> Vérification…`;
  const t = new Tmdb(key);
  try {
    await t.check();
    tmdb = t; state.settings.key = key; touchSettings();
    note.textContent = "Clé enregistrée. TMDB répond.";
    await loadReference();
    render();
  } catch (e) { note.textContent = errMsg(e); }
});
$("#exportBtn").addEventListener("click", () => {
  const blob = new Blob([exportJSON()], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `movizz-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("#importFile").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  try { const n = importJSON(await file.text()); $("#backupNote").textContent = `${n} films fusionnés.`; }
  catch (err) { $("#backupNote").textContent = err.message || "Fichier illisible."; }
  e.target.value = "";
});

/* ---------- shared foyer ---------- */
let syncNote = "", syncShown = "";
const hhmm = t => new Date(t).toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" });
function renderSync() {
  const panel = $("#syncPanel");
  panel.hidden = !syncConfigured;
  if (!syncConfigured) return;
  const s = syncState(), body = $("#syncBody");
  const note = syncNote || s.lastError;
  const statusHTML = s.syncing ? `<span class="spin"></span> Synchronisation…` : s.lastError ? esc(s.lastError) : s.lastSync ? `Synchronisé à ${hhmm(s.lastSync)}.` : "";
  // Rebuild only when the step changes, so typing in a field is never wiped by a background sync.
  const shownKey = [s.phase, s.email, s.household?.name, s.household?.code, s.phase === "ready" ? "" : note].join("|");
  if (shownKey === syncShown && body.childElementCount) { const st = $("#syncStatus"); if (st) st.innerHTML = statusHTML; return; }
  syncShown = shownKey;
  const noteHTML = note ? `<p class="note" id="syncNote">${esc(note)}</p>` : "";
  if (s.phase === "loading") body.innerHTML = `<p class="note"><span class="spin"></span> Connexion au foyer…</p>`;
  else if (s.phase === "signed-out") body.innerHTML = `
    <p class="note">Connectez-vous pour partager le backlog, les films vus, les plateformes et la clé TMDB entre vos appareils et avec l'autre cinéphile de la maison. Vous recevrez un lien par courriel, sans mot de passe.</p>
    <form class="row" id="syncLogin"><input type="email" id="syncEmail" class="grow" placeholder="Votre courriel" autocomplete="email" required><button class="btn primary">Recevoir le lien</button></form>${noteHTML}`;
  else if (s.phase === "no-household") body.innerHTML = `
    <p class="note">Connecté : <b>${esc(s.email)}</b>. Créez votre foyer, ou entrez le code reçu de l'autre personne.</p>
    <div class="twocol">
      <form class="stack" id="syncCreate"><label class="label" for="syncName">Nouveau foyer</label><input type="text" id="syncName" placeholder="Ex. Chez nous"><div><button class="btn primary">Créer notre foyer</button></div></form>
      <form class="stack" id="syncJoin"><label class="label" for="syncCode">Rejoindre avec un code</label><input type="text" id="syncCode" placeholder="Ex. 4F9A2C" autocomplete="off"><div><button class="btn">Rejoindre</button></div></form>
    </div>${noteHTML}
    <div><button class="btn small ghost" data-act="sync-out">Se déconnecter</button></div>`;
  else if (s.phase === "ready") body.innerHTML = `
    <p class="note">Foyer <b>${esc(s.household?.name || "")}</b> · connecté : <b>${esc(s.email)}</b></p>
    ${s.household?.code ? `<div class="invite"><span class="label">Code d'invitation</span><span class="code" id="syncCodeShow">${esc(s.household.code)}</span><span class="note">L'autre personne se connecte avec son courriel, puis choisit « Rejoindre avec un code ».</span></div>` : ""}
    <p class="note" id="syncStatus">${statusHTML}</p>
    <div class="row"><button class="btn" data-act="sync-now">Synchroniser maintenant</button><button class="btn small ghost" data-act="sync-out">Se déconnecter</button></div>`;
}
async function syncAction(fn, busyMsg) {
  syncNote = busyMsg; renderSync();
  try { await fn(); syncNote = ""; } catch (e) { syncNote = frMessage(e); }
  renderSync();
}
$("#syncBody").addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === "syncLogin") {
    const email = $("#syncEmail").value.trim();
    syncAction(async () => { await signIn(email); throw new Error(`Lien envoyé à ${email}. Ouvrez-le sur cet appareil pour vous connecter.`); }, "Envoi du lien…");
  } else if (f.id === "syncCreate") { const name = $("#syncName").value.trim(); syncAction(() => createHousehold(name), "Création du foyer…"); }
  else if (f.id === "syncJoin") { const code = $("#syncCode").value.trim(); syncAction(() => joinHousehold(code), "Recherche du foyer…"); }
});
onSyncChange(() => { if (tab === "reglages") renderSync(); });
function onRemoteChange() {
  // The foyer may bring the TMDB key to a device that had none.
  if (state.settings.key && state.settings.key !== tmdb?.key) {
    tmdb = new Tmdb(state.settings.key);
    loadReference().then(() => { render(); refreshTitles(); });
  }
}

/* ---------- global actions ---------- */
document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act, id = +b.dataset.id;
  if (act === "add") { b.disabled = true; await addToBacklog(id); }
  else if (act === "watch") { b.disabled = true; await markWatched(id); }
  else if (act === "unwatch") patchFilm(id, { status: "backlog", watchedAt: null });
  else if (act === "remove") { if (b.dataset.confirm) { removeFilm(id); toast("Retiré du backlog."); } else { b.dataset.confirm = "1"; b.textContent = "Confirmer?"; } }
  else if (act === "next") { offsets[b.dataset.k] = (offsets[b.dataset.k] || 0) + 1; renderRecoGrid(); }
  else if (act === "scope") { $$("#scopeSeg button").forEach(x => x.setAttribute("aria-pressed", x.dataset.v === b.dataset.v)); computeReco(); }
  else if (act === "seed-last") { setLast(state.films[id] || { id, t: $(".ticket .title")?.textContent || "" }, true); $("#lastInput").scrollIntoView({ behavior: "smooth", block: "center" }); }
  else if (act === "gotab") showTab(b.dataset.tab);
  else if (act === "sync-now") syncNow();
  else if (act === "sync-out") syncAction(signOut, "");
  else if (act === "more-bl") { blLimit += 60; renderBacklog(); }
  else if (act === "more-ls") { lsLimit += 60; renderLists(); }
  else if (act === "del-list") { if (b.dataset.confirm) { delete state.lists[b.dataset.id]; selRefs.delete(b.dataset.id); save(); } else { b.dataset.confirm = "1"; b.textContent = "Confirmer la suppression?"; } }
});

/* ---------- render + boot ---------- */
function render() {
  $("#needKey").hidden = !!tmdb || tab === "reglages";
  $("#cntBacklog").textContent = backlog().length || "";
  $("#cntVus").textContent = watched().length || "";
  if (tab === "soir") renderDraw();
  else if (tab === "backlog") renderBacklog();
  else if (tab === "listes") renderLists();
  else if (tab === "vus") renderVus();
  else if (tab === "reglages") { renderSettings(); renderSync(); }
}
let renderQueued = false;
onChange(() => {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    render();
    if (tab === "soir" && lastCats) renderRecoGrid();
  });
});

async function loadReference() {
  if (!tmdb) return;
  try {
    const [g, p] = await Promise.all([tmdb.genres(), tmdb.providers()]);
    GENRES = Object.fromEntries(g.genres.map(x => [x.id, x.name]));
    PROVIDERS = (p.results || []).sort((a, b) => (a.display_priorities?.CA ?? a.display_priority ?? 99) - (b.display_priorities?.CA ?? b.display_priority ?? 99));
    PROVIDERS.forEach(x => (PROV_BY_ID[x.provider_id] = x));
  } catch (e) { toast(errMsg(e)); }
}

// Refresh availability of backlog films older than a week, a few at a time.
// Films saved before the current title/poster rules get their summary refreshed once.
async function refreshTitles() {
  const old = Object.values(state.films).filter(f => f.tv !== TV);
  for (const f of old) {
    try { putFilm((await fullFilm(f.id)).film, {}, false); } catch { break; }
  }
}

async function refreshProviders() {
  const WEEK = 7 * 864e5;
  const stale = backlog().filter(f => !f.prov || Date.now() - (f.prov.at || 0) > WEEK).slice(0, 30);
  for (const f of stale) {
    try { patchFilm(f.id, { prov: providersFrom(await tmdb.watchProviders(f.id)) }, false); } catch { break; }
  }
}

async function boot() {
  try { catalogue = await (await fetch("data/catalogue.json")).json(); } catch { catalogue = { lists: [], films: [] }; }
  let t = "soir";
  try { t = localStorage.getItem("movizz.tab") || "soir"; } catch {}
  if (!tmdb) t = "reglages";
  showTab(t);
  startSync({ onRemoteChange });
  if (tmdb) {
    await loadReference();
    render();
    computeReco();
    refreshTitles().then(refreshProviders);
  }
}
boot();
