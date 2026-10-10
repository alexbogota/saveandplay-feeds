// Looks at an Admitad product feed and writes a plain report: which columns it has, how full they are,
// what the prices look like. It changes nothing on the site. Run by hand from GitHub (Actions -> "Feed probe").
//
// The feed is read as a stream and never kept whole in memory (the Kinguin feeds are hundreds of MB).
// The access key of the feed (ADMITAD_FEED_USER, ADMITAD_FEED_CODE) lives only in GitHub Secrets.
// It is never written to a file, and every address in the report is cleaned of it.
// Which feeds to look at: data/feeds.json (feed numbers are not secret). A new store or a new region = one more line there.
//
// Usage: node scripts/feed-probe.mjs [store] [feed]      (store, feed = keys of data/feeds.json, default: all)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const USER = process.env.ADMITAD_FEED_USER;
const CODE = process.env.ADMITAD_FEED_CODE;
if (!USER || !CODE) {
  console.error('ADMITAD_FEED_USER / ADMITAD_FEED_CODE are not set (add them in GitHub: Settings -> Secrets and variables -> Actions).');
  process.exit(1);
}

const config = JSON.parse(readFileSync('data/feeds.json', 'utf8'));
const only = process.argv[2];
const onlyFeed = process.argv[3];
const MAX_BYTES = 600_000_000; // safety stop for a runaway download
const CELL_CAP = 400; // a cell is kept only up to this many characters (descriptions can be huge)
const MAX_DISTINCT = 40; // distinct values are counted only up to this number per column

