# Cloudflare Pages setup

The frontend is a static bundle, so Cloudflare Pages can host it from the
repository with no build server of your own.

## Build settings

In the Cloudflare dashboard: **Workers & Pages -> Create -> Pages -> Connect to
Git**, pick the repository, then:

| Setting | Value |
| --- | --- |
| Framework preset | None (or Vite) |
| Root directory | `frontend` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | 22 (set the `NODE_VERSION` variable) |

**Root directory must be `frontend`.** This is an npm workspace, so a build
launched from the repository root would look for the frontend's `dist` in the
wrong place. Cloudflare installs dependencies from the root lockfile
automatically when the root directory is set to a workspace member.

## Environment variables

Set under **Settings -> Environment variables**, for both Production and Preview:

| Name | Value | Notes |
| --- | --- | --- |
| `VITE_API_URL` | `https://api.your-domain.example` | the backend origin |
| `NODE_VERSION` | `22` | matches the CI Node version |

`VITE_API_URL` may be empty if the API is proxied under the same origin. Leave it
empty rather than pointing at a host you have not deployed yet.

## The one rule about VITE_ variables

Vite inlines every `VITE_*` value into the JavaScript bundle that ships to the
browser. Anything you put there is public.

- Never put `OPENROUTER_API_KEY` in a `VITE_*` variable.
- Never put `DATABASE_URL`, `JWT_SECRET` or any token there.
- The only correct value is the API's public base URL.

`build.yml` enforces this: after `vite build` it greps the bundle for
`sk-or-`, `OPENROUTER_API_KEY`, `DATABASE_URL` and `JWT_SECRET`, and fails the
job on a hit. The frontend code only ever reads a cookie session; it never
receives a key.

## SPA routing and headers

Two files in `frontend/public/` are copied into the bundle and picked up by
Pages:

- `_redirects` sends every unmatched path to `/index.html` so deep links such as
  `/projects/<id>` work on a hard refresh.
- `_headers` sets `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy` and immutable caching for hashed
  assets.

Pages has no access to the API's `/api` or `/ws` paths: the frontend calls the
backend origin directly using `VITE_API_URL`.

## Backend CORS and cookies

Because the frontend and API are on different hosts, the backend must be told to
accept the frontend origin:

```bash
CORS_ORIGINS=https://your-project.pages.dev,https://your-domain.example
```

Session cookies use `SameSite=Lax` by default, which a browser will not send on a
cross-site request. When the frontend and API are on different sites - the
normal Pages + VM arrangement - set this on the backend:

```bash
SESSION_COOKIE_SAMESITE=none
```

`none` forces `Secure`, so HTTPS is required on both. If you instead put the API
under the same registrable domain, keep `lax`. Test in a real browser: `curl`
will not show you a cookie the browser later refuses to send.

If your Pages project is on `*.pages.dev` and your API on your own domain, that
is cross-site, so `none` is correct.

## Custom domain

**Custom domains -> Set up a domain**, then add the CNAME Cloudflare shows you.
Once the certificate is issued, add the new origin to `CORS_ORIGINS` on the
backend and redeploy.

## Deploying

Pushes to the production branch deploy automatically; other branches and PRs get
preview URLs. To deploy from a machine instead:

```bash
cd frontend
npm ci
VITE_API_URL=https://api.your-domain.example npm run build
npx wrangler pages deploy dist --project-name my-ai-studio
```

`wrangler` needs a Cloudflare API token in the environment. Do not commit it;
export it in the shell or use Cloudflare's own CI integration.

## Verifying a deployment

```bash
curl -sI https://your-project.pages.dev | grep -iE 'x-frame|nosniff|referrer'
curl -s  https://your-project.pages.dev | grep -o '<title>.*</title>'

# The API must be reachable from the browser's perspective and report its state.
curl -s https://api.your-domain.example/api/health
```

Then open the deployed URL on an Android phone, register an account and create a
project. That is the actual acceptance test - the build succeeding only says the
bundle compiled.
