# BestPrice

Finds a tech product in the shops around you and ranks them by what the purchase
**actually costs** — sticker price plus the cost of getting there.

You give it three things: your location, a radius, and an item. It does the rest.

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>. No API keys required.

---

## How it works

```
      your location + radius                    your item
              │                                     │
              ▼                                     ▼
   ┌──────────────────────┐              ┌────────────────────┐
   │ OpenStreetMap        │              │ query parser       │
   │ (Overpass API)       │              │ brand/model/       │
   │ tech shops in radius │              │ storage/category   │
   └──────────┬───────────┘              └─────────┬──────────┘
              │ shops + their websites             │
              ▼                                    │
   ┌──────────────────────┐                        │
   │ group by domain      │  11 Technodom pins =   │
   │ (one scrape/chain)   │  1 HTTP request        │
   └──────────┬───────────┘                        │
              ▼                                    │
   ┌──────────────────────┐                        │
   │ scrape each retailer │◄───────────────────────┘
   │ adapter │ generic    │
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐   throws out cases, cables,
   │ match filter         │   chargers, wrong models,
   └──────────┬───────────┘   used units, wrong storage
              ▼
   ┌──────────────────────┐   price + travel + time
   │ true-cost ranking    │
   └──────────────────────┘
```

### 1. Store discovery — OpenStreetMap

`lib/overpass.ts` queries the Overpass API for `shop=electronics|computer|
mobile_phone|hifi|video_games|camera|appliance` within your radius. Free, no key,
worldwide.

Three things that matter in practice, all learned the hard way:

- **Mirror failover with retries.** The public Overpass instances return 504
  under load constantly. We try six mirrors, retrying transient statuses once.
- **No regex tag filters.** `["shop"~"^(a|b|c)$"]` bypasses Overpass's tag index
  and times out; separate exact-match clauses return in ~15 s.
- **Disk-backed store cache** (`.cache/`). During development *every* mirror
  failed simultaneously, which took the whole app down. Shop locations barely
  change, so they are persisted indefinitely and served stale (with a notice)
  when Overpass is unreachable. Prices are never served stale from disk.

### 2. Chain grouping — the main efficiency win

A chain quotes one online price for all its branches. So eleven Technodom pins
cost exactly **one** HTTP request, and the nearest branch is the one you get
routed to. Central Almaty has ~120 mapped shops but only ~30 unique domains.

### 3. Scraping — adapters plus a generic extractor

Only a handful of shops are big chains, so hardcoded adapters alone would cover
about half the market. `lib/scrape/extract.ts` runs four strategies in order of
trustworthiness and takes the first that yields usable rows:

1. **JSON-LD** — schema.org `Product`/`Offer`. Exact when present.
2. **Microdata** — `itemprop="price"`.
3. **Embedded JSON** — `__NEXT_DATA__`, Nuxt payloads, Bitrix blobs.
4. **Proximity** — pair each visible price with its most product-like nearby link.

Strategy 4 is the workhorse for the long tail. It scans **both directions** from
each price (some templates put the title above, some below) and scores candidate
anchors on how much they look like a product title — because on `larek.kz` the
closest link to the price is "Нет отзывов" ("no reviews"), which a naive
nearest-anchor rule captures for every single row.

**Finding the search URL** (`lib/scrape/discover.ts`) is its own problem. We try
ten conventional patterns, then read the site's own `<form>` and its schema.org
`SearchAction`. A candidate is only accepted if it (a) did not bounce to the
homepage, (b) shows several prices, and (c) shows at least two product links that
actually mention what you searched for.

> That last check exists because `sulpak.kz` silently redirects an unknown
> `/search?q=` to its homepage, whose recommendation carousel is full of prices.
> Without a relevance check the agent confidently "finds" a microwave when you
> asked for an iPhone.

### 4. Match filtering — why this is most of the work

Searching any KZ retailer for "iphone" returns cases and car chargers long before
it returns a phone. Rank on sticker price alone and the best deal is always a
690 ₸ cable. `lib/product.ts` rejects a listing when:

| Rule | Example it kills |
|---|---|
| Accessory keywords | `АЗУ Inkax Iphone Lightning USB` → charger |
| Condition keywords | `iPhone 15 (б/у)`, `копия 1:1` |
| Category price floor | an "iPhone" at 3 990 ₸ is a case |
| **Model identifier** | `Samsung Galaxy A17` must not match `Galaxy Buds` |
| Storage mismatch | asked 256 GB, listing is 128 GB |
| Token coverage < 66 % | title is about something else |

The model-identifier rule is the important one: any query token containing a
digit (`15`, `a17`, `s24`, `m3`) is treated as **mandatory**, not merely counted.
Matched whole-word, so `a5` never matches `a55`.