const clean = (s) => String(s).replaceAll(USER, '***').replaceAll(CODE, '***');
const short = (s, n = 110) => {
  const t = clean(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};
const md = (s) => short(s).replace(/\|/g, '\\|');
const num = (v) => {
  const n = Number(String(v).replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

function feedUrl(site, id) {
  return `${process.env.FEED_ORIGIN ?? 'https://export.admitad.com'}/en/webmaster/websites/${site}/products/export_adv_products/?user=${USER}&code=${CODE}&feed_id=${id}&format=csv`;
}

// An incremental CSV reader: text comes in pieces, a finished row goes to onRow(). Quotes, doubled quotes and line breaks inside quotes are handled.
class CsvReader {
  constructor(delim, onRow) {
    this.delim = delim;
    this.onRow = onRow;
    this.row = [];
    this.cell = '';
    this.inQuote = false;
    this.maybeEnd = false; // saw a quote inside quotes: it is either the end or the first half of ""
  }
  put(c) { if (this.cell.length < CELL_CAP) this.cell += c; }
  push(text) {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (this.inQuote) {
        if (this.maybeEnd) {
          this.maybeEnd = false;
          if (c === '"') { this.put('"'); continue; }
          this.inQuote = false; // it was the end of the quoted part; handle this character normally below
        } else if (c === '"') { this.maybeEnd = true; continue; }
        else { this.put(c); continue; }
      }
      if (c === '"') this.inQuote = true;
      else if (c === this.delim) { this.row.push(this.cell); this.cell = ''; }
      else if (c === '\n') { this.row.push(this.cell.replace(/\r$/, '')); this.onRow(this.row); this.row = []; this.cell = ''; }
      else this.put(c);
    }
  }
  end() {
    if (this.cell !== '' || this.row.length) { this.row.push(this.cell); this.onRow(this.row); }
  }
}

function guessDelimiter(text) {
  const line = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : 3000);
  const counts = [';', ',', '\t', '|'].map((d) => [d, line.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][0];
}

async function probe(store, name, site, id) {
  const out = [`### ${store} / ${name} (feed ${id})`, ''];
  let res;
  const t0 = Date.now();
  try {
    res = await fetch(feedUrl(site, id), { headers: { 'User-Agent': 'saveandplay-feed-probe' } });
  } catch (e) {
    return out.concat([`Download failed: ${clean(e.message)}`, '']).join('\n');
  }
  out.push(`HTTP ${res.status}, type: ${res.headers.get('content-type') ?? '?'}`);
  // Headers that tell how the file is delivered and how fresh it is (no secrets in them).
  const hdr = ['content-encoding', 'content-length', 'last-modified', 'etag', 'cache-control', 'date']
    .map((h) => `${h}: ${res.headers.get(h) ?? '-'}`).join('; ');
  out.push(`Headers: ${hdr}`);
  if (!res.ok) return out.concat(['', 'The feed did not open. Check the key and the feed number.', '']).join('\n');

  const decoder = new TextDecoder('utf-8');
  let header = null, cols = [], products = 0, bytes = 0, cut = false, reader = null;
  let priceIdx = -1, oldIdx = -1, disc = 0, big = 0, noPrice = 0;
  const firstRows = [], discRows = [];

  const onRow = (r) => {
    if (!header) {
      header = r;
      cols = header.map((h) => ({ h, filled: 0, set: new Map(), overflow: false, ex: [] }));
      const find = (re) => header.findIndex((h) => re.test(h));
      priceIdx = find(/^price$/i) >= 0 ? find(/^price$/i) : find(/price/i);
      oldIdx = find(/old.?price/i);
      return;
    }
    if (r.length < 2) return; // empty line
    products++;
    for (let i = 0; i < cols.length; i++) {
      const v = r[i] ?? '';
      if (v.trim() === '') continue;
      const c = cols[i];
      c.filled++;
      if (c.ex.length < 2) c.ex.push(v);
      if (!c.overflow) {
        c.set.set(v, (c.set.get(v) ?? 0) + 1);
        if (c.set.size > MAX_DISTINCT) c.overflow = true;
      } else if (c.set.has(v)) c.set.set(v, c.set.get(v) + 1);
    }
    if (firstRows.length < 3) firstRows.push(r);
    if (priceIdx >= 0 && oldIdx >= 0) {
      const p = num(r[priceIdx]), o = num(r[oldIdx]);
      if (!(p > 0)) noPrice++;
      else if (o > p) {
        disc++;
        if (1 - p / o >= 0.5) big++;
        if (discRows.length < 3) discRows.push(r);
      }
    }
  };

  try {
    for await (const chunk of res.body) {
      bytes += chunk.length;
      const text = decoder.decode(chunk, { stream: true });
      if (!reader) reader = new CsvReader(guessDelimiter(text), onRow);
      reader.push(text);
      if (bytes > MAX_BYTES) { cut = true; break; }
    }
    if (reader) { reader.push(decoder.decode()); reader.end(); }
  } catch (e) {
    out.push(`Reading stopped: ${clean(e.message)}`);
  }

  out.push(`Size read: ${(bytes / 1e6).toFixed(1)} MB in ${Math.round((Date.now() - t0) / 1000)} s (download and reading together)${cut ? ' (stopped at the safety limit)' : ''}`);
  if (!header) return out.concat(['', 'The file is empty or is not a table.', '']).join('\n');
  const d = reader.delim;
  out.push(`Separator: ${d === '\t' ? 'TAB' : '"' + d + '"'}; columns: ${header.length}; products: ${products}`, '');

  out.push('| # | Column | Filled | Distinct | Examples |', '|---|---|---|---|---|');
  cols.forEach((c, i) => {
    const pct = products ? Math.round((c.filled / products) * 100) : 0;
    const distinct = c.overflow ? `${MAX_DISTINCT}+` : String(c.set.size);
    const ex = !c.overflow && c.set.size <= 12
      ? [...c.set.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, n]) => `${short(v, 30)} (${n})`).join('; ')
      : c.ex.map((v) => short(v, 50)).join(' · ');
    out.push(`| ${i} | ${md(c.h)} | ${pct}% | ${distinct} | ${md(ex)} |`);
  });
  out.push('');

  if (priceIdx >= 0 && oldIdx >= 0) {
    out.push(`Price columns: current = ${header[priceIdx]}, old = ${header[oldIdx]}.`);
    out.push(`Products with an old price above the current price: ${disc} (of them 50% off or more: ${big}). Products without a usable price: ${noPrice}.`, '');
  } else {
    out.push(`Price columns: current = ${header[priceIdx] ?? 'not found'}, old = ${header[oldIdx] ?? 'not found'}.`, '');
  }

  const show = (title, rows) => {
    if (!rows.length) return;
    out.push(title, '');
    for (const r of rows) out.push('```', ...header.map((h, i) => `${h}: ${short(r[i] ?? '', 140)}`), '```');
    out.push('');
  };
  show('Three sample rows (long text cut, key removed):', firstRows);
  show('Three sample rows that have an old price above the current one:', discRows);
  return out.join('\n');
}

const report = ['# Admitad feed report', `Made: ${new Date().toISOString()}`, ''];
mkdirSync('reports', { recursive: true });
const save = () => {
  const text = report.join('\n');
  writeFileSync('reports/feed-report.md', text);
  return text;
};
for (const [store, s] of Object.entries(config)) {
  if (only && only !== store) continue;
  for (const [name, id] of Object.entries(s.feeds)) {
    if (onlyFeed && onlyFeed !== name) continue;
    console.log(`Looking at ${store} / ${name} …`);
    report.push(await probe(store, name, s.site, id));
    save(); // after every feed, so a later failure does not lose the earlier ones
  }
}
const text = save();
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, text, { flag: 'a' });
console.log(text);
