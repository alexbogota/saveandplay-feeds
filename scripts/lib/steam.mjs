// Steam lookups for the Kinguin deals: current price (many games per request), game info, review score.
// Only public Steam store pages are used, politely: one request at a time, at least `pauseMs` apart.
// Prices are never cached (they must be today's). Game info and reviews are remembered in data/steam-cache.json.
// For tests the address can be replaced: STEAM_ORIGIN, STEAM_PAUSE_MS.

import { readFile, writeFile } from 'node:fs/promises';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

export async function createSteam({ cachePath = 'data/steam-cache.json', detailsDays = 30, reviewsDays = 14 } = {}) {
  const origin = process.env.STEAM_ORIGIN ?? 'https://store.steampowered.com';
  const pauseMs = Number(process.env.STEAM_PAUSE_MS ?? 1500);
  let cache = { apps: {} };
  try { cache = JSON.parse(await readFile(cachePath, 'utf8')); } catch {}
  cache.apps ??= {};
  const fresh = (at, days) => at && (Date.now() - new Date(at)) / 864e5 < days;
  let last = 0;
  const stats = { requests: 0, failed: 0 };

  async function getJson(path) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const wait = last + pauseMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      stats.requests++;
      try {
        const res = await fetch(`${origin}${path}`, { headers: { 'user-agent': 'saveandplay-feeds' }, signal: AbortSignal.timeout(30000) });
        if (res.ok) return await res.json();
        if (res.status === 429) await sleep(30000 * attempt); // Steam asks us to slow down
        else if (res.status >= 400 && res.status < 500) break; // this request will never work: do not repeat it
      } catch {}
      await sleep(Math.min(pauseMs, 2000) * attempt);
    }
    stats.failed++;
    throw new Error(`Steam did not answer: ${path.slice(0, 80)}`);
  }

  // Current US price of many apps. Map: appid -> { final, initial, discountPct } | null (no price) | undefined (unknown).
  async function prices(ids, batch = 100) {
    const out = new Map();
    let size = batch; // shrinks if Steam refuses big requests, and stays small for the rest of the run
    async function run(list) {
      let json = null;
      try {
        json = await getJson(`/api/appdetails?appids=${list.join(',')}&filters=price_overview&cc=us`);
      } catch {}
      const answered = json && typeof json === 'object' ? list.filter((id) => json[id] !== undefined).length : 0;
      if (answered < list.length / 2) {
        if (list.length === 1) { out.set(list[0], undefined); return; }
        const mid = Math.ceil(list.length / 2); // a big request did not work: try halves
        size = Math.min(size, mid);
        await run(list.slice(0, mid));
        await run(list.slice(mid));
        return;
      }
      for (const id of list) {
        const po = json[id]?.success ? json[id].data?.price_overview : null;
        out.set(id, po && po.currency === 'USD' ? { final: po.final / 100, initial: po.initial / 100, discountPct: po.discount_percent } : null);
      }
    }
    for (let i = 0; i < ids.length; ) {
      const take = size;
      await run(ids.slice(i, i + take));
      i += take;
    }
    return out;
  }

  // Name, type, age limit, content flags and picture of one app. null = Steam has nothing under this number.
  async function details(appid) {
    const c = cache.apps[appid];
    if (c?.name && fresh(c.at, detailsDays)) return c;
    const data = (await getJson(`/api/appdetails?appids=${appid}&filters=basic,content_descriptors&cc=us&l=english`))?.[appid];
    if (!data?.success) return null;
    const d = data.data;
    cache.apps[appid] = { ...c, name: d.name, type: d.type, age: Number(d.required_age) || 0, descriptors: d.content_descriptors?.ids ?? [], image: d.header_image ?? '', at: today() };
    return cache.apps[appid];
  }

  async function reviews(appid) {
    const c = cache.apps[appid];
    if (c?.total !== undefined && fresh(c.reviewsAt, reviewsDays)) return c;
    const q = (await getJson(`/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`))?.query_summary;
    if (!q || !c) return c;
    Object.assign(c, { pos: q.total_positive, total: q.total_reviews, reviewsAt: today() });
    return c;
  }

  const save = () => writeFile(cachePath, JSON.stringify(cache, null, 1) + '\n');
  return { prices, details, reviews, save, stats };
}
