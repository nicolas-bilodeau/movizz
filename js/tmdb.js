// Thin TMDB v3 client. Accepts either a v3 API key or a v4 read access token.
const BASE = "https://api.themoviedb.org/3";
export const REGION = "CA";
// Titles and posters come from en-US (or the original language); descriptive text and genre names in French.
export const LANG = "en-US";
export const TEXT_LANG = "fr-CA";
// Poster languages fetched alongside en-US, so a film in a Latin-script language keeps its original poster.
const POSTER_LANGS = "en,null,fr,es,it,de,pt,nl,sv,da,no,fi,pl,cs,hu,ro,tr,ca";

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
  details(id) { return this.get(`/movie/${id}`, { append_to_response: "credits,keywords,recommendations,similar,watch/providers,translations,images", include_image_language: POSTER_LANGS }); }
  watchProviders(id) { return this.get(`/movie/${id}/watch/providers`, { language: undefined }); }
  personCredits(id) { return this.get(`/person/${id}/movie_credits`); }
  discover(params) { return this.get("/discover/movie", { include_adult: "false", ...params }); }
}

// Compact the parts of a details payload the app keeps per film.
// Original title when it is written in Latin script, otherwise the US English title.
// Bumped whenever the way titles or posters are picked changes, so saved films get refreshed once.
export const TV = 3;
const LATIN = /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]+$/u;
export function displayTitle(original, english) {
  if (original && LATIN.test(original)) return original;
  return english || original || "";
}
const translation = (d, lang, region, field) => {
  const tr = d.translations?.translations || [];
  const pick = t => t?.data?.[field];
  return pick(tr.find(t => t.iso_639_1 === lang && t.iso_3166_1 === region)) || pick(tr.find(t => t.iso_639_1 === lang && t.data?.[field])) || "";
};
const englishTitle = d => translation(d, "en", "US", "title") || d.title;
const frenchOverview = d => translation(d, "fr", "CA", "overview") || d.overview || "";
// Original-language poster when the title shown is the original one, otherwise the US poster.
function posterOf(d, t) {
  const lang = d.original_language;
  if (lang && lang !== "en" && t === d.original_title) {
    const p = (d.images?.posters || []).filter(x => x.iso_639_1 === lang).sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))[0];
    if (p) return p.file_path;
  }
  return d.poster_path || null;
}

export function summarize(d) {
  const t = displayTitle(d.original_title, englishTitle(d)) || d.title;
  const crew = d.credits?.crew || [];
  const cast = (d.credits?.cast || []).slice().sort((a, b) => a.order - b.order).slice(0, 10);
  return {
    id: d.id,
    t,
    ot: d.original_title,
    tv: TV,
    y: d.release_date ? +d.release_date.slice(0, 4) : null,
    poster: posterOf(d, t),
    overview: frenchOverview(d),
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
