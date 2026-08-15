import type { Listing, MatchResult, ProductCategory, ProductQuery } from './types';

/**
 * Turning "iphone 15 pro 256" into something we can match against retailer
 * listings, and — more importantly — throwing out the junk.
 *
 * Searching any KZ retailer for "iphone" returns phone cases, screen protectors
 * and car chargers long before it returns a phone. Live probes confirmed this:
 * tgrad.kz's top hits for "iphone" were a universal holder (16 990 ₸) and an
 * Inkax car charger (1 295 ₸). Rank on sticker price alone and the "best deal"
 * is always a 690 ₸ cable. Everything below exists to stop that.
 */

// ---------------------------------------------------------------------------
// Unicode-safe word matching
// ---------------------------------------------------------------------------

/**
 * JavaScript's `\b` is defined against [A-Za-z0-9_], so `/\b(чехол)\b/` never
 * matches a Cyrillic title — the boundary assertions fail on both sides. Every
 * Russian keyword rule here would silently do nothing. These lookarounds are the
 * Unicode equivalent and must be used instead of `\b` for any non-ASCII term.
 */
const NOT_BEFORE = '(?<![\\p{L}\\p{N}])';
const NOT_AFTER = '(?![\\p{L}\\p{N}])';

/**
 * Build a matcher. Sources are stems by default (so "чехл" also matches
 * "чехлы"); append `END` inside a source to demand a whole word.
 */
const END = NOT_AFTER;

function term(source: string): RegExp {
  return new RegExp(`${NOT_BEFORE}(?:${source})`, 'iu');
}

