# lavie-support

The Lavie website, served at https://lifebar.app by Cloudflare Pages (project `lavie-site`).

- `site/`: the pages (`/`, `/support`, `/privacy`, `/terms`), styles, icon, `_redirects`.
- `functions/_middleware.js`: sends `www.lifebar.app` and the pages.dev address to `lifebar.app`.
- `functions/api/statement.js`: the app's statement-import proxy to DeepSeek. Secrets `DEEPSEEK_API_KEY` and `IP_SALT` (`npx wrangler pages secret put NAME --project-name lavie-site`); request counts in D1 `lavie-proxy` (`migrations/`, apply with `npx wrangler d1 migrations apply lavie-proxy --remote`); limits in `wrangler.jsonc` `vars`. A changed secret takes effect on the next `npx wrangler pages deploy --branch main`. For `wrangler pages dev`, put the secrets in the git-ignored `.dev.vars`.
- The root `index.html`, `privacy-policy.html` and `terms-of-use.html` are the 1.0 pages served by GitHub Pages (musicq.github.io/lavie-support), which the live 1.0 app and its App Store listing link to. Keep them until 2.0 ships; then replace them with redirects to lifebar.app.

Preview locally with `npx wrangler pages dev`, deploy with `npx wrangler pages deploy --branch main`.
