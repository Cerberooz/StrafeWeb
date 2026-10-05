# StrafeMC store

Independent Node.js SSR application, default port **5020**. Every page is rendered on the server with Express/EJS; browser JavaScript handles copying the server address, preventing accidental double submissions and replacing unavailable portrait images with the local default.

## Run

Requires Node.js 22.9+ and pnpm.

`package.json` pins pnpm to **10.18.3** for Corepack, including Docker builds. Both dependency-install stages copy `pnpm-workspace.yaml`, which explicitly permits esbuild's installation script and fails on other unapproved dependency scripts. Commit these files together; dependency installation inside Docker does not inherit approvals made on the VPS host.

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
  --mount type=volume,source=strafemc-store-data,target=/app/data \
  -e HOST=0.0.0.0 \
  --publish 127.0.0.1:5020:5020 \
  strafemc-store:latest
```

The port is published only on host loopback so the VPS reverse proxy can terminate HTTPS. Set `PUBLIC_BASE_URL` to the public HTTPS store URL, set `API_SERVER_BASE_URL` to the public HTTPS API URL, and keep the leaderboard API key in this server-side environment. The application requires HTTPS for a non-local API URL in production. Build and run this image independently of the API image; they do not need a shared folder or Compose project.

## Provider configuration

- `PAYNOW_STORE_ID`, `PAYNOW_API_KEY`: server credentials used to load the PayNow storefront catalog. Products, pricing, descriptions and order fulfillment are managed in PayNow. Give the credential only the permissions required for storefront reads. Minecraft direct auth uses PayNow's supported username flow; payment uses the resulting customer token.
- `PAYNOW_RANK_TAG`: PayNow product tag slug identifying rank products (default `ranks`). Those products also supply the rank comparison columns, descriptions and prices; other tags become catalog categories. Put the comparison markup from [TABLE_MARKUP.md](TABLE_MARKUP.md) in each PayNow rank product description.
- `RANK_IMAGE_HOSTS`: optional comma-separated exact DNS hostnames for images embedded in PayNow description/perk HTML. The default is empty. No wildcards, subdomain matching, credentials, explicit ports or non-HTTPS images are allowed. Only approve hosts your administrators trust because approved hosts receive visitor IPs. Product artwork from PayNow and the configured hero image are handled separately.
- `API_SERVER_BASE_URL`, `API_SERVER_API_KEY`: points API connection. Use a dedicated **leaderboards:read** key and TLS for any non-localhost connection. Older `POINTS_API_BASE_URL`/`POINTS_API_KEY` aliases are accepted. API credentials never appear in pages or browser code.
- Avatar images use the fixed `https://render.crafty.gg` CDN origin. A public API image origin is no longer required; `API_SERVER_PUBLIC_BASE_URL` is unused.
- `MINECRAFT_ADDRESS`, `DISCORD_URL`: server address (default `play.strafemc.net`) and community link. Missing Discord configuration keeps the navigation label visible without creating a guessed invite URL.
- `HERO_IMAGE_URL`: optional HTTPS override for the server image. The default server preview (`public/design/Hero_Image.png`), glow and interface icons are shipped locally in `public/design`; Archivo and Azeret Mono are self-hosted with their OFL licenses in `public/fonts`.
- `SERVER_STATUS_ADDRESS`: optional status target override; defaults to `MINECRAFT_ADDRESS`. The homepage fetches the real online count through mcsrvstat.us, cached for five minutes across visitors. Provider failures show “Status unavailable”; confirmed offline servers show “Offline”. No status API key is needed.
- SMP columns use cumulative population cutoffs: S top 0.1%, A top 1%, B top 5%, C top 20%, F the remainder. Cutoffs round upward and reserve one entry per tier when at least five entries exist. The former `TIER_THRESHOLDS` point thresholds are unused.

PayNow is the only store provider. Rank products, comparison order, names, images, prices and descriptions all come from the same PayNow storefront response. Use literal `<short-description>`, `<perks>`, and `<value>` tags in each PayNow rank product description as described in TABLE_MARKUP.md. Only authored perk groups and rows are rendered; the site does not add price or delivery rows to the comparison body.

Pages: `/`, `/ranks`, `/categories/:id`, `/packages/:id`, `/checkout`, `/checkout/complete`, `/tiers?mode=smp-teams|smp-solo|pvp`. SMP standings load season names from `GET /v1/leaderboards/seasons` and retrieve the board in 100-entry pages, with at most five leaderboard requests in flight. Up to 10,000 entries are grouped into population-based tier columns, sorted by descending points. The season selector preserves the chosen season across Team/Solo tabs. PVP stays empty and does not use SMP seasons.

