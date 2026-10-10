# saveandplay-feeds

Heavy download work for saveandplay.com, kept in a separate **public** repository on purpose:
GitHub Actions minutes are free and unlimited for public repositories, so big product feeds (hundreds of MB) can be
downloaded every day at no cost. The main site repository is private and has a limited number of free minutes.

What is here: only generic code that downloads affiliate product feeds and a list of feeds (`data/feeds.json`).
What is NOT here: access keys (they live in this repository's GitHub Secrets: `ADMITAD_FEED_USER`, `ADMITAD_FEED_CODE`),
the site, the accounts, or any private notes.

A new store or region = one more line in `data/feeds.json`.

- `scripts/feed-probe.mjs`: looks at a feed and writes `reports/feed-report.md` (columns, prices, download time).
- `scripts/kinguin-deals.mjs`: every morning reads the Kinguin feed, keeps PC games whose key is clearly cheaper than the current Steam price, checks reviews and content flags on Steam, and writes `data/kinguin.json` (the main site reads this small file). Thresholds are in `data/kinguin-rules.json`. Why Steam and not the feed's own "discount": the feed has no old price; its discount is counted from Kinguin's own "market price", which is not a price anyone paid.
- `scripts/lib/`: shared pieces (streaming CSV reader, Admitad download, Steam client).
- Workflows (`.github/workflows`): `feed-probe.yml` (report on a feed, by hand) and `kinguin-deals.yml` (daily).

New niche or store with a feed = a new `data/feeds.json` line, a rules file and a small program next to `kinguin-deals.mjs`; the shared pieces in `scripts/lib/` stay.

