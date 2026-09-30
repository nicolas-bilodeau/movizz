// A tiny fake TMDB used by the browser tests, so they run offline and deterministically.
const P = (id, name, gender) => ({ id, name, gender });
const people = {
  coppola: P(100, "Francis Ford Coppola", 2), scorsese: P(101, "Martin Scorsese", 2), allen: P(102, "Woody Allen", 2),
  king: P(103, "Paul King", 2), donen: P(104, "Stanley Donen", 2), kurosawa: P(105, "Akira Kurosawa", 2), polanski: P(106, "Roman Polanski", 2),
  brando: P(200, "Marlon Brando", 2), pacino: P(201, "Al Pacino", 2), deniro: P(202, "Robert De Niro", 2), sheen: P(204, "Martin Sheen", 2),
  hackman: P(205, "Gene Hackman", 2), whishaw: P(206, "Ben Whishaw", 2), nicholson: P(207, "Jack Nicholson", 2), mifune: P(208, "Toshirō Mifune", 2), kelly: P(209, "Gene Kelly", 2), liotta: P(210, "Ray Liotta", 2),
  keaton: P(300, "Diane Keaton", 1), hawkins: P(301, "Sally Hawkins", 1), dunaway: P(302, "Faye Dunaway", 1), reynolds: P(303, "Debbie Reynolds", 1), bracco: P(304, "Lorraine Bracco", 1),
};
const M = (id, title, year, genres, dir, cast, recs = [], extra = {}) => ({ id, title, original_title: title, release_date: `${year}-06-01`, genres, dir, cast, recs, runtime: 120, vote_average: 8, vote_count: 5000, popularity: 50, poster_path: `/p${id}.jpg`, overview: `Résumé de ${title}.`, ...extra });
export const movies = [
  M(1, "The Godfather", 1972, [80, 18], ["coppola"], ["brando", "pacino", "keaton"], [2, 3, 10], { runtime: 175, fr: "Le Parrain" }),
  M(2, "The Godfather Part II", 1974, [80, 18], ["coppola"], ["pacino", "deniro", "keaton"], [1, 3]),
  M(3, "Goodfellas", 1990, [80, 18], ["scorsese"], ["liotta", "deniro", "bracco"], [1, 2]),
  M(4, "Annie Hall", 1977, [35, 10749], ["allen"], ["allen", "keaton"], [8], { runtime: 93 }),
  M(5, "Paddington 2", 2017, [35, 10751, 12], ["king"], ["whishaw", "hawkins"], [8], { runtime: 103 }),
  M(6, "Apocalypse Now", 1979, [10752, 18], ["coppola"], ["sheen", "brando"], [9]),
  M(7, "The Conversation", 1974, [53, 9648], ["coppola"], ["hackman"], [10]),
  M(8, "Singin' in the Rain", 1952, [35, 10402, 10749], ["donen"], ["kelly", "reynolds"], [4], { runtime: 103 }),
  M(9, "Seven Samurai", 1954, [28, 12, 18], ["kurosawa"], ["mifune"], [6], { original_title: "七人の侍", fr: "Les Sept Samouraïs" }),
  M(10, "Chinatown", 1974, [80, 18, 9648, 53], ["polanski"], ["nicholson", "dunaway"], [1, 7], { runtime: 130 }),
];
const byId = Object.fromEntries(movies.map(m => [m.id, m]));
const providersByMovie = {
  5: { flatrate: [{ provider_id: 8, provider_name: "Netflix" }] },
  3: { flatrate: [{ provider_id: 230, provider_name: "Crave" }] },
  4: { rent: [{ provider_id: 2, provider_name: "Apple TV" }] },
  10: { flatrate: [{ provider_id: 8, provider_name: "Netflix" }] },
};
let lang = "en-US";
const titleIn = (m, l) => (l.startsWith("fr") && m.fr ? m.fr : m.title);
const result = m => ({ id: m.id, title: titleIn(m, lang), original_title: m.original_title, release_date: m.release_date, poster_path: m.poster_path, genre_ids: m.genres, vote_average: m.vote_average, vote_count: m.vote_count, popularity: m.popularity });
const wp = id => ({ id, results: providersByMovie[id] ? { CA: { link: `https://www.themoviedb.org/movie/${id}/watch?locale=CA`, ...providersByMovie[id] } } : {} });
const genreNames = { 28: "Action", 12: "Aventure", 16: "Animation", 35: "Comédie", 80: "Crime", 99: "Documentaire", 18: "Drame", 10751: "Familial", 14: "Fantastique", 36: "Histoire", 27: "Horreur", 10402: "Musique", 9648: "Mystère", 10749: "Romance", 878: "Science-Fiction", 53: "Thriller", 10752: "Guerre", 37: "Western" };