Solo portraits use [Crafty's 3D skin renderer](https://crafty.gg/skin-service): upper-body busts in both the thin leaderboard rows and the circular profile avatar. Rows and profiles share the exact image URL so opening a profile reuses the cached render. Premium accounts use their verified UUID and official skin. Cracked accounts use the canonical texture hash selected with `/account skin`; their offline UUID and ordinary `/skin` changes are never used to choose the image. Teams display names with an expandable roster and no avatar. SSR reads account metadata through `GET /v1/accounts/skins?ids=…&resolvePremium=false` with its **leaderboards:read** key. This avoids Mojang lookups during page rendering. The response exposes no Discord identifiers or OAuth tokens.

Account metadata has a 45-second, 2048-entry cache. Overlapping requests share pending UUID reads; each bulk request contains at most 100 UUIDs and at most 16 batches run concurrently. Larger boards continue in bounded batches without losing rows evicted from the shared cache. A failed or malformed refresh retains the last cached appearance or uses the local default, with a 45-second retry delay. Images load directly from Crafty's CDN using browser/CDN caching and no referrer; unavailable renders fall back to local silhouettes. Later leaderboard rows use native lazy loading; the profile reuses the same bust image. Fixed dimensions prevent layout shifts. The browser receives no API key and performs no WebGL rendering. Crafty's cold-render latency and cache lifetime are controlled by that provider.

## Checkout behavior

Choose a PayNow product, enter the Minecraft Java username, select billing/custom variables/game server if applicable, then continue to PayNow's hosted payment page. The server re-fetches the PayNow product before creating the checkout session and never accepts client prices, arbitrary product IDs or redirect URLs. Subscription options follow PayNow's `allow_subscription`/`allow_one_time_purchase` flags. Custom variable options and server selection are checked against the current product; PayNow applies its configured variable validation.

The resulting `{url}` must be HTTPS on `paynow.gg` or one of its subdomains. `return_url` and `cancel_url` come from configured `PUBLIC_BASE_URL`. The completion page does not grant purchases or assert payment success; PayNow handles its configured delivery. Any future custom fulfillment must consume verified PayNow webhooks with durable replay protection, never a browser redirect.

No credentials or products are fabricated. Missing credentials show empty store states; unavailable providers show a retry message; unmapped/unconfigured products cannot create a payment session.

## Discord purchase notifications

The webapp receives PayNow's signed order-completion events at `POST /webhooks/paynow` and sends **New Purchase Received!** embeds through the Discord bot. The green sidebar stays **#8CDE9F**. The embed includes the supporter, products, store link, community goal progress and player head, with the footer **StrafeMC . The Only Competitive Network You Need.** Prices and billing details are omitted.

The webapp substitutes these placeholders from the signed order. It uses PayNow's `product_names` summary, falling back to the order-line names when absent. Billing details are not posted. Bot mode uses the bot's Discord server nickname, avatar and role color automatically; the embed sidebar stays #8CDE9F. This integration does not require changes to StrafeAPI.

Purchase embeds show a Minecraft head thumbnail via Crafty. When the PayNow Minecraft UUID matches a Strafe account, cached canonical account skin metadata is used (including cracked player texture selections). Otherwise the Minecraft username is resolved by Crafty, with its default skin when no official skin exists.

Purchase announcements are sent only by the bot and inherit its server nickname, avatar and role color. The player head remains the embed thumbnail. Legacy delivery records retain duplicate protection, but messages from retired senders are not edited or reposted. Existing bot receipts retain their original channel for edits.

Community Goal reads an enabled `payment_goal` from PayNow using `PAYNOW_API_KEY`, then the v2 order summary's gross revenue in UTC. Grant `webstore_read`, `stats_revenue_read` and `order_read`. If revenue is null with completed orders, the reader checks up to 100 recent completed orders and only displays zero when the entire goal period is covered and every order total is zero. Missing/paid/incomplete data stays unavailable. Daily, monthly and lifetime windows are supported; other periods show unavailable. Set `PAYNOW_GOAL_MODULE_ID` only to choose between multiple active goals. The percentage respects the module's overflow setting. Requests share a 30-second cache and concurrent fetch; failures back off 15 seconds and never prevent the purchase notification. A receipt retains its purchase-time goal snapshot. No prices are posted. Gross revenue/UTC are this integration's explicit basis; a future custom repeating bossbar can use its own target and cycle rules with the same PayNow totals.

### Bot setup (colored sender and online status)

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), create an application, and open **Bot**. Set its name/avatar and copy its **bot token** into StrafeWeb's server `.env` as `DISCORD_PURCHASE_BOT_TOKEN`. This differs from an OAuth client secret. Keep the token private. Resetting an existing bot's token also affects other services using that bot.
2. Under **OAuth2 → URL Generator**, select the **bot** scope and **View Channels**, **Send Messages**, **Embed Links** permissions. Open the generated URL to add the bot to your server. Administrator and privileged Gateway intents are not required.
3. Enable Discord **User Settings → Advanced → Developer Mode**. Right-click the target text channel, choose **Copy Channel ID**, and set `DISCORD_PURCHASE_CHANNEL_ID`. Ensure the bot has those permissions in this channel, including channel overrides.
4. Set its server nickname (for example `store.strafemc.net`) and assign a colored role. Gradients require the server's Enhanced Role Styles feature. Its highest applicable colored role determines the sender color.
5. Keep your existing PayNow settings, subscriptions and Docker volume. Remove obsolete Discord webhook URL/name settings from your deployment environment. Saved bot receipts retain their original channel for later edits.
6. Rebuild and recreate the container using the commands below. The bot connects inside the webapp process, displays Online after login, and reconnects through discord.js after Gateway disconnects. It requests no Gateway intents and does not read chat messages. Shutdown closes the connection. Allow outbound HTTPS and secure WebSocket access to Discord; no extra inbound port is needed.

