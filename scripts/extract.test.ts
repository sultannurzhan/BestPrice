/**
 * Tests for the generic HTML extractor.
 *
 * The fixtures below are trimmed from markup the live KZ retailers actually
 * serve, including the two layouts that previously broke it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractListings } from '../lib/scrape/extract';

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
