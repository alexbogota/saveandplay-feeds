// Every morning: reads the Kinguin product feed (Admitad), keeps the PC games whose key is clearly cheaper than the
// CURRENT Steam price (but not absurdly cheaper), checks them on Steam (reviews, content flags), ranks them by how well
// known the game is (number of Steam reviews), and writes a small file: data/kinguin.json.
// The main site (private repository) reads that file. Everything slow and heavy happens here, in the public repository,
// where GitHub Actions minutes are free.
//
// Why we compare with Steam: the feed has no old price. Its "discount" is counted from Kinguin's own "market price",
// which is not a price anyone paid, so we never show it. "Cheaper than Steam today" is a number the buyer can check.
// Keys MORE than maxSavingsPct cheaper than Steam are dropped: Kinguin keys come from private sellers, and prices that low
// usually mean cheap-region or otherwise doubtful keys (see docs in the main repository, decision of 11 Oct 2026).
//
// Secrets come from the environment (GitHub Secrets): ADMITAD_FEED_USER, ADMITAD_FEED_CODE. They are never written anywhere.
// Settings: data/kinguin-rules.json (thresholds), data/feeds.json (feed numbers).
//
// Usage: node scripts/kinguin-deals.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { feedUrl, readFeed } from './lib/admitad.mjs';
import { createSteam } from './lib/steam.mjs';

const USER = process.env.ADMITAD_FEED_USER;
const CODE = process.env.ADMITAD_FEED_CODE;
if (!USER || !CODE) {
  console.error('ADMITAD_FEED_USER / ADMITAD_FEED_CODE are not set (GitHub: Settings -> Secrets and variables -> Actions).');
  process.exit(1);
}

const rules = JSON.parse(readFileSync('data/kinguin-rules.json', 'utf8'));
const feeds = JSON.parse(readFileSync('data/feeds.json', 'utf8')).kinguin;
const feedId = feeds.feeds[rules.feed];
if (!feedId) throw new Error(`Feed "${rules.feed}" is not in data/feeds.json`);

// ---------- the same name rules as the main site (scripts/steam.mjs there) ----------
const EDITION_WORDS = /\b(goty|game of the year|definitive|directors? cut|director s cut|complete|ultimate|deluxe|enhanced|remastered|gold|legendary|premium|anniversary)\b/g;
const clean = (s) => s.toLowerCase().replace(/[™®©]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/^the /, '').trim();
const GENERIC = /\b(goty|game of the year|definitive|directors? cut|director s cut|general|complete|ultimate|deluxe|standard|enhanced|remastered|gold|legendary|premium|anniversary|digital|edition)\b/g;
const core = (s) => clean(s).replace(GENERIC, '').replace(/\s+/g, ' ').trim();
const editionSet = (s) => [...new Set(clean(s).match(EDITION_WORDS) ?? [])].sort().join(',');
// "Game Name PC Steam CD Key" -> "Game Name"
const kinguinTitle = (name) => name.replace(/\b(PC|Steam|Global|Europe|EU|ROW|CD Key|Key|Digital|Download)\b/gi, ' ').replace(/\s+/g, ' ').trim();
// The Steam game and the Kinguin product must be the same game AND the same edition, or the price comparison is wrong.
const sameProduct = (kinguinName, steamName) => {
  const k = kinguinTitle(kinguinName);
  return core(k) !== '' && core(k) === core(steamName) && editionSet(k) === editionSet(steamName);
};

