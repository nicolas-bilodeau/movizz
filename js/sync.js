// Shared "foyer" through Supabase. Local-first: the app keeps working from localStorage;
// this module pushes local changes and pulls the other devices' changes when signed in.
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js?v=5";
import { state, save, onChange } from "./store.js?v=5";

const LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
const META_KEY = "movizz.sync.v1";
const PAGE = 1000;
export const configured = !!(SUPABASE_URL && SUPABASE_KEY);

// What this device last agreed on with the foyer: stamp per film/list (negative = known deleted),
// and the server time of the last rows pulled.
const freshMeta = hid => ({ hid, films: {}, lists: {}, filmsAt: null, listsAt: null });
let meta = (() => { try { return JSON.parse(localStorage.getItem(META_KEY)) || freshMeta(null); } catch { return freshMeta(null); } })();
const writeMeta = () => { try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch {} };

let sb = null, user = null, household = null, channel = null;
let phase = configured ? "loading" : "off"; // off | loading | out | ready
let lastSync = 0, lastError = "", syncing = false, again = false, applying = false;
let onRemote = () => {};
const listeners = new Set();
export const onSyncChange = fn => listeners.add(fn);
const emit = () => listeners.forEach(fn => fn());
export const syncState = () => ({ configured, phase, email: user?.email || "", household, lastSync, lastError, syncing });

export function frMessage(e) {
  const m = String(e?.message || e || "");
  if (/Code ou mot de passe incorrect/i.test(m)) return "Code ou mot de passe incorrect.";
  if (/Pas de mot de passe/i.test(m)) return "Ce foyer n'a pas encore de mot de passe. Définissez-le dans Réglages, sur un appareil déjà connecté au foyer.";
  if (/trop court/i.test(m)) return "Le mot de passe doit avoir au moins 6 caractères.";
  if (/anonymous sign-ins are disabled/i.test(m)) return "Supabase refuse les nouveaux appareils : activez « Allow anonymous sign-ins » (Authentication › Sign In / Providers).";
  if (/fetch|network|Failed to/i.test(m)) return "Supabase est injoignable pour l'instant.";
  return m || "Erreur inconnue.";
}

export async function startSync({ onRemoteChange } = {}) {
  if (!configured) return;
  if (onRemoteChange) onRemote = onRemoteChange;
  try {
    const { createClient } = await import(LIB);
    sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    // Supabase warns against awaiting its own calls inside this callback, hence the timeout.
    sb.auth.onAuthStateChange((event, session) => { if (event !== "INITIAL_SESSION") setTimeout(() => setUser(session?.user || null), 0); });
    const { data } = await sb.auth.getSession();
    await setUser(data.session?.user || null);
  } catch (e) {
    lastError = frMessage(e); phase = "out"; emit();
  }
  onChange(() => { if (!applying && phase === "ready") schedule(); });
  addEventListener("focus", () => schedule(0));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(0); });
  setInterval(() => { if (!document.hidden) schedule(0); }, 60_000);
}

let settingUser, acting = false;
async function setUser(u) {
  if (acting) return; // create/join handle the new session themselves
  if ((u && u.id === settingUser) || (u?.id === user?.id && phase !== "loading" && phase !== "out")) return;
  settingUser = u?.id;
  user = u;
  if (!u) { household = null; phase = "out"; unsubscribe(); emit(); settingUser = undefined; return; }
  try {
    // One foyer per device; an older account may still have several, so take the first one joined.
    const { data, error } = await sb.from("members").select("household_id,joined_at").eq("user_id", u.id).order("joined_at").limit(1);
    if (error) throw error;
    if (data.length) await enter(data[0].household_id);
    else { household = null; phase = "out"; emit(); }
  } catch (e) { lastError = frMessage(e); phase = "out"; emit(); }
  settingUser = undefined;
}

async function enter(hid) {
  if (meta.hid !== hid) meta = freshMeta(hid);
  household = { id: hid };
  phase = "ready";
  subscribe();
  emit();
  await syncNow();
}

/* ---------- foyer actions (throw on error; the caller shows the message) ---------- */
// Each device gets its own anonymous session; the foyer code + password is what grants access.
async function ensureSession() {
  const { data } = await sb.auth.getSession();
  if (data.session?.user) { user = data.session.user; return; }
  const { data: d, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  user = d.user || d.session?.user;
}
async function acting_(fn) { acting = true; try { return await fn(); } finally { acting = false; } }
export function createHousehold(name, password) {
  return acting_(async () => {
    if ((password || "").length < 6) throw new Error("Mot de passe trop court");
    await ensureSession();
    const { data, error } = await sb.rpc("create_household", { p_name: name || null, p_password: password });
    if (error) throw error;
    await enter(data);
  });
}
// Joining replaces this device's data with the foyer's: the foyer is the reference copy.
export function joinHousehold(code, password) {
  return acting_(async () => {
    await ensureSession();
    const { data, error } = await sb.rpc("join_household", { p_code: code, p_password: password });
    if (error) throw error;
    state.films = {}; state.lists = {};
    state.settings = { ...state.settings, u: 0 };
    meta = freshMeta(null);
    applying = true; save(); applying = false;
    await enter(data);
  });
}
export async function setHouseholdPassword(password) {
  if ((password || "").length < 6) throw new Error("Mot de passe trop court");
  const { error } = await sb.rpc("set_household_password", { p_password: password });
  if (error) throw error;
  await syncNow();
}
export async function leaveDevice() {
  unsubscribe();
  await sb.auth.signOut();
  user = null; household = null; phase = "out"; meta = freshMeta(null); writeMeta(); emit();
}

/* ---------- sync ---------- */
let timer = null;
function schedule(ms = 1200) {
  if (phase !== "ready") return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, ms);
}

