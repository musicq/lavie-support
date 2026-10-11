# lavie-support

The Lavie website, served at https://lifebar.app by Cloudflare Pages (project `lavie-site`).

- `site/`: the pages (`/`, `/support`, `/privacy`, `/terms`), styles, icon, `_redirects`.
- `functions/_middleware.js`: sends `www.lifebar.app` and the pages.dev address to `lifebar.app`.
- The root `index.html`, `privacy-policy.html` and `terms-of-use.html` only redirect the old GitHub Pages URLs (musicq.github.io/lavie-support) to the new site. Shipped app builds still link to them.

Preview locally with `npx wrangler pages dev`, deploy with `npx wrangler pages deploy --branch main`.
