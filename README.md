# Live Worker — one-click Cloudflare deployment

Minimal Cloudflare Worker for aggregating M3U/TXT sources, with **automatic KV provisioning**.

## Deploy

Push this folder to a **public GitHub or GitLab repository**, replace `YOUR_PUBLIC_REPO_URL` below with that repository URL, then click:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/smokindope/live-worker2)

During setup, set `SOURCE_URLS` to a JSON array such as:

```json
[{"url":"https://example.com/live.m3u","format":"m3u"}]
```

Cloudflare automatically creates and binds a Workers KV namespace as `KV`. No KV namespace ID or manual binding step is required.

The Worker uses KV for its channel cache and optional `regroup_rules` configuration.

Use only streams you are authorized to access and redistribute.

## Endpoints

- `/` — JSON API/home response
- `/m3u` or `/live.m3u` — M3U output
- `/txt` or `/live.txt` — TXT output

## Optional local deployment

```bash
npm install
npm run deploy
```
