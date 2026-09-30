// Browser test against a mocked TMDB. Run: npm test (needs Playwright + Chromium installed).
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { handle } from "./mock-tmdb.mjs";
import { handle as handleDb, db } from "./mock-supabase.mjs";

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

const SB_CLIENT = await readFile(join(root, "tests/mock-supabase-client.js"));
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
async function newPage(viewport = { width: 1100, height: 1400 }) {
  const p = await (await browser.newContext({ viewport })).newPage();
  p.on("pageerror", e => errors.push(e.message));
  await p.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await p.route(/image\.tmdb\.org/, r => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await p.route(/api\.themoviedb\.org/, r => { const [status, body] = handle(r.request().url()); r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); });
  await p.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js/, r => r.fulfill({ status: 200, contentType: "text/javascript", body: SB_CLIENT }));
  await p.route("https://mock.supabase.co/__db", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(handleDb(JSON.parse(r.request().postData()))) }));
  return p;
}
const page = await newPage();

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

/* ---------- shared foyer: two devices, two people ---------- */
const desk = await newPage(), phone = await newPage({ width: 390, height: 900 });
const count = (p, sel) => p.textContent(sel).then(t => t.trim());
const focus = p => p.evaluate(() => dispatchEvent(new Event("focus")));
async function signInAs(p, email) {
  await p.click('#tabs [data-tab="reglages"]');
  await p.waitForSelector("#syncEmail");
  await p.fill("#syncEmail", email);
  await p.click("#syncLogin button");
  await p.waitForFunction(() => document.querySelector("#syncNote")?.textContent.includes("Lien envoyé"));
  await p.evaluate(() => window.__mockSbClickLink());
  await p.waitForSelector("#syncCreate");
}
await step("creates a foyer and uploads the existing backlog and settings", async () => {
  await desk.goto(base);
  await desk.fill("#keyInput", "goodkey123");
  await desk.click("#keySave");
  await desk.waitForSelector('#subsChips [data-sub="8"]');
  await desk.click('#subsChips [data-sub="8"]');
  await desk.click('#tabs [data-tab="backlog"]');
  for (const [q, n] of [["Paddington", 1], ["Chinatown", 2]]) {
    await desk.fill("#addInput", q);
    await desk.waitForSelector("#addAc .ac-list button");
    await desk.click("#addAc .ac-list button");
    await desk.waitForFunction(n => document.querySelectorAll("#blList .item").length === n, n);
  }
  await signInAs(desk, "nicolas@example.com");
  await desk.fill("#syncName", "Chez nous");
  await desk.click("#syncCreate button");
  await desk.waitForFunction(() => document.querySelector("#syncStatus")?.textContent.includes("Synchronisé"));
  assert.equal(await count(desk, "#syncCodeShow"), "AB12C1");
  assert.equal(db.households[0].name, "Chez nous");
  assert.equal(db.films.length, 2);
  assert.equal(db.households[0].settings.key, "goodkey123");
  assert.deepEqual(db.households[0].settings.subs, [8]);
});
await step("the other person joins with the code and gets everything, key included", async () => {
  await phone.goto(base);
  assert.equal(await phone.isVisible("#needKey"), false); // lands on Réglages
  await signInAs(phone, "copine@example.com");
  await phone.fill("#syncCode", " ab12c1 ");
  await phone.click("#syncJoin button");
  await phone.waitForFunction(() => document.querySelector("#cntBacklog").textContent === "2");
  await phone.waitForFunction(() => document.querySelector("#keyInput").value === "goodkey123");
  await phone.waitForSelector('#subsChips [data-sub="8"][aria-pressed="true"]');
});
await step("marking watched on one device shows up on the other", async () => {
  await phone.click('#tabs [data-tab="backlog"]');
  await phone.click('#blList [data-act="watch"][data-id="5"]');
  await phone.waitForFunction(() => document.querySelector("#cntVus").textContent === "1");
  await phone.waitForTimeout(1600);
  await focus(desk);
  await desk.waitForFunction(() => document.querySelector("#cntVus").textContent === "1" && document.querySelector("#cntBacklog").textContent === "1");
});
await step("removing a film on one device removes it on the other", async () => {
  await desk.click('#tabs [data-tab="backlog"]');
  for (let i = 0; i < 2; i++) await desk.click('#blList [data-act="remove"][data-id="10"]');
  await desk.waitForFunction(() => document.querySelector("#cntBacklog").textContent === "");
  await desk.waitForTimeout(1600);
  await focus(phone);
  await phone.waitForFunction(() => document.querySelector("#cntBacklog").textContent === "");
  assert.deepEqual(db.films.find(f => f.id === 10).data, { deleted: true });
});
await step("the foyer survives a reload", async () => {
  await phone.reload();
  await phone.click('#tabs [data-tab="reglages"]');
  await phone.waitForFunction(() => document.querySelector("#syncStatus")?.textContent.includes("Synchronisé"));
  assert.equal(await count(phone, "#cntVus"), "1");
  assert.equal(await count(phone, "#cntBacklog"), "");
  if (process.env.SHOTS) await phone.screenshot({ path: `${process.env.SHOTS}/foyer-phone.png`, fullPage: true });
});
await step("a wrong invite code says so", async () => {
  const p = await newPage();
  await p.goto(base);
  await signInAs(p, "voisin@example.com");
  await p.fill("#syncCode", "ZZZZZZ");
  await p.click("#syncJoin button");
  await p.waitForFunction(() => document.querySelector("#syncNote")?.textContent.includes("aucun foyer"));
});

assert.deepEqual(errors, []);
await browser.close();
server.close();
console.log("All good.");
