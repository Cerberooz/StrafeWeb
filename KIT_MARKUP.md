# Season Kit HTML

The **Tiers → Information → Kit** tab renders a small HTML fragment from the viewed season's `point_seasons.kit_html`. Edit this field in Supabase Table Editor to change headings, copy, images, lists and limits. Text uses the website's own fonts and stays readable on mobile.

## Setup

1. Deploy the updated WebApp and run `pnpm migrate:prod` from **API-Server** to apply `20261022000000_season_kit_html.sql`.
2. In Supabase, open **Table Editor → point_seasons** and select the season, such as `season-1`.
3. Copy [examples/season-1-kit.html](examples/season-1-kit.html) into `kit_html` and save. The example contains your Bliss SMP x Diamond SMP title, original inventory screenshot, five bans and three limits.
4. Wait up to 15 seconds for cached season metadata to refresh, then refresh the page.

The example uses your public Supabase screenshot URL and local vanilla icons. The image link has no signed expiry; it stays available while the file and bucket remain public. No image-host environment setting is required for the example. A local screenshot copy is also available at `/assets/kits/season-1-kit.png`. Keep the `public/kits` and `public/minecraft` directories in deployments; the build copies them into `dist/public`.

`kit_html` is optional. Empty or fully removed content falls back to the existing `kit_image_url`, then the unavailable message. An HTML fragment replaces the old image-only layout; images appear wherever you put them inside it. Each season has independent content. This feature does not change the Points tab.

## Ready-to-edit structure

Paste an HTML **fragment**, without `<html>`, `<head>` or `<body>` wrappers:

```html
<h3>Bliss SMP x Diamond SMP</h3>
<p>Bring your own kit!</p>

<kit-image alt="Example kit inventory"></kit-image>

<section>
  <h4>Item Bans</h4>
  <ul class="kit-list">
    <li><mc-icon name="netherite_chestplate"></mc-icon><span>Netherite Armor</span></li>
    <li><mc-icon name="mace"></mc-icon><span>Mace PvP</span></li>
  </ul>
</section>

<section>
  <h4>Limitations</h4>
  <ul class="kit-list">
    <li><mc-icon name="heart"></mc-icon><span class="kit-label">Spear damage</span><strong class="kit-value">5 hearts</strong></li>
    <li><mc-icon name="clock"></mc-icon><span class="kit-label">Pearl Cooldown</span><strong class="kit-value">20s</strong></li>
  </ul>
</section>
```

`<kit-image>` inserts the season's existing `kit_image_url` at that position. It is omitted if no valid URL is configured. Alternatively, use `<img class="kit-screenshot" src="/assets/kits/season-1-kit.png" alt="Example inventory">` for the bundled screenshot, or supply your own public HTTPS image URL. External image origins are added to the page's image CSP only after sanitization; `RANK_IMAGE_HOSTS` is not needed for administrator-authored season content. Use trusted public image hosts; their servers receive image requests from visitors. No API or storage credentials belong in the HTML.

## Vanilla Minecraft icons

Use a paired `<mc-icon name="…"></mc-icon>` tag. Icons are extracted unchanged from Mojang's official Minecraft Java 1.21.4 client, displayed at 18px with pixel rendering. No icons are AI-generated. The client hash and individual texture checksums are recorded in [public/minecraft/SOURCES.json](public/minecraft/SOURCES.json). The tipped arrow uses the game's base/head layers, with a red potion tint. The icons are decorative because each row supplies its text label.

| Name | Icon |
| --- | --- |
| `netherite_chestplate` | Netherite chestplate |
| `tnt_minecart` | TNT minecart |
| `end_crystal` | End crystal |
| `mace` | Mace |
| `tipped_arrow` | Red tipped arrow |
| `heart` | Full red HUD heart |
| `clock` | Clock |

Unknown icon names render no icon. Add ordinary rows or remove rows as needed; you do not need to edit an image to change a rule.

## Formatting

| Markup | Appearance |
| --- | --- |
| `<h3>` | Compact content title |
| `<p>` | Muted subtitle or explanatory text |
| `<section>` | Section separated by a subtle line |
| `<h4>` | Small uppercase section label |
| `<ul class="kit-list">` | Plain rows without bullets |
| `<span class="kit-label">` | Flexible muted row label |
| `<strong class="kit-value">` | Right-aligned limit or value |
| `<img class="kit-screenshot">` | Responsive inventory screenshot |

Allowed tags: `section`, `div`, `h3`, `h4`, `p`, `ul`, `ol`, `li`, `span`, `strong`, `em`, `b`, `i`, `br`, `hr`, `code`, `img`, plus the two formatter tags above. Only the documented kit classes (and `kit-title`, `kit-subtitle`, `kit-section`) are kept. HTML is limited to 20,000 characters and 24 rendered images. Scripts, event handlers, styles, forms, iframes, SVG and arbitrary classes are removed. Images must use public HTTPS URLs or paths under `/assets/kits/` or `/assets/minecraft/` without parent-directory traversal. Failed content images show a short inline fallback while the rules remain visible.