export async function syncNow() {
  if (phase !== "ready") return;
  if (syncing) { again = true; return; }
  syncing = true; emit();
  try {
    await pull();
    await push();
    lastSync = Date.now(); lastError = "";
  } catch (e) {
    lastError = frMessage(e);
  }
  syncing = false; writeMeta(); emit();
  if (again) { again = false; schedule(0); }
}

async function fetchSince(table, since) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select("id,data,u,at").eq("household_id", household.id);
    // Overlap a little: rows committed out of order are simply applied twice.
    if (since) q = q.gt("at", new Date(Date.parse(since) - 5000).toISOString());
    const { data, error } = await q.order("at").range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) return out;
  }
}

async function pull() {
  const { data: hs, error } = await sb.from("households").select("id,name,code,settings,settings_u,has_password").eq("id", household.id).limit(1);
  if (error) throw error;
  if (!hs.length) { household = null; phase = "out"; meta = freshMeta(null); return; }
  household = hs[0];
  const [films, lists] = await Promise.all([fetchSince("films", meta.filmsAt), fetchSince("lists", meta.listsAt)]);
  applying = true;
  let changed = applySettings(household);
  for (const r of films) changed = applyRow(r, state.films, meta.films) || changed;
  for (const r of lists) changed = applyRow(r, state.lists, meta.lists) || changed;
  if (films.length) meta.filmsAt = films[films.length - 1].at;
  if (lists.length) meta.listsAt = lists[lists.length - 1].at;
  if (changed) save();
  applying = false;
  if (changed) onRemote();
}

// The newest change wins. A row this device deleted since the last sync (absent locally, positive stamp)
// only comes back if someone changed it after that sync.
function applyRow(r, local, known) {
  const cur = local[r.id];
  const k = known[r.id] || 0;
  const localU = cur ? cur.u || 0 : Math.max(k, 0);
  if (r.u <= localU) { if (cur && cur.u === r.u) known[r.id] = r.u; return false; }
  if (r.data?.deleted) { known[r.id] = -r.u; if (!cur) return false; delete local[r.id]; return true; }
  known[r.id] = r.u;
  local[r.id] = { ...r.data, u: r.u };
  return true;
}

function applySettings(h) {
  const s = state.settings;
  // Settings saved before sync existed have no stamp: they count as a change to share.
  if (!s.u && (s.key || s.subs.length)) s.u = 1;
  if ((h.settings_u || 0) <= (s.u || 0)) return false;
  const r = h.settings || {};
  state.settings = { ...s, subs: Array.isArray(r.subs) ? r.subs : s.subs, rent: !!r.rent, key: r.key || s.key, u: h.settings_u };
  return true;
}

async function push() {
  const hid = household.id;
  const rows = (local, known, key) => {
    const out = [];
    for (const x of Object.values(local)) {
      if (!x.u) x.u = x.watchedAt || x.addedAt || 1;
      if (known[x.id] !== x.u) out.push({ household_id: hid, id: x.id, data: x, u: x.u });
    }
    for (const id of Object.keys(known)) {
      if (known[id] > 0 && !local[id]) out.push({ household_id: hid, id: key(id), data: { deleted: true }, u: Date.now() });
    }
    return out;
  };
  for (const [table, local, known, key] of [["films", state.films, meta.films, Number], ["lists", state.lists, meta.lists, String]]) {
    const all = rows(local, known, key);
    for (let i = 0; i < all.length; i += 200) {
      const chunk = all.slice(i, i + 200);
      const { error } = await sb.from(table).upsert(chunk, { onConflict: "household_id,id" });
      if (error) throw error;
      for (const r of chunk) known[r.id] = r.data.deleted ? -r.u : r.u;
    }
  }
  const s = state.settings;
  if ((s.u || 0) > (household.settings_u || 0)) {
    const settings = { subs: s.subs, rent: !!s.rent, key: s.key || "" };
    const { error } = await sb.from("households").update({ settings, settings_u: s.u }).eq("id", hid);
    if (error) throw error;
    household = { ...household, settings, settings_u: s.u };
  }
}

function subscribe() {
  unsubscribe();
  if (!sb.channel) return;
  const f = { schema: "public", filter: `household_id=eq.${household.id}` };
  channel = sb.channel(`foyer-${household.id}`)
    .on("postgres_changes", { event: "*", table: "films", ...f }, () => schedule(300))
    .on("postgres_changes", { event: "*", table: "lists", ...f }, () => schedule(300))
    .subscribe();
}
function unsubscribe() {
  if (channel) { sb.removeChannel(channel); channel = null; }
}
