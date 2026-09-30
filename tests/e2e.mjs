// Browser test against a mocked TMDB. Run: npm test (needs Playwright + Chromium installed).
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { handle } from "./mock-tmdb.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = createServer(async (req, res) => {
  try {
    const p = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname.replace(/\/$/, "/index.html")));
    res.writeHead(200, { "content-type": types[extname(p)] || "application/octet-stream" });
    res.end(await readFile(p));
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEElEQVR4nGM45MgDRAwoFABHCgZb7i+grwAAAABJRU5ErkJggg==", "base64");

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
await page.route(/image\.tmdb\.org/, r => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
await page.route(/api\.themoviedb\.org/, r => { const [status, body] = handle(r.request().url()); r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); });

const step = async (name, fn) => { await fn(); console.log("✓", name); };
const shot = name => process.env.SHOTS && page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true });

await page.goto(base);
await step("asks for a key on first visit", async () => {
  assert.equal(await page.isVisible("#view-reglages"), true);
});
await step("rejects a bad key", async () => {
  await page.fill("#keyInput", "bad");
  await page.click("#keySave");
  await page.waitForFunction(() => document.querySelector("#keyNote").textContent.includes("refusée"));
});
await step("accepts a good key and lists CA providers", async () => {
  await page.fill("#keyInput", "goodkey123");
  await page.click("#keySave");
  await page.waitForFunction(() => document.querySelector("#keyNote").textContent.includes("enregistrée"));
  await page.waitForSelector('#subsChips [data-sub="8"]');
  await page.click('#subsChips [data-sub="8"]');
});
await step("adds films to the backlog from TMDB search", async () => {
  await page.click('#tabs [data-tab="backlog"]');
  for (const [q, origin] of [["Paddington", "Famille"], ["Goodfellas", ""], ["Annie", ""], ["Chinatown", ""], ["Singin", "Comédies musicales"]]) {
    await page.fill("#addOrigin", origin);
    await page.fill("#addInput", q);
    await page.waitForSelector("#addAc .ac-list button");
    await page.click("#addAc .ac-list button");
    await page.waitForFunction(n => document.querySelectorAll("#blList .item").length === n, [["Paddington", 1], ["Goodfellas", 2], ["Annie", 3], ["Chinatown", 4], ["Singin", 5]].find(x => x[0] === q)[1]);
  }
  assert.equal(await page.textContent("#cntBacklog"), "5");
});
await step("imports a pasted list", async () => {
  await page.click("#importBox summary");
  await page.fill("#impText", "Seven Samurai (1954)\nFilm qui n'existe pas (2001)");
  await page.fill("#impName", "Import test");
  await page.click("#impGo");
  await page.waitForFunction(() => document.querySelector("#impNote").textContent.includes("ajoutés"));
  assert.match(await page.textContent("#impNote"), /1 films ajoutés.*Introuvables : Film qui n'existe pas/);
});
await step("titles are original, or US English for non-Latin originals", async () => {
  const titles = await page.$$eval("#blList .it", els => els.map(e => e.firstChild.textContent.trim()));
  assert.ok(titles.includes("Seven Samurai"), titles.join());
  assert.ok(!titles.some(t => /Samouraïs|七人/.test(t)));
});
await step("posters match the title shown, overviews stay in French", async () => {
  await page.fill("#impText", "The Godfather (1972)\nThe 400 Blows (1959)");
  await page.click("#impGo");
  await page.waitForFunction(() => document.querySelector("#impNote").textContent.includes("2 films ajoutés"));
  const films = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("movizz.v2")).films));
  const gf = films.find(f => f.id === 1), blows = films.find(f => f.id === 11);
  assert.equal(gf.t, "The Godfather");
  assert.equal(gf.poster, "/p1.jpg");
  assert.equal(gf.overview, "Résumé de Le Parrain.");
  assert.equal(blows.t, "Les Quatre Cents Coups");
  assert.equal(blows.poster, "/p11-fr.jpg");
  for (const id of [1, 11]) for (let i = 0; i < 2; i++) await page.click(`#blList [data-act="remove"][data-id="${id}"]`);
  await page.waitForFunction(() => document.querySelector("#cntBacklog").textContent === "6");
});
await step("imports a Kaggle-style IMDb CSV as a reference list", async () => {
  await page.fill("#impText", 'Poster_Link,Series_Title,Released_Year,Director\n"x",Chinatown,1974,Roman Polanski\n"y",Apollo 13,PG,Ron Howard');
  await page.fill("#impName", "Kaggle");
  await page.click('#impDest [data-v="ref"]');
  await page.click("#impGo");
  await page.waitForFunction(() => document.querySelector("#impNote").textContent.includes("2 films"));
  await page.click('#impDest [data-v="backlog"]');
});
await step("availability filter keeps only films on my platforms", async () => {
  await page.check("#blAvail");
  const titles = await page.$$eval("#blList .it", els => els.map(e => e.firstChild.textContent.trim()));
  assert.deepEqual(titles.sort(), ["Chinatown", "Paddington 2"]);
  await page.uncheck("#blAvail");
  await shot("backlog");
});
await step("random draw respects mood and availability", async () => {
  await page.click('#tabs [data-tab="soir"]');
  await page.click('#moodSeg [data-v="light"]');
  await page.check("#availOnly");
  assert.match(await page.textContent("#drawPool"), /^1 film possible sur 6/);
  await page.click("#drawBtn");
  await page.waitForFunction(() => document.querySelector("#drawResult .kicker")?.textContent.includes("Ce soir"));
  assert.equal(await page.textContent("#drawResult .title"), "Paddington 2");
  await page.uncheck("#availOnly");
  await page.click('#moodSeg [data-v="any"]');
});
await step("recommendations from the backlog", async () => {
  await page.fill("#lastInput", "The Godfather");
  await page.waitForSelector("#lastAc .ac-list button");
  await page.click("#lastAc .ac-list button");
  await page.waitForSelector("#recoGrid .sugg");
  const cats = await page.$$eval("#recoGrid .sugg", els => Object.fromEntries(els.map(e => [e.querySelector(".cat").firstChild.textContent.trim(), e.querySelector(".ft")?.textContent.trim()])));
  assert.match(cats["Même lignée"], /Goodfellas|Chinatown/);
  assert.match(cats["L'actrice principale"], /Annie Hall/);
  assert.match(cats["Tout le contraire"], /Paddington|Singin|Annie/);
  await shot("reco-backlog");
});
await step("recommendations across all of TMDB", async () => {
  await page.click('#scopeSeg [data-v="all"]');
  await page.waitForFunction(() => [...document.querySelectorAll("#recoGrid .cat")].length === 5 && !document.querySelector("#recoHead .spin"));
  const cats = await page.$$eval("#recoGrid .sugg", els => Object.fromEntries(els.map(e => [e.querySelector(".cat").firstChild.textContent.trim(), e.querySelector(".ft")?.textContent.trim()])));
  assert.match(cats["Même réalisation"], /Godfather Part II|Apocalypse|Conversation/);
  assert.match(cats["L'acteur principal"], /Apocalypse Now/);
});
await step("reference lists are matched to TMDB", async () => {
  await page.click('#scopeSeg [data-v="refs"]');
  await page.waitForFunction(() => document.querySelectorAll("#recoGrid .sugg").length === 5, null, { timeout: 30000 });
  const dir = await page.$eval("#recoGrid .sugg:nth-child(3) .ft", e => e.textContent);
  assert.match(dir, /Godfather Part II|Apocalypse|Conversation/);
});
await step("IMDb Top 1000 is a built-in list", async () => {
  await page.click('#tabs [data-tab="listes"]');
  await page.click('#listPick [data-l="imdb"]');
  await page.waitForFunction(() => document.querySelector("#listNote").textContent.startsWith("1000 films"));
  await page.waitForFunction(() => [...document.querySelectorAll("#lsList .it")].some(e => e.textContent.includes("The Godfather")), null, { timeout: 30000 });
});
await step("marking watched removes it from the backlog and future picks", async () => {
  await page.click('#tabs [data-tab="backlog"]');
  const before = await page.textContent("#cntBacklog");
  await page.click('#blList .item [data-act="watch"]');
  await page.waitForFunction(b => document.querySelector("#cntBacklog").textContent !== b, before);
  assert.equal(await page.textContent("#cntVus"), "1");
});
await step("data survives a reload", async () => {
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#cntBacklog").textContent === "5");
});
await step("films saved with an old French title are refreshed", async () => {
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("movizz.v2"));
    const f = Object.values(s.films).find(x => x.t === "Chinatown");
    f.t = "Chinatown (titre français)"; delete f.tv;
    localStorage.setItem("movizz.v2", JSON.stringify(s));
  });
  await page.reload();
  await page.waitForFunction(() => {
    const s = JSON.parse(localStorage.getItem("movizz.v2"));
    return Object.values(s.films).some(x => x.t === "Chinatown" && x.tv === 3);
  });
});
await step("phone width has no horizontal scroll", async () => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.click('#tabs [data-tab="soir"]');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await shot("mobile");
});

assert.deepEqual(errors, []);
await browser.close();
server.close();
console.log("All good.");