```dotenv
DISCORD_PURCHASE_BOT_TOKEN=your-private-bot-token
DISCORD_PURCHASE_CHANNEL_ID=your-channel-id
```

Check `sudo docker logs --tail 100 strafemc-store` for `discord_bot_online`. If you see `discord_bot_login_failed`, check the token/network and restart after correcting it. The webapp continues serving requests if presence login fails. Validate delivery with a new completed order or a previously unsent PayNow event; recorded orders will not be posted again. Local tests do not verify live Discord delivery.

### PayNow event setup

1. In PayNow, create a **JSON (v1)** webhook subscribed to **Order Completed**, with URL `https://strafemc.net/webhooks/paynow`. Copy its signing secret into `PAYNOW_WEBHOOK_SECRET`; this is not your API key.
2. Configure `PAYNOW_STORE_ID`, `DISCORD_PURCHASE_BOT_TOKEN` and `DISCORD_PURCHASE_CHANNEL_ID` together. Leaving all notification settings empty disables the receiver with HTTP 503.
3. Set `PAYNOW_WEBHOOK_DATA_DIR=/app/data/paynow-discord` in Docker and retain the volume. Your proxy must forward the body and PayNow signature headers.
4. Rebuild and recreate the container. Disable any separate PayNow-to-Discord delivery integration to avoid duplicate announcements.

Purchase announcements never mention or ping the purchaser. `allowed_mentions` disables mention parsing, and the message contains only the embed. Discord-link events are accepted for compatibility, but do not add a user mention. PayNow only needs the **Order Completed** subscription for purchase announcements.

From the updated StrafeWeb directory on your VPS, after saving `.env`:

```sh
sudo docker build -t strafemc-store:latest .
# Continue only after a successful build.
sudo docker stop strafemc-store
sudo docker rm strafemc-store
sudo docker run -d \
  --name strafemc-store \
  --restart unless-stopped \
  --env-file .env \
  -e HOST=0.0.0.0 \
  --mount type=volume,source=strafemc-store-data,target=/app/data \
  --publish 127.0.0.1:5020:5020 \
  strafemc-store:latest
sudo docker logs --tail 50 strafemc-store
```

The image creates `/app/data` owned by its `node` runtime user; Docker copies that ownership into a new named volume. Existing/bind-mounted volumes must also be writable by that user (UID 1000). Keep this volume when replacing the container.

Signatures use HMAC-SHA256/base64 over the original `timestamp.body` bytes, with a five-minute timestamp tolerance and store ID validation. Completed orders create notifications; the optional Discord-link event can only save a linked ID or edit a previously confirmed purchase notification. Successful sends/edits return 204; failures return 503 so PayNow can retry. Events for each order run in sequence. Completed order IDs, minimal message content, Discord message IDs and verified linked user IDs are recorded in the mounted directory and survive restarts. Run one webapp replica with this file-based notification store. There is a small duplicate window if Discord accepts a post but the request times out or the process stops before saving its receipt; Discord webhooks do not offer an idempotency key. Notifications do not grant purchases or ranks.

