# StrafeMC store

Independent Node.js SSR application, default port **5020**. Every page is rendered on the server with Express/EJS; browser JavaScript handles copying the server address, preventing accidental double submissions and replacing unavailable portrait images with the local default.

## Run

Requires Node.js 22.9+ and pnpm.

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
# Configure .env before production startup.
pnpm build:prod
pnpm start:prod
```

For local work, use `NODE_ENV=development` and `PUBLIC_BASE_URL=http://localhost:5020` in `.env`, then `pnpm dev`. Production requires a random `COOKIE_SECRET` of at least 32 characters, an HTTPS `PUBLIC_BASE_URL`, and an HTTPS reverse proxy. Use `HOST`/`PORT` to change the listener. Set `TRUST_PROXY_HOPS` to the exact proxy hop count; never enable trust for arbitrary forwarding headers. `/health` reports process readiness without calling external providers.

`dist/` contains the server bundle, views and public assets. Deploy it with package.json, pnpm-lock.yaml and production dependencies. The three ecosystem applications have their own environment files and launch independently.

## Docker deployment

Build the image from the WebApp directory. Its runtime stage contains the SSR bundle, views, public assets and production dependencies; it runs as the unprivileged `node` user and checks `/health` for container health.

```sh
docker build -t strafemc-store:latest .
docker run -d \
  --name strafemc-store \
  --restart unless-stopped \
  --env-file .env \
  -e HOST=0.0.0.0 \
  --publish 127.0.0.1:5020:5020 \
  strafemc-store:latest
```

The port is published only on host loopback so the VPS reverse proxy can terminate HTTPS. Set `PUBLIC_BASE_URL` to the public HTTPS store URL, set `API_SERVER_BASE_URL` to the public HTTPS API URL, and keep the leaderboard API key in this server-side environment. The application requires HTTPS for a non-local API URL in production. Build and run this image independently of the API image; they do not need a shared folder or Compose project.

## Provider configuration

- `PAYNOW_STORE_ID`, `PAYNOW_API_KEY`: server credentials used to load the PayNow storefront catalog. Products, pricing, descriptions and order fulfillment are managed in PayNow. Give the credential only the permissions required for storefront reads. Minecraft direct auth uses PayNow's supported username flow; payment uses the resulting customer token.
- `PAYNOW_RANK_TAG`: PayNow product tag slug identifying rank products (default `ranks`). Other tags become catalog categories.
- `TEBEX_PUBLIC_TOKEN`, `RANK_CATEGORY_ID`: rank comparison content and column names/prices are read from Tebex, following [TABLE_MARKUP.md](TABLE_MARKUP.md). Category ID takes precedence; otherwise the Tebex category slug/name selects ranks. No rank catalog is written to Supabase.
- `RANK_IMAGE_HOSTS`: comma-separated exact DNS hostnames for images embedded in description/perk HTML. Defaults to `dunb17ur4ymx4.cloudfront.net`; include it when adding further approved hosts. No wildcards, subdomain matching, credentials, explicit ports or non-HTTPS images are allowed. An empty value disables these images. Only approve hosts your administrators trust because approved hosts receive visitor IPs. Catalog artwork fields from trusted provider APIs are handled separately and retain support for their image origins.
- `PAYNOW_PRODUCT_MAP`: JSON mapping Tebex package IDs to PayNow product IDs, for example `{"123456":"411486491630370816"}`. Mapped PayNow products appear in the rank category even without the ranks tag. The Tebex package ID remains the comparison column identity; display order comes from Tebex. PayNow remains authoritative for the actual checkout total.
- `API_SERVER_BASE_URL`, `API_SERVER_API_KEY`: points API connection. Use a dedicated **leaderboards:read** key and TLS for any non-localhost connection. Older `POINTS_API_BASE_URL`/`POINTS_API_KEY` aliases are accepted. API credentials never appear in pages or browser code.
- `API_SERVER_PUBLIC_BASE_URL`: public HTTPS API origin for account portrait PNGs; match the API's `ACCOUNT_PUBLIC_URL` origin. Defaults to the HTTPS `API_SERVER_BASE_URL` origin. Set this explicitly when SSR uses a private HTTP API address. Localhost HTTP portraits are accepted only in development. Without a usable public origin, solo rows show the local default silhouette.
- `MINECRAFT_ADDRESS`, `DISCORD_URL`: server address (default `play.strafemc.net`) and community link. Missing Discord configuration keeps the navigation label visible without creating a guessed invite URL.
- `HERO_IMAGE_URL`: optional HTTPS override for the server image. The original Figma server image, glow and interface icons are shipped locally in `public/design`; Archivo and Azeret Mono are self-hosted with their OFL licenses in `public/fonts`.
- `SERVER_ONLINE_COUNT`: optional manually configured online count. Omit it to hide the count; no live status is invented.
- `LEADERBOARD_REGION`: fallback region badge, default `AS`; set it empty to omit the badge. An API-provided region takes precedence.
- `TIER_THRESHOLDS`: JSON array of `{min,label}` rules sorted by descending minimum. Defaults are Tier 1 at 2600+, Tier 2 at 2250+, and Tier 3 below 2250. These thresholds are inferred from the mockup, not API-owned competitive rules. An API `tier` field takes precedence.

The Tebex markup contract and the request to manage the store with PayNow imply two provider reads: PayNow supplies purchasable products, while Tebex supplies only the rank comparison. Keep mapped product names and displayed prices consistent across the provider dashboards. For ranks comparison, use literal `<short-description>`, `<perks>`, `<value>` tags exactly as described in TABLE_MARKUP.md. Only authored perk groups/rows are rendered, with no added price or delivery rows.

