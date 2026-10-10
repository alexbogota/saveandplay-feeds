# saveandplay-feeds

Heavy download work for saveandplay.com, kept in a separate **public** repository on purpose:
GitHub Actions minutes are free and unlimited for public repositories, so big product feeds (hundreds of MB) can be
downloaded every day at no cost. The main site repository is private and has a limited number of free minutes.

What is here: only generic code that downloads affiliate product feeds and a list of feeds (`data/feeds.json`).
What is NOT here: access keys (they live in this repository's GitHub Secrets: `ADMITAD_FEED_USER`, `ADMITAD_FEED_CODE`),
the site, the accounts, or any private notes.

A new store or region = one more line in `data/feeds.json`.

- `scripts/feed-probe.mjs`: looks at a feed and writes `reports/feed-report.md` (columns, prices, download time).