Run `node --test tests/paynow-discord.test.mjs` to check signature validation, store isolation, safe message content, retry behavior and persistence without sending real notifications. Official references: [PayNow signature validation](https://docs.paynow.gg/webhooks/validating-incoming-webhooks/), [Order Completed payload](https://docs.paynow.gg/webhooks/events/on-order-completed/) and [Discord webhooks](https://docs.discord.com/developers/resources/webhook#execute-webhook).

## Performance and production limits

PayNow catalog data is cached for 15 seconds and team leaderboards for 15 seconds. Solo leaderboard pages are fetched for every render, with concurrent requests coalesced, so a pre-ban page cannot stay in the server cache. The API filters banned players before computing ranks, totals and pagination for both current and historical seasons. A failed refresh shows the unavailable state rather than an old player board. Points and history remain stored; unban restores ranking visibility. PayNow catalog reads have a bounded 15-second cache partitioned by client IP and a SHA-256 digest of the customer token, preserving location/customer pricing. Checkout validation bypasses that cache. Provider requests run concurrently, have seven-second timeouts, reject HTTP redirects and limit response size. Non-success provider response bodies are cancelled before throwing a generic error; their contents are never exposed to visitors or logs. HTML responses use `no-store` because they contain CSRF tokens and may include customer pricing; assets are independently cached. Concurrent reads of the same cache partition are coalesced.

Accidental checkout retries are coalesced for two minutes by signed session, customer-token digest and the exact validated order line. Switching Minecraft accounts cannot reuse another account's checkout. This map is per process: multiple replicas or a restart can create another *checkout session*. A checkout session does not grant points or products, and PayNow controls payment/delivery. If business requirements later demand durable checkout-session reuse across replicas, add a distributed store with a provider-supported expiry policy.

## Team roster snapshots

Team rows show the roster last explicitly published for the viewed season with `/strafe tiers team push`. Joining, leaving or changing roles does not automatically alter the public roster. Seasons without a published roster show “Team roster is not available yet.” Apply the API migration `20261011000000_manual_season_team_rosters.sql` before using this behavior. Team leaderboard caching may delay a delivered push by up to 15 seconds.

## Leaderboard information

The Information dropdown above the SMP board contains Points and Kit tabs. Points explains the same cumulative S/A/B/C/F percentiles used for the board (0.1%, 1%, 5%, 20%, then the remaining population), including rounding and the minimum of one entry per tier for populations of five or more. Team and Solo populations are separate.

Kit uses the **viewed** season's `kitImageUrl` from the API's season metadata, and displays “Recommended Kit for Season 1” (or that season's display name). Apply the API migration `20261010000000_season_kit_images.sql` with `pnpm migrate:prod`, then set each season's `point_seasons.kit_image_url` in Supabase Table Editor to a public HTTPS image URL. Missing or failed images show a small unavailable message. Images load directly in the visitor's browser, without sending API credentials; only that response's validated image origin is added to its image CSP. Season metadata retains the existing 15-second cache.

## Design

The six Figma frames were read through the Figma MCP: Home `7:116`, Ranks `7:162`, Checkout `7:251`, SMP Teams `57:6`, SMP Solo `57:159`, PVP `57:312`. The implementation uses those actual contexts, colors, typography, hero source image, glow and icons. Desktop spacing follows the supplied screenshots; small screens stack the home layout, scroll the rank table horizontally, and retain readable leaderboard rows. The original Figma hero image is 128×88 pixels, and is enlarged with pixelated rendering to preserve its reference appearance.

The checkout uses one centered username/order/total card. Its CHECKOUT action creates the PayNow customer token server-side when needed, then validates the product and opens hosted payment. Custom variables, game-server and subscription controls appear only for products that require them. The rank table body is authored in PayNow product descriptions; purchase actions link directly to those PayNow products. Required PayNow legal links are retained below the reference footer copy.

## Verification

`pnpm build:prod` completed. Every EJS page compiled, and local unconfigured-service smoke requests returned HTTP 200 for home, ranks, tiers, checkout, completion and CSS. Browser visual review covered all six design screens at desktop and 390px mobile width. Populated ranks, checkout, team and solo states were reviewed using temporary Figma sample data; those fixtures are not part of production. Captures are saved in `design-review/`. `pnpm audit --prod` reported no known vulnerabilities. Live provider checkout and remote leaderboards require deployment credentials and were not executed.

See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for the component review and deployment considerations.