/** Whole-word test for a single token, used for model identifiers. */
function hasWord(haystack: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${NOT_BEFORE}${escaped}${NOT_AFTER}`, 'iu').test(haystack);
}

// ---------------------------------------------------------------------------
// Category detection
// ---------------------------------------------------------------------------

const CATEGORY_HINTS: Array<[ProductCategory, RegExp]> = [
  // Note `\d+` rather than `\d`: `galaxy a\d` followed by a boundary never
  // matches "galaxy a17", which silently demoted every two-digit Samsung to the
  // "other" category and its much lower price floor.
  [
    'smartphone',
    term(
      'iphone|galaxy [as]\\d+|galaxy note|galaxy z |samsung [as]\\d+|pixel \\d|xiaomi \\d+|oneplus \\d+|realme \\d+|vivo [vx]?\\d+|oppo (?:reno )?\\d+|honor (?:magic )?\\d+|motorola (?:edge )?\\d+|nothing phone|redmi|poco|smartphone|phone' +
        END +
        '|смартфон|телефон'
    ),
  ],
  [
    'laptop',
    term(
      'macbook|laptop|notebook|ноутбук|thinkpad|ideapad|vivobook|zenbook|omen|victus|nitro|aspire|latitude|inspiron|pavilion|elitebook|probook'
    ),
  ],
  ['tablet', term('ipad|tablet|планшет|galaxy tab')],
  ['tv', term('телевизор|smart tv|oled|qled|tv' + END)],
  [
    'headphones',
    term(
      'airpods|headphones|наушник|earbuds|galaxy buds|freebuds|гарнитур|wh-1000|quietcomfort'
    ),
  ],
  [
    'smartwatch',
    term('apple watch|smartwatch|смарт.?час|galaxy watch|amazfit|mi band|фитнес.?браслет')
  ],
  ['monitor', term('monitor|монитор')],
  ['console', term('playstation|ps5|ps4|xbox|nintendo|switch|консоль|приставк')],
  [
    'camera',
    term('фотоаппарат|dslr|mirrorless|gopro|canon eos|nikon z|sony alpha|камер'),
  ],
  [
    'component',
    term(
      'rtx|gtx|radeon|ryzen|core i\\d|ssd|nvme|видеокарт|процессор|материнск|оперативн|ddr[45]|ram' +
        END +
        '|hdd' +
        END +
        '|storage' +
        END
    ),
  ],
];

export function detectCategory(text: string): ProductCategory | null {
  const normalised = normaliseProductText(text);
  for (const [category, pattern] of CATEGORY_HINTS) {
    if (pattern.test(normalised)) return category;
  }
  return null;
}

/**
 * Plausible floor price in KZT for a *new* item of each category.
 *
 * This single heuristic removes most accessory noise: nothing that is genuinely
 * an iPhone sells for 3 000 ₸, so anything under the smartphone floor is a case,
 * a cable, or a listing for a spare part.
 */
const PRICE_FLOOR: Record<ProductCategory, number> = {
  smartphone: 35_000,
  laptop: 120_000,
  tablet: 45_000,
  tv: 60_000,
  headphones: 8_000,
  smartwatch: 15_000,
  monitor: 40_000,
  console: 90_000,
  camera: 70_000,
  component: 15_000,
  other: 5_000,
};

/** Ceilings catch bundle/lot listings ("10x iPhone wholesale"). */
const PRICE_CEILING: Record<ProductCategory, number> = {
  smartphone: 2_500_000,
  laptop: 8_000_000,
  tablet: 2_500_000,
  tv: 15_000_000,
  headphones: 800_000,
  smartwatch: 900_000,
  monitor: 3_500_000,
  console: 1_500_000,
  camera: 8_000_000,
  component: 4_000_000,
  other: 20_000_000,
};

/** When the shopper actually wants an accessory, prices start very low. */
const ACCESSORY_FLOOR = 300;

// ---------------------------------------------------------------------------
// Accessory rejection
// ---------------------------------------------------------------------------

interface KeywordRule {
  re: RegExp;
  label: string;
  /** Matches the same idea in the user's own query. */
  inQuery: RegExp;
}

/**
 * Words meaning "this is an add-on for the thing you asked about, not the thing
 * itself". Russian first — that is what KZ retailers list in.
 */
const ACCESSORY_TERMS: KeywordRule[] = [
  {
    label: 'case',
    re: term('чехол|чехл|бампер|накладк|книжк|флип|кейс|case' + END),
    inQuery: term('чехол|чехл|case' + END + '|кейс|бампер|накладк'),
  },
  {
    label: 'screen protector',
    re: term('защитн\\w*\\s+стекл|стекло|стёкл|пленк|плёнк|бронестекл|protector'),
    inQuery: term('стекл|стёкл|пленк|плёнк|protector|защитн'),
  },
  {
    label: 'cable/adapter',
    re: term('кабел|шнур|провод|cable|переходник|адаптер|adapter|хаб' + END),
    inQuery: term('кабел|шнур|cable|адаптер|adapter|переходник|хаб' + END),
  },
  {
    label: 'charger',
    re: term('азу' + END + '|сзу' + END + '|зарядн|зарядк|charger|блок питания|power ?adapter|ac adapter|адаптер питания|power ?bank|повербанк|внешний аккумулятор'),
    inQuery: term('зарядн|зарядк|charger|азу' + END + '|сзу' + END + '|power ?bank|повербанк'),
  },
  {
    label: 'holder/stand',
    re: term('держател|holder|подставк|крепл|штатив|tripod|mount' + END),
    inQuery: term('держател|holder|подставк|крепл|штатив|tripod'),
  },
  {
    label: 'strap',
    re: term('ремешок|ремешк|strap'),
    inQuery: term('ремешок|ремешк|strap|браслет'),
  },
  {
    label: 'bag',
    re: term('сумк|рюкзак'),
    inQuery: term('сумк|рюкзак|bag' + END),
  },
  {
    label: 'stylus',
    re: term('стилус|stylus'),
    inQuery: term('стилус|stylus'),
  },
  {
    label: 'memory card',
    re: term('карта памяти|карты памяти|memory card|microsd|флешк|флеш.?накопит'),
    inQuery: term('карт\\w* памяти|memory card|microsd|флешк'),
  },
  {
    label: 'spare part',
    re: term('запчаст|дисплей в сборе|тачскрин|шлейф|аккумулятор для|батаре\\w* для'),
    inQuery: term('запчаст|тачскрин|шлейф|аккумулятор|дисплей'),
  },
  {
    label: 'sticker',
    re: term('наклейк|скин' + END),
    inQuery: term('наклейк|скин' + END),
  },
  {
    label: 'service',
    re: term('страховк|подписк|сертификат|услуг|установк|настройк'),
    inQuery: term('страховк|подписк|сертификат|услуг'),
  },
];

/** Signals the listing is not a new retail unit. */
const CONDITION_TERMS: KeywordRule[] = [
  {
    label: 'used/refurbished',
    // "(б/у)" has no ASCII boundary anywhere near it — this is exactly the case
    // the Unicode lookarounds exist for.
    re: term('б\\s?\\/\\s?у' + END + '|бу' + END + '|уценк|восстановлен|refurbish|renewed|pre[ -]?owned|second[ -]?hand|used' + END + '|витринн|open ?box'),
    inQuery: term('б\\s?\\/\\s?у' + END + '|уценк|восстановлен|refurbish|renewed|pre[ -]?owned|second[ -]?hand|used' + END + '|витринн|open ?box'),
  },
  {
    label: 'replica',
    re: term('копия|копи' + END + '|реплика|replica|counterfeit|fake' + END + '|copy' + END),
    inQuery: term('копия|реплика|replica|counterfeit|fake' + END + '|copy' + END),
  },
];

// ---------------------------------------------------------------------------
// Query normalisation
// ---------------------------------------------------------------------------

const BRANDS = [
  'apple', 'samsung', 'xiaomi', 'redmi', 'poco', 'huawei', 'honor', 'realme',
  'oppo', 'vivo', 'oneplus', 'google', 'nothing', 'motorola', 'nokia',
  'asus', 'acer', 'lenovo', 'hp', 'dell', 'msi', 'gigabyte', 'lg', 'sony',
  'philips', 'panasonic', 'toshiba', 'bosch', 'jbl', 'anker', 'logitech',
  'canon', 'nikon', 'gopro', 'dji', 'intel', 'amd', 'nvidia', 'kingston',
  'seagate', 'crucial', 'tcl', 'hisense', 'haier', 'beko', 'artel',
];

/** Words that carry no matching signal. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'new', 'buy', 'for', 'with', 'and', 'or', 'in', 'gb', 'tb',
  'cheap', 'cheapest', 'price', 'near', 'nearby', 'me', 'closest', 'best', 'find',
  'looking', 'want', 'please', 'around', 'available',
  'купить', 'новый', 'для', 'с', 'и', 'в', 'гб', 'тб', 'цена', 'недорого',
  'дешевый', 'дешёвый', 'дешево', 'дёшево', 'самый', 'рядом', 'поблизости',
  'ближайший', 'лучший', 'найти', 'ищу', 'хочу', 'пожалуйста', 'доступен',
]);

/** Common Russian retail spellings and Cyrillic lookalikes in model IDs. */
export function normaliseProductText(text: string): string {
  return text
    .replace(/айфон/giu, 'iphone')
    .replace(/айпад/giu, 'ipad')
    .replace(/макбук/giu, 'macbook')
    .replace(/самсунг/giu, 'samsung')
    .replace(/галакси/giu, 'galaxy')
    .replace(/плейстейшн/giu, 'playstation')
    // The characters look identical in many fonts but are different Unicode.
    .replace(/(?<![\p{L}\p{N}])а(?=\d)/giu, 'a')
    .replace(/(?<![\p{L}\p{N}])с(?=\d)/giu, 's')
    .replace(/(?<![\p{L}\p{N}])м(?=\d)/giu, 'm');
}

const VARIANT_SOURCE =
  'pro|max|ultra|plus|mini|air|fe|lite|slim|oled|fold|flip|se';

function tokenize(text: string): string[] {
  return normaliseProductText(text)
    .toLowerCase()
    // Retailers freely alternate between "S24+" and "S24 Plus". Normalise
    // the symbol before punctuation is stripped so both spellings match.
    .replace(/([\p{L}\p{N}])\+/gu, '$1 plus ')
    // Shops alternate between `S24Ultra` and `S24 Ultra`.
    .replace(
      new RegExp(`(\\d)(${VARIANT_SOURCE})(?![\\p{L}])`, 'giu'),
      '$1 $2 '
    )
    .replace(
      new RegExp(`(?<![\\p{L}])(${VARIANT_SOURCE})(\\d)`, 'giu'),
      '$1 $2 '
    )
    .replace(/(\d+)(?:st|nd|rd|th)(?![\p{L}])/giu, '$1')
    .replace(/[^\p{L}\p{N}+]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

interface Capacities {
  storageGb: number | null;
  ramGb: number | null;
}

interface CapacityMention {
  valueGb: number;
  index: number;
  end: number;
  unit: 'gb' | 'tb';
}

const RAM_VALUE_SOURCE =
  '(?:2|3|4|6|8|12|16|18|24|32|36|40|48|64|72|96|128|192|256)';
const BARE_STORAGE_SOURCE = '(?:64|128|256|512|1024|2048)';

function categoryUsesBareStorage(category: ProductCategory | null): boolean {
  return category === 'smartphone' || category === 'tablet' || category === 'laptop';
}

function categoryUsesMemoryCombo(category: ProductCategory | null): boolean {
  return categoryUsesBareStorage(category) || category === 'component';
}

/**
 * `iPhone 12/128` means model/storage, while `Galaxy S24 12/256` means
 * RAM/storage. Protect numeric phone-family models by making their storage unit
 * explicit before the generic memory-combo rule runs.
 */
function normaliseModelStorageSlash(raw: string): string {
  const family =
    '(?:iphone|ipad|(?:google\\s+)?pixel|redmi(?:\\s+note)?|xiaomi|oneplus|realme|vivo|honor(?:\\s+magic)?)';
  return raw.replace(
    new RegExp(
      `((?:${family})\\s+\\d{1,2}(?:\\s+(?:${VARIANT_SOURCE})){0,2})\\s*\\/\\s*(${BARE_STORAGE_SOURCE})\\s*(?:gb|гб)?(?![\\p{L}\\p{N}])`,
      'giu'
    ),
    '$1 $2GB'
  );
}

/**
 * Read RAM and storage together instead of letting two independent regexes both
 * claim the first capacity in a title. Retailers commonly write variants as
 * `16GB 512GB`, `16/512GB`, or `16 GB RAM / 1 TB SSD`.
 */
function extractCapacities(
  raw: string,
  category: ProductCategory | null = null
): Capacities {
  raw = normaliseModelStorageSlash(raw);
  const combo = categoryUsesMemoryCombo(category)
    ? raw.match(
        new RegExp(
          `(?<![\\p{L}\\p{N}])(${RAM_VALUE_SOURCE})\\s*\\/\\s*(\\d{2,4})\\s*(?:gb|гб)?(?![\\p{L}\\p{N}])`,
          'iu'
        )
      )
    : null;
  if (combo) {
    return {
      ramGb: parseInt(combo[1], 10),
      storageGb: parseInt(combo[2], 10),
    };
  }

  const mentions: CapacityMention[] = [];
  const capacityRe = /(\d+(?:[.,]\d+)?)\s*(tb|тб|gb|гб)(?![\p{L}\p{N}])/giu;
  let match: RegExpExecArray | null;
  while ((match = capacityRe.exec(raw))) {
    const unit = /tb|тб/i.test(match[2]) ? 'tb' : 'gb';
    const numeric = parseFloat(match[1].replace(',', '.'));
    const valueGb = unit === 'tb' ? Math.round(numeric * 1024) : Math.round(numeric);
    if (valueGb > 0 && valueGb <= 16_384) {
      mentions.push({ valueGb, index: match.index, end: match.index + match[0].length, unit });
    }
  }

  let ramGb: number | null = null;
  let storageGb: number | null = null;
  const unclassified: CapacityMention[] = [];

  for (const mention of mentions) {
    const before = raw.slice(Math.max(0, mention.index - 28), mention.index);
    const after = raw.slice(mention.end, mention.end + 28);
    const ramBefore = /(?:ram|озу|оперативн\w*)\s*$/iu.test(before);
    const ramAfter = /^\s*(?:ram|озу|оперативн|ddr[345])/iu.test(after);
    const storageBefore = /(?:ssd|hdd|storage|накопител\w*|встроен\w*\s+памят\w*)\s*$/iu.test(
      before
    );
    const storageAfter = /^\s*(?:ssd|hdd|storage|накопител|встроен\w*\s+памят)/iu.test(
      after
    );

    if (mention.unit === 'tb' || storageBefore || storageAfter) {
      storageGb ??= mention.valueGb;
    } else if (ramBefore || ramAfter) {
      ramGb ??= mention.valueGb;
    } else {
      unclassified.push(mention);
    }
  }

  // With two unlabeled capacities, shops conventionally put RAM first and the
  // larger storage value second: `8GB 256GB`, `16 GB / 512 GB`.
  if (unclassified.length >= 2) {
    const values = unclassified.map((m) => m.valueGb);
    const largest = Math.max(...values);
    storageGb ??= largest;
    const ramCandidate = unclassified.find(
      (m) => m.valueGb !== largest && m.valueGb <= 128
    );
    ramGb ??= ramCandidate?.valueGb ?? null;
  } else if (unclassified.length === 1) {
    const value = unclassified[0].valueGb;
    // A lone small capacity on a laptop query is almost always RAM. On phones
    // and tablets the same number can legitimately be storage.
    if (category === 'laptop' && value <= 64) ramGb ??= value;
    else storageGb ??= value;
  }

  if (storageGb === null && categoryUsesBareStorage(category)) {
    // Bare storage-looking numbers are useful in queries such as
    // `iPhone 15 256`; model identifiers remain intact because only canonical
    // capacity values qualify.
    const bare = raw.match(
      new RegExp(
        `(?<![\\p{L}\\p{N}])(${BARE_STORAGE_SOURCE})(?![\\p{L}\\p{N}])`,
        'u'
      )
    );
    if (bare) storageGb = parseInt(bare[1], 10);
  }

  return { storageGb, ramGb };
}

/** Is the shopper asking for the accessory itself rather than the device? */
function detectAccessoryQuery(raw: string): string | null {
  for (const rule of ACCESSORY_TERMS) {
    if (rule.inQuery.test(raw)) return rule.label;
  }
  return null;
}

/** Capacity tokens are handled by the storage rule, not by token matching. */
const CAPACITY_TOKEN = /^\d+(?:gb|гб|tb|тб)$/i;

/** Remove variant capacities without leaving decimal fragments as model IDs. */
function stripCapacityExpressions(
  raw: string,
  category: ProductCategory | null
): string {
  let cleaned = normaliseModelStorageSlash(raw)
    .replace(
      new RegExp(
        `(?<![\\p{L}\\p{N}])${RAM_VALUE_SOURCE}\\s*\\/\\s*\\d{2,4}\\s*(?:gb|гб)?(?![\\p{L}\\p{N}])`,
        'giu'
      ),
      ' '
    )
    .replace(/\d+(?:[.,]\d+)?\s*(?:gb|гб|tb|тб)(?![\p{L}\p{N}])/giu, ' ');

  if (categoryUsesBareStorage(category)) {
    cleaned = cleaned.replace(
      new RegExp(
        `(?<![\\p{L}\\p{N}])${BARE_STORAGE_SOURCE}(?![\\p{L}\\p{N}])`,
        'gu'
      ),
      ' '
    );
  }
  return cleaned;
}

/**
 * Parse free text into a structured query using rules only.
 * `enrichQuery` in llm.ts can refine this when an OpenRouter key is present.
 */
export function parseQuery(raw: string): ProductQuery {
  const trimmed = raw.trim();
  const normalised = normaliseProductText(trimmed);
  const lower = normalised.toLowerCase();
  const accessoryLabel = detectAccessoryQuery(trimmed);

  // An accessory query ("чехол для iphone 15") is not a smartphone purchase,
  // so it must not inherit the smartphone price floor.
  const category = accessoryLabel ? 'other' : detectCategory(normalised);
  const tokens = tokenize(stripCapacityExpressions(normalised, category));
  const { storageGb, ramGb } = extractCapacities(normalised, category);
  const explicitBrand = BRANDS.find((b) => hasWord(lower, b));
  const inferredBrand = term('iphone|ipad|macbook|airpods|apple watch').test(lower)
    ? 'apple'
    : term('galaxy').test(lower)
      ? 'samsung'
      : null;
  const brand = explicitBrand ?? inferredBrand;

  const requiredTokens = tokens.filter((t) => {
    if (CAPACITY_TOKEN.test(t)) return false;
    if (category !== 'component' && /^(?:ram|озу|ssd|hdd|storage)$/iu.test(t)) {
      return false;
    }
    // Very long digit runs are SKUs, not something to match on.
    if (/^\d+$/.test(t) && t.length > 4) return false;
    return true;
  });

  return {
    raw: trimmed,
    searchTerm: buildSearchTerm(normalised, category),
    brand,
    model: requiredTokens.join(' ') || null,
    storageGb,
    ramGb,
    category,
    requiredTokens,
    accessoryLabel,
    via: 'rules',
  };
}

/**
 * What we actually type into the retailer's search box. Retailer search engines
 * do badly with capacity qualifiers, so we drop them and filter afterwards.
 */
function buildSearchTerm(raw: string, category: ProductCategory | null): string {
  let search = stripCapacityExpressions(raw, category);

  if (category !== 'component') {
    search = search.replace(
      /(?<![\p{L}\p{N}])(?:ram|озу|ssd|hdd|storage)(?![\p{L}\p{N}])/giu,
      ' '
    );
  }

  // Sending conversational filler to brittle retailer search boxes sharply
  // reduces recall. Tokenisation retains the actual product identity.
  return tokenize(search).join(' ');
}

// ---------------------------------------------------------------------------
// Listing matching
// ---------------------------------------------------------------------------

const REJECT: (reason: string) => MatchResult = (reason) => ({
  confidence: 0,
  rejected: true,
  rejectReason: reason,
});

const VARIANT_TOKENS = new Set(VARIANT_SOURCE.split('|'));

function brandFamily(brand: string): string {
  return brand === 'redmi' || brand === 'poco' ? 'xiaomi' : brand;
}

function brandsIn(text: string): Set<string> {
  const lower = normaliseProductText(text).toLowerCase();
  const found = new Set(
    BRANDS.filter((brand) => hasWord(lower, brand)).map(brandFamily)
  );
  // Infer a family from a product line only when the title does not explicitly
  // name another maker. `Xiaomi Galaxy S24` must not become "Samsung" merely
  // because a misleading marketplace seller used the word Galaxy.
  if (found.size === 0) {
    if (term('iphone|ipad|macbook|airpods|apple watch').test(lower)) found.add('apple');
    if (term('galaxy').test(lower)) found.add('samsung');
  }
  return found;
}

/** Exact alphanumeric units plus adjacent-token forms (`Fold 5` -> `fold5`). */
function tokenSignatures(tokens: string[]): Set<string> {
  const signatures = new Set(tokens);
  for (let i = 0; i < tokens.length - 1; i++) {
    signatures.add(tokens[i] + tokens[i + 1]);
    if (i < tokens.length - 2) {
      signatures.add(tokens[i] + tokens[i + 1] + tokens[i + 2]);
    }
  }
  return signatures;
}

function requiredTokenGroups(tokens: string[]): string[][] {
  const groups: string[][] = tokens.map((token) => [token]);
  for (let i = 1; i < tokens.length; i++) {
    if (/\d/.test(tokens[i])) groups[i].push(tokens[i - 1] + tokens[i]);
  }
  return groups;
}

function hasVariant(titleTokens: string[], variant: string): boolean {
  if (titleTokens.includes(variant)) return true;
  // Concatenated variants are accepted only when attached to a model number,
  // avoiding accidental matches such as `GoPro` for the `Pro` variant.
  return titleTokens.some((token) =>
    new RegExp(`(?:\\d${variant}$|^${variant}\\d)`, 'iu').test(token)
  );
}

function includedAccessory(
  title: string,
  rule: KeywordRule,
  query: ProductQuery
): boolean {
  if (!['charger', 'cable/adapter'].includes(rule.label)) return false;
  if (!/(?:в\s+комплекте|комплектуется|прилагается|included|comes?\s+with|bundled)/iu.test(title)) {
    return false;
  }
  const accessoryIndex = title.search(rule.re);
  if (accessoryIndex <= 0) return false;
  const before = title.slice(0, accessoryIndex);
  return query.requiredTokens.some((token) => hasWord(before, token));
}

/**
 * Decide whether a scraped listing really is the product the user asked for,
 * and how confident we are.
 */
export function matchListing(listing: Listing, query: ProductQuery): MatchResult {
  const title = listing.title.trim();
  if (title.length < 3) return REJECT('title too short');

  const lowerTitle = normaliseProductText(title).toLowerCase();
  const category = query.category ?? 'other';
  const wantsAccessory = query.accessoryLabel !== null;

  // 1. Accessory / condition rejection ------------------------------------
  if (!wantsAccessory) {
    for (const rule of ACCESSORY_TERMS) {
      if (rule.re.test(lowerTitle) && !includedAccessory(lowerTitle, rule, query)) {
        return REJECT(`accessory: ${rule.label}`);
      }
    }
  } else {
    const requested = ACCESSORY_TERMS.find(
      (rule) => rule.label === query.accessoryLabel
    );
    if (requested && !requested.re.test(lowerTitle)) {
      return REJECT(`not the requested ${requested.label}`);
    }
  }
  for (const rule of CONDITION_TERMS) {
    if (rule.re.test(lowerTitle) && !rule.inQuery.test(query.raw)) {
      return REJECT(rule.label);
    }
  }

  if (query.brand && category !== 'component') {
    const expected = brandFamily(query.brand);
    const listingBrands = brandsIn(lowerTitle);
    if (listingBrands.size > 0 && !listingBrands.has(expected)) {
      return REJECT(`wrong brand (wanted ${query.brand})`);
    }
  } else if (query.brand && category === 'component') {
    const expected = brandFamily(query.brand);
    const componentFamilies = new Set(['nvidia', 'amd', 'intel']);
    if (componentFamilies.has(expected)) {
      const conflicting = [...brandsIn(lowerTitle)].some(
        (brand) => componentFamilies.has(brand) && brand !== expected
      );
      if (conflicting) return REJECT(`wrong component family (wanted ${query.brand})`);
    }
  }

  // 2. Price sanity --------------------------------------------------------
  const floor = wantsAccessory ? ACCESSORY_FLOOR : PRICE_FLOOR[category];
  if (listing.price < floor) return REJECT(`price below ${category} floor`);
  if (listing.price > PRICE_CEILING[category]) {
    return REJECT(`price above ${category} ceiling`);
  }

  // 3. Model identifiers ---------------------------------------------------
  // Tokens carrying a digit ("15", "a17", "s24", "m3") are what actually
  // distinguish one model from another, so they are mandatory rather than
  // merely counted. Without this, "Samsung Galaxy A17" matched "Samsung Galaxy
  // Buds" on the two generic tokens alone.
  const titleTokensArray = tokenize(title);
  const titleSignatures = tokenSignatures(titleTokensArray);
  const queryGroups = requiredTokenGroups(query.requiredTokens);
  for (let i = 0; i < query.requiredTokens.length; i++) {
    const id = query.requiredTokens[i];
    if (/\d/.test(id) && !queryGroups[i].some((signature) => titleSignatures.has(signature))) {
      return REJECT(`missing model identifier "${id}"`);
    }
  }

  for (const variant of query.requiredTokens.filter((token) => VARIANT_TOKENS.has(token))) {
    if (!hasVariant(titleTokensArray, variant)) {
      return REJECT(`missing variant "${variant}"`);
    }
  }

  if (category === 'smartphone' && query.requiredTokens.some((token) => /\d/.test(token))) {
    const requestedVariants = new Set(
      query.requiredTokens.filter((token) => VARIANT_TOKENS.has(token))
    );
    const strictPhoneVariants = new Set([
      'pro',
      'max',
      'ultra',
      'plus',
      'mini',
      'fe',
      'lite',
      'fold',
      'flip',
      'se',
    ]);
    const unexpected = titleTokensArray.find(
      (token) => strictPhoneVariants.has(token) && !requestedVariants.has(token)
    );
    if (unexpected) return REJECT(`unexpected variant "${unexpected}"`);
  }

  // 4. Token coverage ------------------------------------------------------
  const titleTokens = new Set(titleTokensArray);
  const required = query.requiredTokens;

  if (required.length === 0) {
    return { confidence: 0.4, rejected: false, rejectReason: null };
  }

  const exactGroupHits = new Set<number>();
  for (let i = 1; i < required.length; i++) {
    if (titleSignatures.has(required[i - 1] + required[i])) {
      exactGroupHits.add(i - 1);
      exactGroupHits.add(i);
    }
  }

  let hits = 0;
  for (let i = 0; i < required.length; i++) {
    const token = required[i];
    if (exactGroupHits.has(i)) {
      hits++;
      continue;
    }
    if (titleSignatures.has(token)) {
      hits++;
      continue;
    }
    if (titleTokens.has(token)) {
      hits++;
      continue;
    }
    // Allow prefix matches so "galaxy" matches concatenated variants.
    for (const t of titleTokens) {
      if ((t.startsWith(token) || token.startsWith(t)) && Math.min(t.length, token.length) >= 4) {
        hits += 0.75;
        break;
      }
    }
  }

  const coverage = hits / required.length;
  // Requiring every token is too strict (retailers pad titles); two-thirds works.
  if (coverage < 0.66) return REJECT('title does not match query');

  // 5. Capacity discipline -------------------------------------------------
  let confidence = 0.5 + 0.4 * coverage;

  if (query.storageGb !== null) {
    const titleStorage = extractCapacities(title, query.category).storageGb;
    if (titleStorage !== null) {
      if (titleStorage === query.storageGb) confidence = Math.min(1, confidence + 0.1);
      else return REJECT(`wrong storage (${titleStorage}GB, wanted ${query.storageGb}GB)`);
    } else {
      // Storage unstated — plausible but less certain.
      confidence -= 0.1;
    }
  }

  if (query.ramGb !== null) {
    const titleRam = extractCapacities(title, query.category).ramGb;
    if (titleRam !== null) {
      if (titleRam === query.ramGb) confidence = Math.min(1, confidence + 0.05);
      else return REJECT(`wrong RAM (${titleRam}GB, wanted ${query.ramGb}GB)`);
    } else {
      // RAM unstated — keep the listing visible, but below an exact variant.
      confidence -= 0.08;
    }
  }

  if (query.brand && !brandsIn(lowerTitle).has(brandFamily(query.brand))) confidence -= 0.08;

  return {
    confidence: Math.max(0, Math.min(1, confidence)),
    rejected: false,
    rejectReason: null,
  };
}

export { PRICE_FLOOR, PRICE_CEILING, ACCESSORY_FLOOR };
