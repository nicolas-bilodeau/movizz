// Recommendation engine: five angles from the last film watched, searched in one of three pools.
import { fromResult } from "./tmdb.js";

export const LIGHT = new Set([35, 10751, 16, 10402, 10749, 12]);
export const HEAVY = new Set([27, 10752, 53, 80]);

export function mood(film) {
  const g = film.g || [];
  const light = g.some(x => LIGHT.has(x)) && !g.some(x => x === 27 || x === 10752);
  const heavy = g.some(x => HEAVY.has(x)) || (g.includes(18) && !g.includes(35));
  return light && !heavy ? "light" : heavy && !light ? "heavy" : "mixed";
}

function jaccard(a = [], b = []) {
  if (!a.length || !b.length) return 0;
  const B = new Set(b);
  const inter = a.filter(x => B.has(x)).length;
  return inter / (new Set([...a, ...b]).size);
}

export function similarity(src, f) {
  const recBoost = src.recs?.includes(f.id) ? 0.5 : 0;
  return recBoost + jaccard(src.g, f.g) * 0.35 + jaccard(src.kw, f.kw) * 0.15;
}
export function opposition(src, f) {
  const moodGap = mood(src) !== mood(f) && mood(f) !== "mixed" ? 0.3 : 0;
  return (1 - jaccard(src.g, f.g)) * 0.6 + moodGap + Math.min(f.votes || 0, 5000) / 5000 * 0.1;
}

// Leads: first-billed man and woman; TMDB gender 2 = man, 1 = woman. Fall back to billing order.
export function leads(src) {
  const cast = src.cast || [];
  return {
    actor: cast.find(c => c.gender === 2) || null,
    actress: cast.find(c => c.gender === 1) || null,
  };
}

/**
 * Build the five categories.
 * scope: "backlog" | "refs" | "all"
 * ctx: { tmdb, details (raw TMDB payload of the source), src (summary),
 *        backlog: film[], refIds: Set<number> | null, refFilms: Map<id, film>,
 *        excluded: Set<number>, gname: (genreId) => string }
 * Each category resolves to { key, title, sub, items: film[], why(film) }.
 */
export async function buildCategories(scope, ctx) {
  const { tmdb, details, src, excluded } = ctx;
  const keep = f => f && f.id !== src.id && !excluded.has(f.id);
  const { actor, actress } = leads(src);
  const dirs = src.dirs || [];

  const recResults = [...(details.recommendations?.results || []), ...(details.similar?.results || [])].map(fromResult);

  let pool;
  if (scope === "backlog") pool = ctx.backlog.filter(keep);
  else if (scope === "refs") pool = [...ctx.refFilms.values()].filter(keep);
  else pool = null; // whole TMDB: candidates come from API calls

  const inScope = f => keep(f) && (scope === "all" || (scope === "refs" ? ctx.refIds.has(f.id) : ctx.backlog.some(b => b.id === f.id)));
  const fromPool = f => (scope === "backlog" ? ctx.backlog.find(b => b.id === f.id) : scope === "refs" ? ctx.refFilms.get(f.id) || f : f);

  // 1. Same vein
  let line;
  if (pool) {
    line = pool.map(f => [similarity(src, f), f]).filter(x => x[0] > 0.05).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  } else {
    line = dedupe(recResults).filter(keep);
  }
  line = line.filter(f => !(f.dirs || []).some(d => dirs.some(x => x.id === d.id)));

  // 2. Opposite
  let opp;
  if (pool) {
    opp = pool.map(f => [opposition(src, f), f]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  } else {
    const without = (src.g || []).join(",");
    const page = 1 + Math.floor(Math.random() * 3);
    const data = await tmdb.discover({ without_genres: without, sort_by: "vote_average.desc", "vote_count.gte": 1500, page });
    opp = data.results.map(fromResult).filter(keep);
  }

  // 3. Same director, 4-5. Lead actor / actress: person credits intersected with the pool.
  const personFilms = async (person, role) => {
    if (!person) return [];
    const data = await tmdb.personCredits(person.id);
    const list = role === "director" ? (data.crew || []).filter(c => c.job === "Director") : data.cast || [];
    const films = dedupe(list.map(fromResult)).filter(f => f.y);
    return films.filter(inScope).map(fromPool).sort((a, b) => (b.votes || 0) - (a.votes || 0));
  };
  const dirFilms = dedupe((await Promise.all(dirs.slice(0, 2).map(d => personFilms(d, "director")))).flat());
  const [actorFilms, actressFilms] = await Promise.all([personFilms(actor, "cast"), personFilms(actress, "cast")]);

  const inCommon = f => (f.g || []).filter(g => (src.g || []).includes(g));
  return [
    { key: "line", title: "Même lignée", sub: "ton et genres proches", items: line, why: f => (src.recs?.includes(f.id) ? "Recommandé par TMDB à partir de ce film" : inCommon(f).length ? `En commun : ${inCommon(f).map(ctx.gname).join(", ").toLowerCase()}` : "Ambiance proche") },
    { key: "opp", title: "Tout le contraire", sub: "pour changer d'air", items: opp, why: () => "Aucun genre en commun" },
    { key: "dir", title: "Même réalisation", sub: dirs.map(d => d.name).join(", ") || "inconnue", items: dirFilms, why: f => `${f.y || ""}` },
    { key: "actor", title: "L'acteur principal", sub: actor?.name || "inconnu", items: actorFilms, why: () => `Avec ${actor?.name}` },
    { key: "actress", title: "L'actrice principale", sub: actress?.name || "inconnue", items: actressFilms, why: () => `Avec ${actress?.name}` },
  ];
}

function dedupe(films) {
  const seen = new Set();
  return films.filter(f => (seen.has(f.id) ? false : (seen.add(f.id), true)));
}