export const calls = [];
export function handle(urlStr) {
  const url = new URL(urlStr);
  const path = url.pathname.replace(/^\/3/, "");
  const q = Object.fromEntries(url.searchParams);
  lang = q.language || "en-US";
  calls.push(path);
  if (q.api_key === "bad") return [401, { status_message: "Invalid API key" }];
  let m;
  if (path === "/configuration") return [200, { images: {} }];
  if (path === "/genre/movie/list") return [200, { genres: Object.entries(genreNames).map(([id, name]) => ({ id: +id, name })) }];
  if (path === "/watch/providers/movie") return [200, { results: [{ provider_id: 8, provider_name: "Netflix", logo_path: "/netflix.jpg", display_priorities: { CA: 1 } }, { provider_id: 230, provider_name: "Crave", logo_path: "/crave.jpg", display_priorities: { CA: 2 } }, { provider_id: 119, provider_name: "Amazon Prime Video", logo_path: "/prime.jpg", display_priorities: { CA: 3 } }] }];
  if (path === "/search/movie") {
    const needle = (q.query || "").toLowerCase();
    let hits = movies.filter(m => [m.title, m.original_title, m.fr].some(t => t && t.toLowerCase().includes(needle)));
    if (q.year) hits = hits.filter(m => Math.abs(+m.release_date.slice(0, 4) - +q.year) <= 1);
    return [200, { page: 1, results: hits.map(result), total_results: hits.length }];
  }
  if ((m = path.match(/^\/movie\/(\d+)\/watch\/providers$/))) return [200, wp(+m[1])];
  if ((m = path.match(/^\/movie\/(\d+)$/))) {
    const mv = byId[+m[1]]; if (!mv) return [404, {}];
    return [200, {
      id: mv.id, title: titleIn(mv, lang), original_title: mv.original_title, release_date: mv.release_date, poster_path: mv.poster_path, overview: mv.overview, runtime: mv.runtime,
      vote_average: mv.vote_average, vote_count: mv.vote_count, popularity: mv.popularity, genres: mv.genres.map(id => ({ id, name: genreNames[id] })),
      credits: { cast: mv.cast.map((k, i) => ({ ...people[k], order: i, character: "" })), crew: mv.dir.map(k => ({ ...people[k], job: "Director" })) },
      keywords: { keywords: [] },
      recommendations: { results: mv.recs.map(id => result(byId[id])) },
      similar: { results: [] },
      "watch/providers": wp(mv.id),
      translations: { translations: [{ iso_639_1: "en", iso_3166_1: "US", data: { title: mv.title } }, ...(mv.fr ? [{ iso_639_1: "fr", iso_3166_1: "FR", data: { title: mv.fr } }] : [])] },
    }];
  }
  if ((m = path.match(/^\/person\/(\d+)\/movie_credits$/))) {
    const pid = +m[1];
    const key = Object.keys(people).find(k => people[k].id === pid);
    return [200, {
      cast: movies.filter(mv => mv.cast.includes(key)).map(result),
      crew: movies.filter(mv => mv.dir.includes(key)).map(mv => ({ ...result(mv), job: "Director" })),
    }];
  }
  if (path === "/discover/movie") {
    const without = (q.without_genres || "").split(",").filter(Boolean).map(Number);
    return [200, { results: movies.filter(mv => !mv.genres.some(g => without.includes(g))).map(result) }];
  }
  return [404, { status_message: "not mocked: " + path }];
}
