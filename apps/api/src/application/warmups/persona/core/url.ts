/** Hostname of a URL, or "" if unparsable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Approximate eTLD+1 ("registrable domain"): amazon.com, bbc.co.uk. Good enough for
 * "is this link still the same site" and for counting distinct cookie domains.
 */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/^\./, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const sld = parts[parts.length - 2]!;
  const tld = parts[parts.length - 1]!;
  if (tld.length === 2 && ["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne"].includes(sld)) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

export function sameSite(a: string, b: string): boolean {
  return registrableDomain(hostOf(a) || a) === registrableDomain(hostOf(b) || b);
}

const SKIP_LINK = /\.(pdf|zip|exe|dmg|jpg|jpeg|png|gif|svg|mp4|mp3|xml|rss)(\?|$)|^(mailto|tel|javascript):|#$/i;
// QueuePilot (security audit 2026-11-19): also sign-out, orders, buy-now,
// add-to-cart, payment and subscription paths, plus action-style queries.
const SKIP_PATH =
  /\/(login|log-in|signin|sign-in|logout|log-out|logoff|signout|sign-out|signup|sign-up|register|accounts?|myaccount|my-account|cart|checkout|basket|wishlist|auth|password|oauth|sso|admin|orders?|buy-now|buynow|add-to-cart|addtocart|payment|billing|subscribe|unsubscribe)\b/i;
const SKIP_QUERY = /(^|[?&])(action|add-to-cart|addtocart|buy|logout|signout|delete|remove)=/i;

/** True for sign-in, account, cart, checkout and other action pages (pathname or action query). */
export function isAccountOrActionUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return SKIP_PATH.test(u.pathname) || SKIP_QUERY.test(u.search);
  } catch {
    return false;
  }
}

/** Links we never follow: downloads, logins, carts, account pages — browsing only, no account actions. */
export function isFollowable(href: string): boolean {
  if (!/^https?:/i.test(href)) return false;
  if (SKIP_LINK.test(href)) return false;
  try {
    new URL(href);
  } catch {
    return false;
  }
  return !isAccountOrActionUrl(href);
}

/** Params that only track where a click came from — they don't change which page you land on. */
const TRACKING_PARAM =
  /^(ref|ref_|_ref|sr|qid|th|psc|crid|sprefix|keywords|dib|dib_tag|content-id|smid|spc|linkcode|tag|asc_[a-z0-9]*|pd_rd_[a-z]*|pf_rd_[a-z]*|sp_csd|_encoding|ie|utm_[a-z]*|gclid|fbclid|msclkid|cm_[a-z]*|icid|iid|mcid|sid|epid|rank|position|source|from|clickid)$/i;

/**
 * A stable identity for a link. One product tile is often linked ten times over with
 * different `ref=`/`qid=` suffixes; keyed on the raw href those look like ten different
 * products, which both fills the link budget with duplicates and makes the picker keep
 * re-opening whichever item happens to have the most variants.
 */
export function canonicalLink(href: string): string {
  try {
    const u = new URL(href);
    const path = u.pathname
      .replace(/\/ref=[^/]*\/?$/i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAM.test(k))
      .map(([k, v]) => `${k.toLowerCase()}=${v.toLowerCase()}`)
      .sort();
    return `${u.origin.toLowerCase()}${path}${params.length ? `?${params.join("&")}` : ""}`;
  } catch {
    return href;
  }
}

/** Path segments that mean "an item": Amazon /dp/, Walmart /ip/, eBay /itm/, Nike /t/, AliExpress /item/ … */
const PRODUCT_SEGMENT = /\/(dp|gp\/product|gp\/aw\/d|itm|ip|p|pd|pdp|prod|product|products|productpage|listing|item|sku|buy|t)\//i;
/** "product" written with a dot or dash instead of slashes: Costco .product.123.html, H&M productpage.123.html, Gap product.do, CVS -prodid-123. */
const PRODUCT_DOTTED = /(^|[/.-])(productpage|prodid|product|pdp|prod)(?!-review)[.-][a-z0-9]/i;
/** The item id lives in the query: Gap ?pid=, Macy's ?ID=. */
const PRODUCT_QUERY = /[?&](pid|productid|product_id|skuid|sku|prodid|itemid|item_id|id)=(prod)?[a-z0-9][a-z0-9-]{3,}/i;
/** Listing pages — a grid of items, not an item. */
const CATALOG_SEGMENT =
  /\/(b|c|cat|category|categories|browse|shop|shops|department|departments|collection|collections|deals|sale|clearance|bestsellers|best-sellers|new-arrivals|brand|brands|catalog|catalogsearch|search|results|s|sh|se|l|w|g)(?:\/|$)/i;
/** Listing words anywhere in the path, for shapes like Best Buy's /site/searchpage.jsp. */
const CATALOG_WORD = /(search|browse|catalog|categor|department|collection|clearance|bestseller|deals)/i;
/** A bare SKU filename: adidas /HQ6351.html. Case-sensitive, and must contain a digit. */
const PRODUCT_SKU = /\/(?=[A-Z0-9]*\d)[A-Z0-9]{5,12}\.html?(?:$|[?#])/;
/** A long numeric id at the end: Best Buy /6512345.p, Zara -p12345678.html, SHEIN -p-12345678.html, slug-1234567. */
const PRODUCT_ID_TAIL = /(?:^|[/-])(?:p-?)?\d{5,}(?:\.p|\.html?|\.jsp|\.aspx)?(?:$|[/?#])/i;

/**
 * Does this URL look like a product page a shopper would open? Strong signals first, then
 * the catalog guard so a listing page never counts as an item, then the loose generic
 * shapes. It will never cover every retailer's URL grammar — `browseStore` falls back to
 * catalog links and then to any same-site link, so a miss costs quality, not the visit.
 */
export function isProductLink(href: string): boolean {
  try {
    const u = new URL(href);
    const p = u.pathname;
    if (PRODUCT_SEGMENT.test(p) || PRODUCT_DOTTED.test(p)) return true;
    if (PRODUCT_QUERY.test(u.search)) return true;
    if (CATALOG_SEGMENT.test(p)) return false;
    if (PRODUCT_SKU.test(p)) return true;
    return PRODUCT_ID_TAIL.test(p);
  } catch {
    return false;
  }
}

/**
 * A department, category or deals page — the aisles of the store. A shopper wanders into
 * these as well as opening items, and they are where the product links live when a
 * homepage has none.
 */
export function isCatalogLink(href: string): boolean {
  try {
    const p = new URL(href).pathname;
    if (isProductLink(href)) return false;
    return CATALOG_SEGMENT.test(p) || CATALOG_WORD.test(p);
  } catch {
    return false;
  }
}