// ---------- stage 1: the feed ----------
const funnel = { feedProducts: 0, available: 0, gameCategory: 0, rightPlatform: 0, instantDelivery: 0, inStock: 0, regionFree: 0, noCountryLimits: 0, steamApp: 0, nameOk: 0, priceInRange: 0, uniqueGames: 0 };
let header = null, col = {}, feedModified = 0;
const best = new Map(); // steam app id -> cheapest matching feed row
const need = ['available', 'categoryId', 'country_limitations', 'delivery_type', 'id', 'name', 'picture', 'platform', 'price', 'quantity', 'region', 'steam_id', 'steam_type', 'url', 'modified_time'];
const excludeRe = new RegExp(`\\b(${rules.excludeNames.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');

function onRow(r) {
  if (!header) {
    header = r;
    header.forEach((h, i) => (col[h] = i));
    const missing = need.filter((n) => col[n] === undefined);
    if (missing.length) throw new Error(`The feed changed: no columns ${missing.join(', ')}. The program needs an update.`);
    return;
  }
  if (r.length < 5) return;
  const v = (n) => r[col[n]] ?? '';
  funnel.feedProducts++;
  feedModified = Math.max(feedModified, Number(v('modified_time')) || 0);
  if (v('available') !== 'true') return; funnel.available++;
  if (v('categoryId') !== 'GAME') return; funnel.gameCategory++;
  if (!rules.platforms.includes(v('platform'))) return; funnel.rightPlatform++;
  if (v('delivery_type') !== 'INSTANT') return; funnel.instantDelivery++;
  if (!(Number(v('quantity')) >= rules.minStock)) return; funnel.inStock++;
  const region = v('region').toUpperCase();
  if (!rules.regionMustContain.some((w) => region.includes(w.toUpperCase()))) return; funnel.regionFree++;
  if (v('country_limitations').trim() !== '') return; funnel.noCountryLimits++;
  const steamId = v('steam_id');
  if (v('steam_type') !== 'app' || !/^\d+$/.test(steamId)) return; funnel.steamApp++;
  if (excludeRe.test(v('name'))) return; funnel.nameOk++;
  const price = Number(v('price'));
  if (!(price >= rules.minPrice && price <= rules.maxPrice)) return; funnel.priceInRange++;
  const cur = best.get(steamId);
  if (!cur || price < cur.price || (price === cur.price && Number(v('quantity')) > cur.quantity)) {
    best.set(steamId, { steamId, kinguinId: v('id'), name: v('name'), price, quantity: Number(v('quantity')), region: v('region'), url: v('url'), picture: v('picture') });
  }
}

const t0 = Date.now();
console.log('Reading the Kinguin feed …');
const dl = await readFeed(feedUrl(feeds.site, feedId, USER, CODE), onRow, { user: USER, code: CODE });
funnel.uniqueGames = best.size;
const feedSeconds = Math.round((Date.now() - t0) / 1000);
console.log(`Feed read: ${(dl.bytes / 1e6).toFixed(1)} MB, ${funnel.feedProducts} products, ${best.size} candidate games, ${feedSeconds} s.`);
if (funnel.feedProducts < 1000) throw new Error('The feed has suspiciously few products; nothing was written.');

// ---------- stage 2: Steam prices ----------
const steam = await createSteam();
const ids = [...best.keys()].slice(0, rules.maxPriceChecks);
console.log(`Asking Steam for the price of ${ids.length} games …`);
const prices = await steam.prices(ids);
const stage2 = { asked: ids.length, noSteamPrice: 0, steamUnknown: 0, steamTooCheap: 0, notCheaperEnough: 0, tooGoodToBeTrue: 0, passed: 0 };
const cheaper = [];
for (const id of ids) {
  const p = prices.get(id);
  const k = best.get(id);
  if (p === undefined) { stage2.steamUnknown++; continue; }
  if (p === null) { stage2.noSteamPrice++; continue; }
  if (p.final < rules.minSteamPrice) { stage2.steamTooCheap++; continue; }
  const savingsPct = Math.round((1 - k.price / p.final) * 100);
  if (savingsPct < rules.minSavingsPct) { stage2.notCheaperEnough++; continue; }
  if (savingsPct > rules.maxSavingsPct) { stage2.tooGoodToBeTrue++; continue; }
  stage2.passed++;
  cheaper.push({ ...k, steamPrice: p.final, steamWas: p.initial, steamDiscountPct: p.discountPct, savingsPct });
}
// Bigger (higher list price) games first: they are better known. Cheaper-than-Steam share only breaks ties.
cheaper.sort((a, b) => b.steamPrice - a.steamPrice || b.savingsPct - a.savingsPct);

// ---------- stage 3: quality ----------
const stage3 = { looked: 0, notAGame: 0, otherEdition: 0, adult: 0, fewReviews: 0, lowScore: 0, steamError: 0, accepted: 0 };
const requestsBefore = steam.stats.requests;
let stoppedByBudget = false;
const deals = [];
for (const c of cheaper) {
  if (steam.stats.requests - requestsBefore >= rules.maxSteamRequests) { stoppedByBudget = true; break; }
  stage3.looked++;
  try {
    const app = await steam.details(c.steamId);
    if (!app || app.type !== 'game') { stage3.notAGame++; continue; }
    if (!sameProduct(c.name, app.name)) { stage3.otherEdition++; continue; }
    if (app.descriptors?.some((x) => rules.adultFlags.includes(x))) { stage3.adult++; continue; }
    const rev = await steam.reviews(c.steamId);
    const total = rev?.total ?? 0;
    const pct = total ? Math.round((100 * rev.pos) / total) : 0;
    if (total < rules.minReviews) { stage3.fewReviews++; continue; }
    if (pct < rules.minPositive) { stage3.lowScore++; continue; }
    stage3.accepted++;
    deals.push({
      steamId: Number(c.steamId),
      title: app.name,
      kinguinName: c.name,
      kinguinId: c.kinguinId,
      price: c.price,
      steamPrice: c.steamPrice,
      steamWas: c.steamWas,
      steamDiscountPct: c.steamDiscountPct,
      savingsPct: c.savingsPct,
      reviews: { total, positivePct: pct },
      stock: c.quantity,
      region: c.region,
      url: c.url,
      image: app.image || c.picture,
      checkedAt: new Date().toISOString(),
    });
  } catch (e) {
    stage3.steamError++;
    console.warn(`Skipped ${c.steamId}: ${e.message}`);
  }
}
await steam.save();
// Best known games first.
deals.sort((a, b) => b.reviews.total - a.reviews.total || b.savingsPct - a.savingsPct);
deals.length = Math.min(deals.length, rules.maxOutput);

// ---------- write ----------
mkdirSync('reports', { recursive: true });
const out = {
  generatedAt: new Date().toISOString(),
  feed: { store: 'kinguin', feed: rules.feed, id: feedId, products: funnel.feedProducts, megabytes: Math.round(dl.bytes / 1e5) / 10, seconds: feedSeconds, lastModifiedInFeed: feedModified ? new Date(feedModified * 1000).toISOString() : null },
  rules: { minSteamPrice: rules.minSteamPrice, minSavingsPct: rules.minSavingsPct, maxSavingsPct: rules.maxSavingsPct, minReviews: rules.minReviews, minPositive: rules.minPositive },
  count: deals.length,
  deals,
};
writeFileSync('data/kinguin.json', JSON.stringify(out, null, 1) + '\n');

const summary = [
  `# Kinguin deals, ${out.generatedAt.slice(0, 10)}`,
  '',
  `Games written to data/kinguin.json: **${deals.length}**${stoppedByBudget ? ' (the Steam request budget ran out; the rest will be looked at on the next runs)' : ''}. Feed: ${out.feed.products} products, ${out.feed.megabytes} MB, ${feedSeconds} s. Steam requests: ${steam.stats.requests} (failed: ${steam.stats.failed}).`,
  '',
  '| Step | Count |', '|---|---|',
  ...Object.entries(funnel).map(([k, n]) => `| feed: ${k} | ${n} |`),
  ...Object.entries(stage2).map(([k, n]) => `| steam price: ${k} | ${n} |`),
  ...Object.entries(stage3).map(([k, n]) => `| quality: ${k} | ${n} |`),
  '',
  '| Game | Kinguin | Steam now | Cheaper | Reviews |', '|---|---|---|---|---|',
  ...deals.slice(0, 40).map((d) => `| ${d.title.replace(/\|/g, '\\|')} | $${d.price.toFixed(2)} | $${d.steamPrice.toFixed(2)} | ${d.savingsPct}% | ${d.reviews.positivePct}% of ${d.reviews.total} |`),
  '',
].join('\n');
writeFileSync('reports/kinguin-summary.md', summary);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
console.log(summary);