Pages: `/`, `/ranks`, `/categories/:id`, `/packages/:id`, `/checkout`, `/checkout/complete`, `/tiers?mode=smp-teams|smp-solo|pvp`. SMP standings load season names from `GET /v1/leaderboards/seasons` and use `GET /v1/leaderboards/:mode?season=season-1&limit=6&offset=…` during SSR. The season selector preserves the chosen season across team/solo tabs and pagination. PVP stays empty and does not use SMP seasons. The API returns rank position. Competitive tiers are derived from `TIER_THRESHOLDS` when the API does not supply a named tier. Leaderboards paginate six entries at a time.

Solo leaderboard portraits use the appearance selected with `/account` and stored in the central API, for both current and historical standings. SSR sends the visible UUIDs to `GET /v1/accounts/skins?ids=…` using the same **leaderboards:read** key. The response contains only public appearance data; the website receives no Discord identities or OAuth tokens. Team emblems retain their initial because a team has no single player UUID. An account without a stored skin uses the local Minecraft body silhouette. `/skin` selections and external avatar services are not consulted.

Account appearances have a separate 45-second, 2048-entry cache. Overlapping requests share pending UUID reads; bulk requests contain at most 100 UUIDs and at most 16 batches run concurrently. A failed or malformed refresh retains the last cached portrait, or the local default if none is cached, and waits 45 seconds before retrying. The browser loads only cached PNGs from the configured public API origin, with no referrer; a failed PNG falls back to the local silhouette. Fixed portrait dimensions preserve row geometry, and rows after the first two use native lazy loading. No browser API key, per-row renderer or WebGL is needed.

## Checkout behavior

Choose a PayNow product, enter the Minecraft Java username, select billing/custom variables/game server if applicable, then continue to PayNow's hosted payment page. The server re-fetches the PayNow product before creating the checkout session and never accepts client prices, arbitrary product IDs or redirect URLs. Subscription options follow PayNow's `allow_subscription`/`allow_one_time_purchase` flags. Custom variable options and server selection are checked against the current product; PayNow applies its configured variable validation.

The resulting `{url}` must be HTTPS on `paynow.gg` or one of its subdomains. `return_url` and `cancel_url` come from configured `PUBLIC_BASE_URL`. The completion page does not grant purchases or assert payment success; PayNow handles its configured delivery. Any future custom fulfillment must consume verified PayNow webhooks with durable replay protection, never a browser redirect.

No credentials or products are fabricated. Missing credentials show empty store states; unavailable providers show a retry message; unmapped/unconfigured products cannot create a payment session.

## Performance and production limits

Tebex comparison data is cached for 60 seconds and team leaderboards for 15 seconds. Solo leaderboard pages are fetched for every render, with concurrent requests coalesced, so a pre-ban page cannot stay in the server cache. The API filters banned players before computing ranks, totals and pagination for both current and historical seasons. A failed refresh shows the unavailable state rather than an old player board. Points and history remain stored; unban restores ranking visibility. PayNow catalog reads have a bounded 15-second cache partitioned by client IP and a SHA-256 digest of the customer token, preserving location/customer pricing. Checkout validation bypasses that cache. Provider requests run concurrently, have seven-second timeouts, reject HTTP redirects and limit response size. Non-success provider response bodies are cancelled before throwing a generic error; their contents are never exposed to visitors or logs. HTML responses use `no-store` because they contain CSRF tokens and may include customer pricing; assets are independently cached. Concurrent reads of the same cache partition are coalesced.

Accidental checkout retries are coalesced for two minutes by signed session, customer-token digest and the exact validated order line. Switching Minecraft accounts cannot reuse another account's checkout. This map is per process: multiple replicas or a restart can create another *checkout session*. A checkout session does not grant points or products, and PayNow controls payment/delivery. If business requirements later demand durable checkout-session reuse across replicas, add a distributed store with a provider-supported expiry policy.

## Design

The six Figma frames were read through the Figma MCP: Home `7:116`, Ranks `7:162`, Checkout `7:251`, SMP Teams `57:6`, SMP Solo `57:159`, PVP `57:312`. The implementation uses those actual contexts, colors, typography, hero source image, glow and icons. Desktop spacing follows the supplied screenshots; small screens stack the home layout, scroll the rank table horizontally, and retain readable leaderboard rows. The original Figma hero image is 128×88 pixels, and is enlarged with pixelated rendering to preserve its reference appearance.

The checkout uses one centered username/order/total card. Its CHECKOUT action creates the PayNow customer token server-side when needed, then validates the product and opens hosted payment. Custom variables, game-server and subscription controls appear only for products that require them. The rank table body remains entirely authored in Tebex; mapped PayNow purchase actions sit in the table footer. Required PayNow legal links are retained below the reference footer copy.

## Verification

`pnpm build:prod` completed. Every EJS page compiled, and local unconfigured-service smoke requests returned HTTP 200 for home, ranks, tiers, checkout, completion and CSS. Browser visual review covered all six design screens at desktop and 390px mobile width. Populated ranks, checkout, team and solo states were reviewed using temporary Figma sample data; those fixtures are not part of production. Captures are saved in `design-review/`. `pnpm audit --prod` reported no known vulnerabilities. Live provider checkout and remote leaderboards require deployment credentials and were not executed.

See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for the component review and deployment considerations.

