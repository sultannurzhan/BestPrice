import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing } from '../lib/scrape/discover';

test('recognises Cyrillic tenge abbreviations in discovered search pages', () => {
  const html = `
    <a href="/p/1">Apple iPhone 15 128GB Black</a><span>443 990 тг</span>
    <a href="/p/2">Apple iPhone 15 256GB Blue</a><span>512 990 тг</span>
    <a href="/p/3">Apple iPhone 15 Pro 256GB</a><span>649 990 тг</span>`;

  const verdict = __testing.judge(
    html,
    'https://example.kz/search?q=iphone',
    'https://example.kz/search?q=iphone',
    ['iphone']
  );
  assert.equal(verdict.accepted, true);
});

test('does not mistake relevant blog and navigation links for product results', () => {
  const html = `
    <a href="/blog/iphone-15-review">iPhone 15 full review</a><span>443 990 ₸</span>
    <a href="/news/iphone-15-launch">iPhone 15 launch news</a><span>512 990 ₸</span>
    <a href="/catalog/phones">Browse iPhone 15 phones</a><span>649 990 ₸</span>`;
  const verdict = __testing.judge(
    html,
    'https://example.kz/search?q=iphone',
    'https://example.kz/search?q=iphone',
    ['iphone']
  );
  assert.equal(verdict.accepted, false);
});

test('accepts compact product paths and short model titles', () => {
  const html = `
    <a href="/p/ps5-1">PS5</a><span>299 990 ₸</span>
    <a href="/p/ps5-2">PS5 Slim</a><span>319 990 ₸</span>
    <a href="/p/ps5-3">Sony PS5</a><span>339 990 ₸</span>`;
  const verdict = __testing.judge(
    html,
    'https://example.kz/search?q=ps5',
    'https://example.kz/search?q=ps5',
    ['ps5']
  );
  assert.equal(verdict.accepted, true);
});

test('normalises Russian aliases when judging product results', () => {
  const html = `
    <a href="/p/1">Айфон 15 128 ГБ</a><span>443 990 ₸</span>
    <a href="/p/2">Айфон 15 256 ГБ</a><span>512 990 ₸</span>
    <a href="/p/3">Айфон 15 Pro 256 ГБ</a><span>649 990 ₸</span>`;
  const verdict = __testing.judge(
    html,
    'https://example.kz/search?q=iphone15',
    'https://example.kz/search?q=iphone15',
    ['iphone', '15']
  );
  assert.equal(verdict.accepted, true);
});

test('does not count off-site product links as retailer results', () => {
  const html = `
    <a href="https://affiliate.example/p/1">Apple iPhone 15 128GB</a><span>443 990 ₸</span>
    <a href="https://affiliate.example/p/2">Apple iPhone 15 256GB</a><span>512 990 ₸</span>
    <a href="https://affiliate.example/p/3">Apple iPhone 15 Pro</a><span>649 990 ₸</span>`;
  const verdict = __testing.judge(
    html,
    'https://example.kz/search?q=iphone',
    'https://example.kz/search?q=iphone',
    ['iphone', '15']
  );
  assert.equal(verdict.accepted, false);
});

test('rejects search probes redirected onto another host', () => {
  const html = `
    <a href="/p/1">Apple iPhone 15 128GB</a><span>443 990 ₸</span>
    <a href="/p/2">Apple iPhone 15 256GB</a><span>512 990 ₸</span>
    <a href="/p/3">Apple iPhone 15 Pro</a><span>649 990 ₸</span>`;
  const verdict = __testing.judge(
    html,
    'https://affiliate.example/search?q=iphone',
    'https://example.kz/search?q=iphone',
    ['iphone', '15']
  );
  assert.equal(verdict.accepted, false);
});

test('validates persisted endpoint templates before reuse', () => {
  assert.equal(__testing.isSearchEndpoint({ template: '/search?q={q}' }), true);
  assert.equal(__testing.isSearchEndpoint({}), false);
  assert.equal(__testing.isSearchEndpoint({ template: 'https://evil.example/{q}' }), false);
  assert.equal(__testing.isSearchEndpoint({ template: '/search?q=phone' }), false);
});
