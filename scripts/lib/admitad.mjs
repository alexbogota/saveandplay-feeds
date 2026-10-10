// Reading an Admitad product feed as a stream (the file is hundreds of MB and is never kept whole in memory).
// The access key (user + code) is passed in by the caller from GitHub Secrets and is removed from every message.
// For tests the address can be replaced: FEED_ORIGIN.

import { CsvReader, guessDelimiter } from './csv.mjs';

export function feedUrl(site, id, user, code) {
  const origin = process.env.FEED_ORIGIN ?? 'https://export.admitad.com';
  return `${origin}/en/webmaster/websites/${site}/products/export_adv_products/?user=${user}&code=${code}&feed_id=${id}&format=csv`;
}

// onRow(row) gets every row, the first one is the header. Returns facts about the download.
export async function readFeed(url, onRow, { user, code, maxBytes = 600_000_000, cellCap = 400 } = {}) {
  const clean = (s) => String(s).replaceAll(user, '***').replaceAll(code, '***');
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'saveandplay-feeds' } });
  } catch (e) {
    throw new Error(`Feed download failed: ${clean(e.message)}`);
  }
  if (!res.ok) throw new Error(`Feed did not open: HTTP ${res.status}. Check the key (GitHub Secrets) and the feed number.`);
  const decoder = new TextDecoder('utf-8');
  let reader = null, bytes = 0, cut = false;
  try {
    for await (const chunk of res.body) {
      bytes += chunk.length;
      const text = decoder.decode(chunk, { stream: true });
      if (!reader) reader = new CsvReader(guessDelimiter(text), onRow, cellCap);
      reader.push(text);
      if (bytes > maxBytes) { cut = true; break; }
    }
    if (reader) { reader.push(decoder.decode()); reader.end(); }
  } catch (e) {
    throw new Error(`Feed reading stopped: ${clean(e.message)}`);
  }
  if (!reader) throw new Error('The feed is empty.');
  return { status: res.status, bytes, cut, delimiter: reader.delim };
}