> **A note for anyone extending this:** JavaScript's `\b` is defined against
> `[A-Za-z0-9_]`, so `/\b(чехол)\b/` **never matches a Cyrillic title**. Every
> Russian keyword rule here uses the Unicode lookarounds in `lib/product.ts`
> instead. This bug was live and silent — the accessory filter did nothing, and
> only the price floor was catching cases.

### 5. Ranking — true cost, not sticker price

A phone 20 km away that is 3 000 ₸ cheaper costs more once you have paid for the
fuel and given up an hour. `lib/rank.ts`:

```
total = price
      + round-trip travel   (distance × 1.3 detour × 2 × 35 ₸/km)
      + round-trip time     (at 22 km/h city average + 6 min parking, × 1 200 ₸/h)
```

Then a soft penalty for low match confidence and for listings marked out of
stock. Constants are at the top of `lib/rank.ts` — tune them to your own view of
what an hour is worth.

---

## Coverage — an honest accounting

This is the part most price-comparison demos hide. Free scraping cannot read
every shop, so the UI states which ones it could not read **and why**, rather
than implying they had no stock.

Measured against live sites in central Almaty:

| Retailer | Status |
|---|---|
| **Freedom Mobile** (`fmobile.kz`) | ✅ works — 17 branches, widest physical reach |
| **ТехноGrad** (`tgrad.kz`) | ✅ works — real server-side search |
| **Larek** (`larek.kz`) | ✅ works — real server-side search |
| Technodom, Mechta, DNS, iSpace, iFix | ❌ HTTP 403 / Cloudflare challenge |
| Sulpak, Alser, Shop.kz, Белый Ветер | ❌ results rendered by JavaScript |
| Marvel | ❌ B2B, prices behind a trade account |

One caveat worth stating plainly: **Freedom Mobile does not search server-side.**
Every `?s=` query returns the same 3.8 MB page carrying a ~911 KB JSON catalogue
of roughly 260 products, which the site filters in the browser. We read that
catalogue and apply our own filtering, so its prices are real — but its range is
limited to what is in that feed. Ask for something outside it (a Galaxy S24, say)
and you correctly get nothing rather than a wrong answer.

`tgrad.kz` and `larek.kz` do search properly, but stock little Apple or Samsung
flagship inventory — searching them for "iphone 15" genuinely returns cables and
batteries, which the match filter then discards.

The blocked names are the big chains, so **coverage is genuinely limited**. Two
ways to widen it, in order of effort:

1. **Headless browser** for the JavaScript-rendered shops (Playwright against
   Sulpak / Alser / Shop.kz). These do not block you — they just need JS. This is
   the single highest-value addition and would roughly double coverage.
2. **Official APIs or affiliate feeds** for the chains that block scrapers.

Do not try to defeat the bot protection on the 403 sites. `lib/fetcher.ts`
deliberately identifies as a normal browser but **never rotates identities after
a refusal** — one block and we back off, cache the refusal for 30 minutes, and
report it in the UI.

---

## Layout

```
app/
  page.tsx              the whole UI
  api/deals/route.ts    the agent, streaming progress over SSE
lib/
  overpass.ts           OSM store discovery + chain grouping
  product.ts            query parsing + match filtering   ← most of the logic
  rank.ts               true-cost model
  fetcher.ts            polite HTTP: per-host limits, timeouts, block detection
  cache.ts              in-memory TTL cache with single-flight
  diskCache.ts          persistent store cache, survives Overpass outages
  llm.ts                optional OpenRouter (query parsing + verdict)
  scrape/
    discover.ts         find a working, *relevant* search URL
    extract.ts          four extraction strategies
    adapters.ts         per-retailer knowledge, verified against live sites
scripts/
  probe.ts              diagnostic: what did we read, what was rejected, why
  match.test.ts         query parsing, filtering, cost model
  extract.test.ts       HTML extraction, using real retailer markup
  resilience.test.ts    behaviour when Overpass is down
```

## Commands

```bash
npm run dev      # development server
npm run build    # production build
npm test         # matcher + cost-model tests
```

Diagnose a retailer — use this when a shop stops returning results, since sites
redesign and adapters go stale:

```bash
npm run probe -- fmobile.kz "iphone 15"
```

It prints the search URL used, every listing read, and a tally of exactly why
each one was rejected.

## Optional: OpenRouter

Copy `.env.example` to `.env.local` and add a key to enable two things: better
parsing of messy free-text queries, and a natural-language verdict above the
results. **Neither can change a price or a ranking** — both fall back to the
rule-based path silently on any failure.

## Limitations

- Prices come from each retailer's public website and can lag the shelf.
  Always confirm before travelling.
- Stock is usually unknown; only some shops publish it.
- Coverage depends on what OpenStreetMap knows. A shop with no `website` tag
  cannot be priced, only located.
- Travel cost assumes driving. There is no public-transport or walking model.
- The cache is per-process. Running multiple instances needs Redis instead.
