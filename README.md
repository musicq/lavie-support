# lavie-support

The Lavie website, served at https://lifebar.app by Cloudflare Pages (project `lavie-site`).

- `site/`: the pages (`/`, `/support`, `/privacy`, `/terms`), styles, icon, `_redirects`.
- `functions/_middleware.js`: sends `www.lifebar.app` and the pages.dev address to `lifebar.app`.
- The root `index.html`, `privacy-policy.html` and `terms-of-use.html` are the 1.0 pages served by GitHub Pages (musicq.github.io/lavie-support), which the live 1.0 app and its App Store listing link to. Keep them until 2.0 ships; then replace them with redirects to lifebar.app.

Preview locally with `npx wrangler pages dev`, deploy with `npx wrangler pages deploy --branch main`.
