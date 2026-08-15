import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseQuery } from '../lib/product';
import { rankDeals } from '../lib/rank';
import type { DomainResult, Listing, Store } from '../lib/types';

const store: Store = {
  id: 'node/1',
  name: 'Example Shop',
  domain: 'example.kz',
  website: 'https://example.kz',
  shopType: 'electronics',
  coords: { lat: 43.2, lon: 76.9 },
  distanceM: 500,
  address: null,
  phone: null,
  openingHours: null,
};

function listing(price: number, inStock: boolean | null): Listing {
  return {
    title: 'Apple iPhone 15 128GB Black',
    price,
    oldPrice: null,
    url: null,
    domain: 'example.kz',
    via: 'test',
    inStock,
  };
}

function rank(listings: Listing[]) {
  const result: DomainResult = {
    domain: 'example.kz',
    listings,
    failure: null,
    tookMs: 1,
    searchUrl: 'https://example.kz/search',
  };
  return rankDeals({
    results: [result],
    storesByDomain: new Map([['example.kz', [store]]]),
    query: parseQuery('iPhone 15'),
  }).deals;
}

function result(domain: string, listings: Listing[]): DomainResult {
  return {
    domain,
    listings: listings.map((row) => ({ ...row, domain })),
    failure: null,
    tookMs: 1,
    searchUrl: `https://${domain}/search`,
  };
}

test('prefers a purchasable listing over a cheaper out-of-stock variant', () => {
  const deals = rank([listing(400_000, false), listing(410_000, true)]);
  assert.equal(deals.length, 1);
  assert.equal(deals[0].listing.price, 410_000);
  assert.equal(deals[0].listing.inStock, true);
});

test('keeps the best out-of-stock listing when no alternative exists', () => {
  const deals = rank([listing(420_000, false), listing(400_000, false)]);
  assert.equal(deals.length, 1);
  assert.equal(deals[0].listing.price, 400_000);
  assert.equal(deals[0].listing.inStock, false);
});

test('never ranks an unavailable retailer above a purchasable one', () => {
  const availableStore = { ...store, id: 'node/2', name: 'Available Shop', domain: 'available.kz' };
  const unavailableStore = {
    ...store,
    id: 'node/3',
    name: 'Unavailable Shop',
    domain: 'unavailable.kz',
  };
  const deals = rankDeals({
    results: [
      result('unavailable.kz', [listing(100_000, false)]),
      result('available.kz', [listing(140_000, true)]),
    ],
    storesByDomain: new Map([
      ['unavailable.kz', [unavailableStore]],
      ['available.kz', [availableStore]],
    ]),
    query: parseQuery('iPhone 15'),
  }).deals;

  assert.equal(deals[0].store.name, 'Available Shop');
  assert.equal(deals[0].listing.inStock, true);
  assert.equal(deals[1].listing.inStock, false);
});
