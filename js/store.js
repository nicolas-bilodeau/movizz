// Local persistence. Everything lives in this browser; export/import moves it between devices.
const KEY = "movizz.v2";
const REF_KEY = "movizz.refs.v3"; // v3: titles and posters in original language or US English
const PROV_KEY = "movizz.prov.v1";

const empty = () => ({
  films: {},      // tmdbId -> film summary + {status: "backlog"|"watched", addedAt, watchedAt, o}
  lists: {},      // imported lists: id -> {id, name, items: [{t, y}]}
  settings: { key: "", subs: [], rent: false },
});

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const state = { ...empty(), ...read(KEY, {}) };
state.settings = { ...empty().settings, ...(state.settings || {}) };

const listeners = new Set();
export const onChange = fn => listeners.add(fn);
export function save() {
  if (!write(KEY, { films: state.films, lists: state.lists, settings: state.settings })) {
    console.warn("movizz: localStorage write failed");
  }
  listeners.forEach(fn => fn());
}

export const statusOf = id => state.films[id]?.status || null;
export const backlog = () => Object.values(state.films).filter(f => f.status === "backlog");
export const watched = () =>
  Object.values(state.films).filter(f => f.status === "watched").sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));

export function putFilm(summary, patch = {}) {
  const prev = state.films[summary.id] || {};
  state.films[summary.id] = { ...prev, ...summary, ...patch };
  save();
}
export function patchFilm(id, patch) {
  if (!state.films[id]) return;
  state.films[id] = { ...state.films[id], ...patch };
  save();
}
export function removeFilm(id) {
  delete state.films[id];
  save();
}

// Reference-list title -> TMDB match cache: "catalogueId" -> {id,t,y,poster,g,vote,votes} | null (not found)
export const refCache = read(REF_KEY, {});
export const saveRefCache = () => write(REF_KEY, refCache);

// Watch-provider cache for films outside the backlog: tmdbId -> providers
export const provCache = read(PROV_KEY, {});
export const saveProvCache = () => write(PROV_KEY, provCache);

export function exportJSON() {
  return JSON.stringify({ app: "movizz", version: 2, exportedAt: new Date().toISOString(), films: state.films, lists: state.lists, subs: state.settings.subs }, null, 1);
}
export function importJSON(text) {
  const data = JSON.parse(text);
  if (data.app !== "movizz" || !data.films) throw new Error("Ce fichier ne vient pas de Movizz.");
  let n = 0;
  for (const [id, f] of Object.entries(data.films)) {
    const cur = state.films[id];
    // Keep the most recent status change on either side.
    const stamp = x => Math.max(x?.addedAt || 0, x?.watchedAt || 0);
    if (!cur || stamp(f) > stamp(cur)) { state.films[id] = f; n++; }
  }
  Object.assign(state.lists, data.lists || {});
  if (Array.isArray(data.subs) && !state.settings.subs.length) state.settings.subs = data.subs;
  save();
  return n;
}
