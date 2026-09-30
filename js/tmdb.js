// Thin TMDB v3 client. Accepts either a v3 API key or a v4 read access token.
const BASE = "https://api.themoviedb.org/3";
export const REGION = "CA";
// Titles come from en-US (for non-Latin originals); descriptive text and genre names in French.
export const LANG = "en-US";
export const TEXT_LANG = "fr-CA";

export const img = (path, size = "w342") => (path ? `https://image.tmdb.org/t/p/${size}${path}` : null);

export class TmdbError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class Tmdb {
  constructor(key) {
    this.key = (key || "").trim();
    this.bearer = this.key.startsWith("eyJ");
    this.memo = new Map();
  }

  async get(path, params = {}) {
    const url = new URL(BASE + path);
    const all = { language: LANG, ...params };
    for (const [k, v] of Object.entries(all)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    if (!this.bearer) url.searchParams.set("api_key", this.key);
    const cacheKey = url.toString();
    if (this.memo.has(cacheKey)) return this.memo.get(cacheKey);
    const p = (async () => {
      const res = await fetch(url, { headers: this.bearer ? { Authorization: `Bearer ${this.key}`, accept: "application/json" } : { accept: "application/json" } });
      if (!res.ok) {
        this.memo.delete(cacheKey);
        throw new TmdbError(res.status, res.status === 401 ? "Clé TMDB refusée." : `TMDB a répondu ${res.status}.`);
      }
      return res.json();
    })();
    this.memo.set(cacheKey, p);
    return p;
  }

  check() { return this.get("/configuration", { language: undefined }); }
  genres() { return this.get("/genre/movie/list", { language: TEXT_LANG }); }
  providers() { return this.get("/watch/providers/movie", { watch_region: REGION }); }
  search(query, year) { return this.get("/search/movie", { query, year, include_adult: "false" }); }
  details(id) { return this.get(`/movie/${id}`, { language: TEXT_LANG, append_to_response: "credits,keywords,recommendations,similar,watch/providers,translations" }); }
  watchProviders(id) { return this.get(`/movie/${id}/watch/providers`, { language: undefined }); }
  personCredits(id) { return this.get(`/person/${id}/movie_credits`); }
  discover(params) { return this.get("/discover/movie", { include_adult: "false", ...params }); }
}

// Compact the parts of a details payload the app keeps per film.
// Original title when it is written in Latin script, otherwise the US English title.
const LATIN = /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]+$/u;
export function displayTitle(original, english) {
  if (original && LATIN.test(original)) return original;
  return english || original || "";
}
function englishTitle(d) {
  const tr = d.translations?.translations || [];
  const pickT = t => t?.data?.title;
  return pickT(tr.find(t => t.iso_639_1 === "en" && t.iso_3166_1 === "US")) || pickT(tr.find(t => t.iso_639_1 === "en")) || "";
}

export function summarize(d) {
  const crew = d.credits?.crew || [];
  const cast = (d.credits?.cast || []).slice().sort((a, b) => a.order - b.order).slice(0, 10);
  return {
    id: d.id,
    t: displayTitle(d.original_title, englishTitle(d)) || d.title,
    ot: d.original_title,
    tv: 2,
    y: d.release_date ? +d.release_date.slice(0, 4) : null,
    poster: d.poster_path || null,
    overview: d.overview || "",
    runtime: d.runtime || null,
    vote: d.vote_average || 0,
    votes: d.vote_count || 0,
    pop: d.popularity || 0,
    g: (d.genres || []).map(g => g.id),
    dirs: crew.filter(c => c.job === "Director").map(c => ({ id: c.id, name: c.name })),
    cast: cast.map(c => ({ id: c.id, name: c.name, gender: c.gender })),
    kw: (d.keywords?.keywords || []).slice(0, 20).map(k => k.id),
    recs: uniqueIds([...(d.recommendations?.results || []), ...(d.similar?.results || [])]).slice(0, 40),
    prov: providersFrom(d["watch/providers"]),
    at: Date.now(),
  };
}

export function providersFrom(wp) {
  const ca = wp?.results?.[REGION];
  const ids = list => (list || []).map(p => p.provider_id);
  return {
    flat: uniq([...ids(ca?.flatrate), ...ids(ca?.free), ...ids(ca?.ads)]),
    rent: ids(ca?.rent),
    buy: ids(ca?.buy),
    link: ca?.link || null,
    at: Date.now(),
  };
}

// Lightweight film shape from a search/list result (no credits).
export function fromResult(r) {
  return {
    id: r.id,
    t: displayTitle(r.original_title, r.title),
    ot: r.original_title,
    y: r.release_date ? +r.release_date.slice(0, 4) : null,
    poster: r.poster_path || null,
    g: r.genre_ids || [],
    vote: r.vote_average || 0,
    votes: r.vote_count || 0,
    pop: r.popularity || 0,
  };
}

const uniq = a => [...new Set(a)];
function uniqueIds(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) if (!seen.has(r.id)) { seen.add(r.id); out.push(r.id); }
  return out;
}
