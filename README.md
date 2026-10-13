# lavie-support

The Lavie website, served at https://lifebar.app by Cloudflare Pages (project `lavie-site`).

- `site/`: the pages (`/`, `/support`, `/privacy`, `/terms`), styles, icon, `_redirects`.
- `site/_routes.json`: only `/api/*` runs Functions; every page is plain static (free, not counted as a request). `www.lifebar.app` and the pages.dev address are sent to `lifebar.app` by the account's Bulk Redirects, not by code.
- `functions/api/`: the app's statement-import proxy to DeepSeek. `challenge` → `attest` (App Attest key, once per install) → `session` (checks App Attest, the Lavie Plus StoreKit transaction or DeviceCheck's free try, and the person's daily AI budget) → `statement` (one chunk; records its real cost). Apple's checks are in `lib/apple.js` (tests: `node --test test/*.test.mjs`). `ENFORCE_ATTEST` and `ENFORCE_DEVICE` in `wrangler.jsonc` are `"1"` (refuse what fails); set one to `"0"` to only log that check (see `npx wrangler pages deployment tail --project-name lavie-site`, or the `checks` column of `sessions`). Secrets `DEEPSEEK_API_KEY`, `IP_SALT`, `DEVICECHECK_KEY` (`npx wrangler pages secret put NAME --project-name lavie-site`); data in D1 `lavie-proxy` (`migrations/`, apply with `npx wrangler d1 migrations apply lavie-proxy --remote`); caps and limits in `wrangler.jsonc` `vars`. For `wrangler pages dev`, put the secrets in the git-ignored `.dev.vars`; a debug app build talks to it with the launch argument `-LavieProxyURL http://localhost:8799`. A changed secret takes effect on the next `npx wrangler pages deploy --branch main`.
- Who uses it: `npx wrangler d1 execute lavie-proxy --remote --command "SELECT tier, COUNT(*), SUM(imports), SUM(cost_micro)/1e6 AS usd FROM users GROUP BY tier"`.
- The root `index.html`, `privacy-policy.html` and `terms-of-use.html` are the 1.0 pages served by GitHub Pages (musicq.github.io/lavie-support), which the live 1.0 app and its App Store listing link to. Keep them until 2.0 ships; then replace them with redirects to lifebar.app.

Preview locally with `npx wrangler pages dev`, deploy with `npx wrangler pages deploy --branch main`.
