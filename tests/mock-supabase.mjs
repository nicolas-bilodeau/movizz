// In-memory Supabase used by the browser tests (see mock-supabase-client.js).
export const db = { households: [], members: [], films: [], lists: [] };
let clock = Date.parse("2026-01-01T00:00:00Z");
const now = () => new Date((clock += 1000)).toISOString();
const match = (row, filters) => filters.every(([op, c, v]) => (op === "eq" ? row[c] === v : row[c] > v));
const project = (row, cols) => (cols === "*" ? { ...row } : Object.fromEntries(cols.split(",").map(c => [c, row[c]])));

export function handle(q) {
  if (q.op === "rpc") {
    if (!q.uid) return { data: null, error: { message: "Connexion requise" } };
    const fail = message => ({ data: null, error: { message } });
    const join = h => {
      db.members = db.members.filter(m => m.user_id !== q.uid || m.household_id === h.id);
      if (!db.members.some(m => m.household_id === h.id && m.user_id === q.uid)) db.members.push({ household_id: h.id, user_id: q.uid, joined_at: now() });
      return { data: h.id, error: null };
    };
    if (q.name === "create_household") {
      if ((q.args.p_password || "").length < 6) return fail("Mot de passe trop court");
      const h = { id: "h" + (db.households.length + 1), name: q.args.p_name || "Notre foyer", code: "AB12C" + (db.households.length + 1), settings: {}, settings_u: 0, password: q.args.p_password, has_password: true };
      db.households.push(h);
      return join(h);
    }
    if (q.name === "join_household") {
      const h = db.households.find(x => x.code === String(q.args.p_code).trim().toUpperCase());
      if (h && !h.password) return fail("Pas de mot de passe");
      if (!h || h.password !== q.args.p_password) return fail("Code ou mot de passe incorrect");
      return join(h);
    }
    if (q.name === "set_household_password") {
      if ((q.args.p_password || "").length < 6) return fail("Mot de passe trop court");
      for (const m of db.members.filter(m => m.user_id === q.uid)) Object.assign(db.households.find(h => h.id === m.household_id), { password: q.args.p_password, has_password: true });
      return { data: null, error: null };
    }
  }
  const table = db[q.table];
  if (q.op === "upsert") {
    for (const r of q.rows) {
      const i = table.findIndex(x => x.household_id === r.household_id && x.id === r.id);
      const row = { ...structuredClone(r), at: now() };
      i >= 0 ? (table[i] = row) : table.push(row);
    }
    return { data: null, error: null };
  }
  if (q.op === "update") {
    table.filter(r => match(r, q.filters)).forEach(r => Object.assign(r, structuredClone(q.values)));
    return { data: null, error: null };
  }
  let rows = table.filter(r => match(r, q.filters));
  if (q.order) rows = rows.sort((a, b) => (a[q.order] < b[q.order] ? -1 : 1));
  if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
  if (q.limit) rows = rows.slice(0, q.limit);
  return { data: rows.map(r => project(r, q.cols || "*")), error: null };
}
