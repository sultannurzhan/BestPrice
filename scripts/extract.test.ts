/**
 * Tests for the generic HTML extractor.
 *
 * The fixtures below are trimmed from markup the live KZ retailers actually
 * serve, including the two layouts that previously broke it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractListings, __testing } from '../lib/scrape/extract';

const BASE = 'https://example.kz/search?q=iphone';

test('reads a struck-through original price alongside the current one', () => {
  // Regression: PRICE_RE was a shared /g/ regex, and matchAll copies lastIndex
  // from it, so this scan silently returned nothing once the main exec loop had
  // advanced. Every discount badge was lost.
  const html = `
    <div class="product__item">
      <a href="/noutbuki-acer-gadget-e10">Ноутбук Acer Gadget E10 JN21S Celeron N150 8 GB</a>
      <div class="product__item-prices">
        <div class="product__item-price-old">179 990 ₸</div>
        <div class="product__label-discount">-11%</div>
      </div>
      <div class="product__item-price">159 990&nbsp;<span> ₸ </span></div>
    </div>`;

  const { listings } = extractListings(html, 'example.kz', BASE);
  const row = listings.find((l) => l.price === 159_990);

  assert.ok(row, `expected the 159 990 row, got ${JSON.stringify(listings)}`);
  assert.equal(row.oldPrice, 179_990);
});

test('prefers the product title over card furniture', () => {
  // larek.kz puts a "Нет отзывов" link closer to the price than the title, and
  // a nearest-anchor rule captured that for every row.
  const html = `
    <div class="card">
      <a href="/product/apple-iphone-15-128gb-black">Смартфон Apple iPhone 15 128GB Black</a>
      <a href="/reviews/123">Нет отзывов</a>
      <span class="price">443 990 ₸</span>
    </div>
    <div class="card">
      <a href="/product/samsung-galaxy-a17-128gb">Смартфон Samsung Galaxy A17 6/128GB Black</a>
      <a href="/reviews/456">Нет отзывов</a>
      <span class="price">99 890 ₸</span>
    </div>`;

  const { listings } = extractListings(html, 'example.kz', BASE);

  assert.ok(listings.length >= 2, `got ${listings.length} rows`);
  for (const l of listings) {
    assert.notEqual(l.title, 'Нет отзывов');
  }
  assert.ok(listings.some((l) => /iPhone 15/i.test(l.title) && l.price === 443_990));
});

test('ignores price-range filter facets', () => {
  // Alser's sidebar renders "до 50 000 ₸" chips that look exactly like prices.
  const html = `
    <div class="filter facet-wrapper">
      <div class="chip">до 50 000 ₸ <span>(22)</span></div>
      <div class="chip">50 000 ₸ - 100 000 ₸ <span>(4)</span></div>
      <div class="chip">от 100 000 ₸ <span>(9)</span></div>
    </div>
    <div class="card">
      <a href="/product/apple-iphone-15-128gb">Смартфон Apple iPhone 15 128GB Black</a>
      <span class="price">443 990 ₸</span>
    </div>`;

  const { listings } = extractListings(html, 'example.kz', BASE);

  for (const l of listings) {
    assert.ok(
      ![50_000, 100_000].includes(l.price),
      `facet leaked through as a listing: ${JSON.stringify(l)}`
    );
  }
});

test('prefers JSON-LD when the page provides it', () => {
  const html = `
    <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Product",
     "name":"Apple iPhone 15 128GB Black","url":"/p/iphone-15",
     "offers":{"@type":"Offer","price":"443990","priceCurrency":"KZT",
               "availability":"https://schema.org/InStock"}}
    </script>
    <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Product",
     "name":"Apple iPhone 15 256GB Blue","url":"/p/iphone-15-256",
     "offers":{"@type":"Offer","price":"512990","priceCurrency":"KZT"}}
    </script>`;

  const { listings, strategy } = extractListings(html, 'example.kz', BASE);

  assert.equal(strategy, 'jsonld');
  assert.equal(listings.length, 2);
  assert.equal(listings[0].inStock, true);
  assert.ok(listings.some((l) => l.price === 512_990));
});

test('resolves relative product URLs against the search page', () => {
  const html = `
    <div class="card">
      <a href="/product/apple-iphone-15-128gb">Смартфон Apple iPhone 15 128GB Black</a>
      <span class="price">443 990 ₸</span>
    </div>
    <div class="card">
      <a href="/product/apple-iphone-15-256gb">Смартфон Apple iPhone 15 256GB Blue</a>
      <span class="price">512 990 ₸</span>
    </div>`;

  const { listings } = extractListings(html, 'example.kz', BASE);
  assert.ok(listings.length >= 2);
  for (const l of listings) {
    assert.ok(l.url?.startsWith('https://example.kz/product/'), `bad url ${l.url}`);
  }
});

test('handles thin and non-breaking spaces inside prices', () => {
  const html = `
    <div class="card">
      <a href="/product/x">Смартфон Apple iPhone 15 128GB Black</a>
      <span class="price">443 990&nbsp;₸</span>
    </div>
    <div class="card">
      <a href="/product/y">Смартфон Apple iPhone 15 256GB Blue</a>
      <span class="price">512 990 ₸</span>
    </div>`;

  const { listings } = extractListings(html, 'example.kz', BASE);
  const prices = listings.map((l) => l.price).sort((a, b) => a - b);
  assert.deepEqual(prices, [443_990, 512_990]);
});

test('treats structured price decimals as fractions, not extra digits', () => {
  const html = `
    <script type="application/ld+json">
    {"@type":"Product","name":"Apple iPhone 15 128GB",
     "offers":{"price":"443990.00","priceCurrency":"KZT"}}
    </script>
    <script type="application/ld+json">
    {"@type":"Product","name":"Apple iPhone 15 256GB",
     "offers":{"price":"512990,50","priceCurrency":"KZT"}}
    </script>`;

  const { listings } = extractListings(html, 'example.kz', BASE);
  assert.deepEqual(
    listings.map((row) => row.price),
    [443_990, 512_991]
  );
});

test('ignores explicitly non-KZT structured offers', () => {
  const html = `
    <script type="application/ld+json">
    {"@type":"Product","name":"Imported phone in dollars",
     "offers":{"price":"999","priceCurrency":"USD"}}
    </script>
    <script type="application/ld+json">
    {"@type":"Product","name":"Local phone in tenge",
     "offers":{"price":"499990","priceCurrency":"KZT"}}
    </script>`;

  const { listings } = extractListings(html, 'example.kz', BASE);
  assert.deepEqual(listings.map((row) => row.title), ['Local phone in tenge']);
});

test('selects a KZT offer from a mixed-currency JSON-LD array', () => {
  const html = `
    <script type="application/ld+json">
    {"@type":"Product","name":"Apple iPhone 15 128GB",
     "offers":[
       {"price":"999","priceCurrency":"USD"},
       {"price":"443990","priceCurrency":"KZT","availability":"OutOfStock"}
     ]}
    </script>`;

  const { listings } = extractListings(html, 'example.kz', BASE);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 443_990);
  assert.equal(listings[0].inStock, false);
});

test('skips incomplete JSON-LD offers instead of hiding a later valid price', () => {
  const html = `
    <script type="application/ld+json">
    {"@type":"Product","name":"Apple iPhone 15 128GB",
     "offers":[
       {"priceCurrency":"KZT","availability":"InStock"},
       {"price":"443990","priceCurrency":"KZT","availability":"InStock"}
     ]}
    </script>`;

  const { listings } = extractListings(html, 'example.kz', BASE);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 443_990);
});

test('honours currency and availability in microdata and embedded state', () => {
  const microdata = `
    <div itemscope itemtype="https://schema.org/Product">
      <meta itemprop="name" content="Imported iPhone 15">
      <meta itemprop="price" content="999"><meta itemprop="priceCurrency" content="USD">
    </div>
    <div itemscope itemtype="https://schema.org/Product">
      <meta itemprop="name" content="Local iPhone 15">
      <meta itemprop="price" content="443990"><meta itemprop="priceCurrency" content="KZT">
      <link itemprop="availability" href="https://schema.org/OutOfStock">
    </div>`;
  const microRows = extractListings(microdata, 'example.kz', BASE).listings;
  assert.deepEqual(microRows.map((row) => row.title), ['Local iPhone 15']);
  assert.equal(microRows[0].inStock, false);

  const embedded = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    products: [
      { name: 'Imported iPhone 15', price: 999, currency: 'USD' },
      { name: 'Local iPhone 15', price: 443_990, currency: 'KZT', stockStatus: 'InStock' },
      { name: 'Local iPhone 15 Pro', price: 599_990, currencyCode: 'KZT', available: false },
    ],
  })}</script>`;
  const embeddedRows = extractListings(embedded, 'example.kz', BASE).listings;
  assert.equal(embeddedRows.length, 2);
  assert.ok(embeddedRows.every((row) => row.price > 400_000));
  assert.deepEqual(embeddedRows.map((row) => row.inStock).sort(), [false, true]);
});

test('embedded products inherit container currency and may explicitly override it', () => {
  const embedded = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    currency: 'USD',
    padding: 'x'.repeat(220),
    products: [
      { name: 'Imported iPhone 15 128GB', price: 999 },
      { name: 'Local iPhone 15 128GB', price: 443_990, currency: 'KZT' },
    ],
  })}</script>`;

  const { listings } = extractListings(embedded, 'example.kz', BASE);
  assert.deepEqual(listings.map((row) => row.title), ['Local iPhone 15 128GB']);
});

test('accepts short but model-like product titles', () => {
  for (const title of ['iPhone 15', 'PS5', 'RTX 4090']) {
    assert.equal(__testing.isPlausibleTitle(title), true, title);
  }
  assert.equal(__testing.isPlausibleTitle('Home'), false);
});

test('parses prices split across inline markup', () => {
  const html = `
    <a href="/product/iphone-15">Apple iPhone 15 128GB</a>
    <span class="price">443 <strong>990</strong> ₸</span>`;
  const { listings } = extractListings(html, 'example.kz', BASE);
  assert.ok(listings.some((row) => row.price === 443_990), JSON.stringify(listings));
});

test('parses an HTML non-breaking-space entity between price digits', () => {
  const html = `
    <a href="/product/iphone-15">Apple iPhone 15 128GB</a>
    <span class="price">443&nbsp;990 ₸</span>`;
  const { listings } = extractListings(html, 'example.kz', BASE);
  assert.deepEqual(listings.map((row) => row.price), [443_990]);
});

test('ignores monthly installment amounts beside a full purchase price', () => {
  const html = `
    <div class="card">
      <a href="/product/iphone-15">Apple iPhone 15 128GB</a>
      <span>Рассрочка от 36 999 ₸ в месяц</span>
      <span>443 990 ₸</span>
    </div>`;
  const { listings } = extractListings(html, 'example.kz', BASE);
  assert.deepEqual(listings.map((row) => row.price), [443_990]);
});

test('ignores parenthesized and Russian installment suffixes', () => {
  const html = `
    <div class="card">
      <a href="/product/iphone-15">Apple iPhone 15 128GB</a>
      <span>36 999 ₸ (ежемесячно)</span>
      <span>39 999 ₸ — по рассрочке</span>
      <span>443 990 ₸</span>
    </div>`;
  const { listings } = extractListings(html, 'example.kz', BASE);
  assert.deepEqual(listings.map((row) => row.price), [443_990]);
});

test('keeps a three-character model title through final validation', () => {
  const html = '<a href="/product/ps5-console">PS5</a><span>299 990 ₸</span>';
  const { listings } = extractListings(html, 'example.kz', BASE);
  assert.equal(listings[0]?.title, 'PS5');
});

test('proximity extraction ignores off-site and editorial anchors', () => {
  const html = `
    <a href="https://phishing.example/product/iphone-15">Apple iPhone 15 fake shop</a>
    <a href="/blog/iphone-15-review">Apple iPhone 15 review</a>
    <a href="/product/iphone-15">Apple iPhone 15 128GB Black</a>
    <span>443 990 ₸</span>`;
  const { listings } = extractListings(html, 'example.kz', BASE);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].url, 'https://example.kz/product/iphone-15');
});

test('reads local stock wording around a proximity listing', () => {
  const html = `
    <div class="card">
      <a href="/product/iphone-15">Apple iPhone 15 128GB</a>
      <span>Нет в наличии</span><span>443 990 ₸</span>
    </div>`;
  const { listings } = extractListings(html, 'example.kz', BASE);
  assert.equal(listings[0].inStock, false);
});

test('rejects structured rows with meaningless titles', () => {
  const html = `
    <script type="application/ld+json">
      {"@type":"Product","name":"🔥🔥🔥","offers":{"price":443990,"priceCurrency":"KZT"}}
    </script>`;
  assert.equal(extractListings(html, 'example.kz', BASE).listings.length, 0);
});

test('only exposes safe same-retailer product links', () => {
  assert.equal(
    __testing.absolutize('/product/iphone', BASE),
    'https://example.kz/product/iphone'
  );
  assert.equal(__testing.absolutize('javascript:alert(1)', BASE), null);
  assert.equal(__testing.absolutize('https://phishing.example/product', BASE), null);
  assert.equal(__testing.absolutize('https://user:pass@example.kz/product', BASE), null);
});

test('preserves unknown availability instead of calling it out of stock', () => {
  assert.equal(__testing.availabilityOf('https://schema.org/InStock'), true);
  assert.equal(__testing.availabilityOf('https://schema.org/OutOfStock'), false);
  assert.equal(__testing.availabilityOf('https://schema.org/PreOrder'), null);
});

test('bounds hostile structured catalogues before they reach ranking', () => {
  const products = Array.from(
    { length: __testing.maxListings + 50 },
    (_, i) => ({
      '@type': 'Product',
      name: `Product model ${i}`,
      offers: { price: 100_000 + i, priceCurrency: 'KZT' },
    })
  );
  const html = `<script type="application/ld+json">${JSON.stringify(products)}</script>`;
  const { listings } = extractListings(html, 'example.kz', BASE);
  assert.equal(listings.length, __testing.maxListings);
});

test('malformed retailer HTML cannot trigger quadratic tag stripping', () => {
  const hostile = `${'<script '.repeat(50_000)}${'<'.repeat(250_000)}`;
  const started = performance.now();
  const result = extractListings(hostile, 'example.kz', BASE);
  const tookMs = performance.now() - started;

  assert.equal(result.listings.length, 0);
  assert.ok(tookMs < 1_500, `malformed HTML took ${Math.round(tookMs)}ms`);
});

test('price masking stays linear when malformed tags follow a valid anchor', () => {
  const hostile = `<a href="/product/ps5">Sony PS5 Console</a>${'<'.repeat(300_000)}`;
  const started = performance.now();
  extractListings(hostile, 'example.kz', BASE);
  const tookMs = performance.now() - started;
  assert.ok(tookMs < 1_500, `malformed price surface took ${Math.round(tookMs)}ms`);
});

test('bounds anchor work on hostile pages with thousands of candidates', () => {
  const anchors = Array.from(
    { length: __testing.maxAnchors + 2_000 },
    (_, i) => `<a href="/product/model-${i}">Phone model ${i}</a>`
  ).join('');
  const started = performance.now();
  extractListings(`${anchors}<span>443 990 ₸</span>`, 'example.kz', BASE);
  const tookMs = performance.now() - started;
  assert.ok(tookMs < 1_500, `large anchor page took ${Math.round(tookMs)}ms`);
});

test('understands negative stock phrases that omit the final t', () => {
  assert.equal(__testing.availabilityOf('Товар не в наличии'), false);
  assert.equal(__testing.availabilityOf('data-available="false"'), false);
});
