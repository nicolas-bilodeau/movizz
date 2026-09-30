// Stand-in for @supabase/supabase-js in the browser tests. Queries go to a fake endpoint the test
// routes to tests/mock-supabase.mjs, so two browser contexts share one in-memory database.
const SESSION = "mock-sb-session", PENDING = "mock-sb-pending";
const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };

export function createClient() {
  const listeners = new Set();
  const session = () => read(SESSION);
  const call = body => fetch("https://mock.supabase.co/__db", { method: "POST", body: JSON.stringify({ ...body, uid: session()?.user.id || null }) }).then(r => r.json());
  // Opening the magic link, as the test's stand-in for the email.
  window.__mockSbClickLink = () => {
    const email = read(PENDING);
    const s = { user: { id: "u-" + email, email } };
    localStorage.setItem(SESSION, JSON.stringify(s));
    listeners.forEach(cb => cb("SIGNED_IN", s));
  };
  const builder = table => {
    const q = { table, op: "select", filters: [] };
    const b = {
      select(cols = "*") { q.cols = cols; return b; },
      eq(c, v) { q.filters.push(["eq", c, v]); return b; },
      gt(c, v) { q.filters.push(["gt", c, v]); return b; },
      order(c) { q.order = c; return b; },
      range(a, z) { q.range = [a, z]; return b; },
      limit(n) { q.limit = n; return b; },
      upsert(rows) { q.op = "upsert"; q.rows = rows; return b; },
      update(values) { q.op = "update"; q.values = values; return b; },
      then(ok, ko) { return call(q).then(ok, ko); },
    };
    return b;
  };
  return {
    auth: {
      async getSession() { return { data: { session: session() }, error: null }; },
      onAuthStateChange(cb) { listeners.add(cb); cb("INITIAL_SESSION", session()); return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } }; },
      async signInWithOtp({ email }) {
        if (!/@/.test(email)) return { error: { message: "Unable to validate email address: invalid format" } };
        localStorage.setItem(PENDING, JSON.stringify(email));
        return { error: null };
      },
      async signInAnonymously() {
        const s = { user: { id: "anon-" + Math.random().toString(36).slice(2), is_anonymous: true } };
        localStorage.setItem(SESSION, JSON.stringify(s));
        listeners.forEach(cb => cb("SIGNED_IN", s));
        return { data: { user: s.user, session: s }, error: null };
      },
      async signOut() { localStorage.removeItem(SESSION); listeners.forEach(cb => cb("SIGNED_OUT", null)); return { error: null }; },
    },
    from: builder,
    rpc: (name, args) => call({ op: "rpc", name, args }),
    channel() { const c = { on: () => c, subscribe: () => c }; return c; },
    removeChannel() {},
  };
}
