# PayNow rank comparison markup

This document is the contract for people and AI agents editing rank product descriptions in PayNow. The store turns the structured parts of a rank description into its card copy and comparison table. PayNow is the source of truth for rank products; do **not** create a duplicate rank catalog in Supabase.

The `/ranks` comparison body contains only sections and perk rows authored inside `<perks>`. It does not inject fixed rows for rank level, price, delivery, setup, or links. Rank names and prices in the column headers come directly from PayNow product data.

## Where it renders

The rank category page (`/categories/<rank-category-id>`) is selected by the PayNow product tag configured in `PAYNOW_RANK_TAG` (default `ranks`).

Each rank package needs its own description. The package ID is the comparison-column identity, and PayNow product sort order determines the column order.

## Required syntax

Use literal tags: `<short-description>`, `<perks>`, and `<value>`. Do **not** use `<*perks*>` or `<*value*>`; those are invalid HTML and must not be saved in PayNow.

```html
<short-description>
  <p>Short copy shown on the rank card and package hero.</p>
</short-description>

<perks>
  <section data-title="SMP Perks">
    <h3>SMP Perks</h3>
    <ul>
      <li data-perk="Extra homes"><value>2</value></li>
      <li data-perk="Util Commands" data-enabled="true"></li>
    </ul>
  </section>
</perks>

<h3>Overview</h3>
<p>This remaining HTML renders on the package details page.</p>
```

`<short-description>` and `<perks>` are removed from the long package description after parsing. Everything outside them is the long description.

## Perk values

Every `<li data-perk="…">` in `<perks>` produces one table cell. Rows are merged by **section title + `data-perk`**, so use exactly the same `data-perk` spelling across ranks that should share a row.

```html
<li data-perk="Extra homes"><value>2</value></li>
<li data-perk="Extra homes"><value>3</value></li>
<li data-perk="Extra homes"><value>4</value></li>
```

An absent `<li>` is shown as missing (`—`). Do not create an empty row merely to indicate absence.

### Boolean perks

```html
<li data-perk="Util Commands" data-enabled="true"></li>
<li data-perk="Util Commands" data-enabled="false"></li>
```

`true` renders a check; `false` renders a missing mark. When `data-enabled` is present, it wins over any content in the `<li>`.

### Rich values and images

Put rich content within `<value>`. Allowed tags are `p`, `ul`, `ol`, `li`, `br`, `strong`, `em`, `b`, `i`, `code`, `img`, `h2`, `h3`, `h4`, and `span`.

```html
<li data-perk="Chat Prefix">
  <value><code>[VIP]</code></value>
</li>

<li data-perk="Prefix image">
  <value>
    <img src="https://images.example.com/wysiwyg/example.png"
         width="118" height="39" alt="VIP prefix">
  </value>
</li>
```

The renderer permits images only from exact HTTPS hostnames in the deployment's `RANK_IMAGE_HOSTS` allowlist. No image hosts are trusted by default. Add approved hosts as a comma-separated list, for example `images.example.com,cdn.example.net`. Only list hosts your administrators trust: approved image hosts still receive visitors' IP addresses when their images load. An empty list disables description images.

Credentials, explicit ports (including `:443`), non-HTTPS URLs and unlisted hosts are rejected. A hostname entry allows only that exact hostname; it does not allow its subdomains. Configuration entries must be DNS hostnames without schemes, paths, ports or wildcards. These restrictions apply to short copy, perk values and long-description HTML. Top-level product artwork provided by the trusted PayNow catalog API is handled separately.

Numeric `width` and `height`, plus text `alt`, are permitted. The renderer removes inline styles, event handlers, scripts, iframes, forms, SVG, and all other attributes/tags. Images are constrained to `max-width: min(150px, 100%)`, `max-height: 56px`, and `object-fit: contain`.

## Multiple groups: complete example

Save the following equivalent structure in each rank package, changing values only. It demonstrates short copy, scalar value, booleans, rich values, an image, two sections, and normal long-description HTML.

```html
<short-description>
  <p>Fast progression with a distinctive VIP identity.</p>
</short-description>

<perks>
  <section data-title="SMP Perks">
    <ul>
      <li data-perk="Extra homes"><value>2</value></li>
      <li data-perk="Util Commands" data-enabled="false"></li>
      <li data-perk="Daily kit"><value>VIP</value></li>
    </ul>
  </section>
  <section data-title="Cosmetics">
    <ul>
      <li data-perk="Chat Prefix"><value><code>[VIP]</code></value></li>
      <li data-perk="Prefix image">
        <value><img src="https://images.example.com/wysiwyg/example.png" width="118" height="39" alt="VIP prefix"></value>
      </li>
      <li data-perk="Particle Trails" data-enabled="true"></li>
    </ul>
  </section>
</perks>

<h3>Overview</h3>
<p>Thank you for supporting StrafeMC.</p>
```

For the matching MVP package, preserve the section and `data-perk` names but change, for example, `Extra homes` to `3`, set `Util Commands` to `true`, and update the prefix value. The table will render one `Extra homes` row with the two distinct values.

## Validation rules

- `data-perk` must be non-empty.
- Do not repeat a perk within the same section/rank; correct the description instead.
- `section[data-title]` is preferred. When missing, the first section `<h3>` is used; otherwise the title is `Perks`.
- Keep section ordering consistent across packages; the first package that defines a section/row sets its display order.
- Test the affected rank page after editing PayNow content. Invalid/malicious markup is sanitized rather than rendered.

