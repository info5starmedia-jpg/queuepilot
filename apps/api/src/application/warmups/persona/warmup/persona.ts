import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const SiteSchema = z.object({
  url: z.string().url(),
  /** search | shopping | sports | crypto | news | social | video | utility */
  category: z.string().default("general"),
  weight: z.number().positive().default(1),
  /** Queries that lead to this site via the search engine ("nike running shoes"). */
  searchTerms: z.array(z.string()).default([]),
  /** Scales the persona dwell for this site (video 3x, listing 0.7x …). */
  dwellMultiplier: z.number().positive().default(1),
  /** Max internal pages to open after landing. */
  maxHops: z.number().int().min(0).max(5).default(3),
  /**
   * The store's own search URL with `{q}` where the query goes, e.g.
   * "https://www.amazon.com/s?k={q}". Shopping visits use it to reach a grid of real
   * products (a homepage has almost none), then click into products like a shopper.
   */
  search: z.string().optional(),
});
export type Site = z.infer<typeof SiteSchema>;

export const DwellSchema = z.object({
  medianSec: z.number().positive().default(45),
  sigma: z.number().positive().default(0.8),
  minSec: z.number().positive().default(4),
  maxSec: z.number().positive().default(600),
  bounceRate: z.number().min(0).max(1).default(0.1),
});

export const PersonaSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/i),
  name: z.string(),
  description: z.string().default(""),
  /** IANA zone the persona "lives" in — should match the profile's proxy geo. */
  timezone: z.string().default("America/New_York"),
  /** Local hours the persona browses in. */
  /** `end` may be 24 for "until midnight". */
  activeHours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(1).max(24) }).default({ start: 8, end: 23 }),
  /** Campaign length. Spreading across days is the whole point. */
  days: z.number().int().min(1).max(90).default(10),
  sessionsPerDay: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).default({ min: 2, max: 4 }),
  sitesPerSession: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).default({ min: 3, max: 6 }),
  /** Chance a given day has no activity at all (people take days off). Day 0 always runs. */
  offDayChance: z.number().min(0).max(1).default(0.15),
  dwell: DwellSchema.default({}),
  /** How visits begin. Search plants query history and real referrers; direct is a typed URL. */
  entryMix: z.object({ search: z.number().min(0), direct: z.number().min(0) }).default({ search: 0.55, direct: 0.45 }),
  searchEngine: z.string().url().default("https://www.google.com/search?q="),
  /** Fraction of the site list each profile adopts as "its" sites, so profiles don't share identical lists. */
  siteAdoption: z.number().min(0.3).max(1).default(0.8),
  sites: z.array(SiteSchema).min(1),
  /** A wider pool of optional sites; each session randomly mixes in a few so no two look alike. */
  extraSites: z.array(SiteSchema).default([]),
  extrasPerSession: z.object({ min: z.number().int().min(0), max: z.number().int().min(0) }).default({ min: 0, max: 2 }),
});
export type Persona = z.infer<typeof PersonaSchema>;

/**
 * The out-of-the-box persona: search + shopping heavy, some sports, some crypto.
 * Browsing only — no logins, carts, purchases or account actions, ever.
 */
export const DEFAULT_PERSONA: Persona = PersonaSchema.parse({
  id: "us-shopper",
  name: "US shopper",
  description: "Searches Google, shops around Amazon/Walmart/eBay/Nike, checks ESPN and crypto prices.",
  timezone: "America/New_York",
  activeHours: { start: 8, end: 23 },
  days: 10,
  sessionsPerDay: { min: 2, max: 4 },
  sitesPerSession: { min: 3, max: 6 },
  sites: [
    { url: "https://www.google.com", category: "search", weight: 3, maxHops: 1, dwellMultiplier: 0.4, searchTerms: [] },
    { url: "https://www.amazon.com", category: "shopping", weight: 3, maxHops: 4, dwellMultiplier: 1.2, searchTerms: ["amazon deals today", "amazon wireless earbuds", "amazon kitchen gadgets", "amazon best sellers", "amazon mechanical keyboard"], search: "https://www.amazon.com/s?k={q}" },
    { url: "https://www.walmart.com", category: "shopping", weight: 2.5, maxHops: 4, dwellMultiplier: 1.1, searchTerms: ["walmart grocery pickup", "walmart tv deals", "walmart patio furniture", "walmart air fryer"], search: "https://www.walmart.com/search?q={q}" },
    { url: "https://www.bestbuy.com", category: "shopping", weight: 2, maxHops: 4, dwellMultiplier: 1.1, searchTerms: ["best buy laptop deals", "best buy headphones", "best buy 4k tv", "best buy graphics card"], search: "https://www.bestbuy.com/site/searchpage.jsp?st={q}" },
    { url: "https://www.target.com", category: "shopping", weight: 2, maxHops: 4, dwellMultiplier: 1.1, searchTerms: ["target home decor", "target toys sale", "target skincare", "target coffee maker"], search: "https://www.target.com/s?searchTerm={q}" },
    { url: "https://www.ebay.com", category: "shopping", weight: 2, maxHops: 4, dwellMultiplier: 1.1, searchTerms: ["ebay vintage watches", "ebay used laptops", "ebay collectible cards", "ebay sneakers"], search: "https://www.ebay.com/sch/i.html?_nkw={q}" },
    { url: "https://www.nike.com", category: "shopping", weight: 2, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["nike running shoes", "nike air max", "nike new releases"], search: "https://www.nike.com/w?q={q}" },
    { url: "https://www.espn.com", category: "sports", weight: 2, dwellMultiplier: 1.3, searchTerms: ["espn nba scores", "espn nfl schedule", "espn top plays"] },
    { url: "https://coinmarketcap.com", category: "crypto", weight: 1.5, dwellMultiplier: 1.0, searchTerms: ["bitcoin price", "ethereum price today", "crypto market cap"] },
    { url: "https://www.coingecko.com", category: "crypto", weight: 1.2, dwellMultiplier: 1.0, searchTerms: ["coingecko solana", "crypto prices coingecko"] },
    { url: "https://www.coindesk.com", category: "crypto", weight: 1.2, dwellMultiplier: 1.4, searchTerms: ["coindesk bitcoin news", "crypto news today"] },
    { url: "https://www.coinbase.com", category: "crypto", weight: 1, dwellMultiplier: 0.8, maxHops: 2, searchTerms: ["coinbase price bitcoin", "coinbase learn"] },
    { url: "https://www.kraken.com", category: "crypto", weight: 0.8, dwellMultiplier: 0.8, maxHops: 2, searchTerms: ["kraken exchange prices"] },
  ],
  // Rotated in a few at a time for variety and a broader, more natural domain footprint.
  extrasPerSession: { min: 1, max: 3 },
  extraSites: [
    // shopping
    { url: "https://www.etsy.com", category: "shopping", weight: 1.4, maxHops: 3, dwellMultiplier: 1.1, searchTerms: ["etsy handmade gifts", "etsy wall art", "etsy jewelry"], search: "https://www.etsy.com/search?q={q}" },
    { url: "https://www.homedepot.com", category: "shopping", weight: 1.4, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["home depot power tools", "home depot lighting", "home depot flooring"], search: "https://www.homedepot.com/s/{q}" },
    { url: "https://www.lowes.com", category: "shopping", weight: 1.3, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["lowes appliances", "lowes patio furniture"], search: "https://www.lowes.com/search?searchTerm={q}" },
    { url: "https://www.costco.com", category: "shopping", weight: 1.2, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["costco deals", "costco electronics"], search: "https://www.costco.com/CatalogSearch?keyword={q}" },
    { url: "https://www.macys.com", category: "shopping", weight: 1.1, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["macys shoes sale", "macys bedding"], search: "https://www.macys.com/shop/search?keyword={q}" },
    { url: "https://www.wayfair.com", category: "shopping", weight: 1.2, maxHops: 3, dwellMultiplier: 1.1, searchTerms: ["wayfair sofa", "wayfair desk"], search: "https://www.wayfair.com/keyword.php?keyword={q}" },
    { url: "https://www.kohls.com", category: "shopping", weight: 1.0, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["kohls dresses", "kohls sneakers"], search: "https://www.kohls.com/search.jsp?search={q}" },
    { url: "https://www.ikea.com", category: "shopping", weight: 1.1, maxHops: 3, dwellMultiplier: 1.1, searchTerms: ["ikea bookshelf", "ikea storage"], search: "https://www.ikea.com/us/en/search/?q={q}" },
    { url: "https://www.aliexpress.com", category: "shopping", weight: 1.0, maxHops: 3, dwellMultiplier: 1.1, searchTerms: ["aliexpress gadgets", "aliexpress phone case"], search: "https://www.aliexpress.com/wholesale?SearchText={q}" },
    // Big US retailers that run the heavy anti-bot stacks (Akamai, PerimeterX, Kasada,
    // Cloudflare) — the sites a warmed profile most needs history with. UK and other
    // country storefronts are deliberately absent: this persona lives on a US IP.
    { url: "https://www.chewy.com", category: "shopping", weight: 1.0, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["chewy dog food", "chewy cat litter", "chewy dog treats"], search: "https://www.chewy.com/s?query={q}" },
    { url: "https://www.samsclub.com", category: "shopping", weight: 1.1, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["sams club paper towels", "sams club tv", "sams club snacks"], search: "https://www.samsclub.com/s/{q}" },
    { url: "https://www.sephora.com", category: "shopping", weight: 1.1, maxHops: 3, dwellMultiplier: 1.1, searchTerms: ["sephora moisturizer", "sephora perfume", "sephora lipstick"], search: "https://www.sephora.com/search?keyword={q}" },
    { url: "https://www.ulta.com", category: "shopping", weight: 1.0, maxHops: 3, dwellMultiplier: 1.1, searchTerms: ["ulta shampoo", "ulta foundation", "ulta hair dryer"], search: "https://www.ulta.com/shop/search?q={q}" },
    { url: "https://www.walgreens.com", category: "shopping", weight: 1.0, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["walgreens vitamins", "walgreens allergy medicine", "walgreens sunscreen"], search: "https://www.walgreens.com/search/results.jsp?Ntt={q}" },
    { url: "https://www.cvs.com", category: "shopping", weight: 1.0, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["cvs cough syrup", "cvs first aid kit", "cvs razors"], search: "https://www.cvs.com/search?searchTerm={q}" },
    { url: "https://www.petco.com", category: "shopping", weight: 0.9, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["petco aquarium", "petco dog collar", "petco cat food"], search: "https://www.petco.com/shop/en/petcostore/SearchDisplay?searchTerm={q}" },
    { url: "https://www.newegg.com", category: "shopping", weight: 1.0, maxHops: 3, dwellMultiplier: 1.1, searchTerms: ["newegg ssd", "newegg motherboard", "newegg monitor"], search: "https://www.newegg.com/p/pl?d={q}" },
    { url: "https://www.overstock.com", category: "shopping", weight: 0.8, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["overstock rug", "overstock dining table"], search: "https://www.overstock.com/search?keywords={q}" },
    { url: "https://www.qvc.com", category: "shopping", weight: 0.8, maxHops: 3, dwellMultiplier: 1.1, searchTerms: ["qvc kitchen gadgets", "qvc bedding"], search: "https://www.qvc.com/catalog/search.html?keyword={q}" },
    { url: "https://www.groupon.com", category: "shopping", weight: 0.9, maxHops: 3, dwellMultiplier: 1.1, searchTerms: ["groupon spa deals", "groupon restaurant deals"], search: "https://www.groupon.com/browse/search?query={q}" },
    { url: "https://www.gap.com", category: "shopping", weight: 0.9, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["gap jeans", "gap hoodie", "gap kids"], search: "https://www.gap.com/browse/search.do?searchText={q}" },
    { url: "https://www.adidas.com", category: "shopping", weight: 1.1, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["adidas sneakers", "adidas track jacket", "adidas soccer cleats"], search: "https://www.adidas.com/us/search?q={q}" },
    { url: "https://www.lululemon.com", category: "shopping", weight: 1.0, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["lululemon leggings", "lululemon running shorts"], search: "https://shop.lululemon.com/search?Ntt={q}" },
    { url: "https://www2.hm.com", category: "shopping", weight: 1.0, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["hm dresses", "hm mens shirts"], search: "https://www2.hm.com/en_us/search-results.html?q={q}" },
    { url: "https://www.zara.com", category: "shopping", weight: 0.9, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["zara coat", "zara boots"], search: "https://www.zara.com/us/en/search?searchTerm={q}" },
    { url: "https://www.uniqlo.com", category: "shopping", weight: 0.9, maxHops: 3, dwellMultiplier: 1.0, searchTerms: ["uniqlo down jacket", "uniqlo t shirt"], search: "https://www.uniqlo.com/us/en/search?q={q}" },
    { url: "https://us.shein.com", category: "shopping", weight: 0.9, maxHops: 3, dwellMultiplier: 1.1, searchTerms: ["shein summer dress", "shein tops"], search: "https://us.shein.com/pdsearch/{q}/" },
    { url: "https://www.ssense.com", category: "shopping", weight: 0.7, maxHops: 3, dwellMultiplier: 1.1, searchTerms: ["ssense sneakers", "ssense coat"], search: "https://www.ssense.com/en-us/men?q={q}" },
    // video / entertainment
    { url: "https://www.youtube.com", category: "video", weight: 2.4, maxHops: 2, dwellMultiplier: 2.4, searchTerms: ["youtube product review", "youtube unboxing", "youtube how to"] },
    { url: "https://www.imdb.com", category: "entertainment", weight: 1.2, maxHops: 2, dwellMultiplier: 1.3, searchTerms: ["imdb top movies", "imdb new shows"] },
    { url: "https://www.rottentomatoes.com", category: "entertainment", weight: 1.0, maxHops: 2, dwellMultiplier: 1.2, searchTerms: ["rotten tomatoes best movies"] },
    { url: "https://www.twitch.tv", category: "video", weight: 0.9, maxHops: 1, dwellMultiplier: 1.6, searchTerms: ["twitch streams"] },
    // social / community
    { url: "https://www.reddit.com", category: "social", weight: 1.8, maxHops: 2, dwellMultiplier: 1.5, searchTerms: ["reddit best headphones", "reddit deals", "reddit buyitforlife"] },
    { url: "https://www.pinterest.com", category: "social", weight: 1.2, maxHops: 2, dwellMultiplier: 1.3, searchTerms: ["pinterest home ideas", "pinterest recipes"] },
    { url: "https://www.quora.com", category: "reference", weight: 1.0, maxHops: 2, dwellMultiplier: 1.3, searchTerms: ["quora best laptop", "quora travel tips"] },
    // news / finance
    { url: "https://www.cnn.com", category: "news", weight: 1.3, maxHops: 1, dwellMultiplier: 1.4, searchTerms: ["cnn news today"] },
    { url: "https://www.bbc.com", category: "news", weight: 1.3, maxHops: 2, dwellMultiplier: 1.4, searchTerms: ["bbc news", "bbc world"] },
    { url: "https://www.nytimes.com", category: "news", weight: 1.1, maxHops: 1, dwellMultiplier: 1.5, searchTerms: ["nyt news"] },
    { url: "https://www.theverge.com", category: "news", weight: 1.2, maxHops: 2, dwellMultiplier: 1.3, searchTerms: ["the verge reviews", "the verge phones"] },
    { url: "https://www.forbes.com", category: "news", weight: 1.0, maxHops: 1, dwellMultiplier: 1.3, searchTerms: ["forbes tech", "forbes markets"] },
    { url: "https://www.businessinsider.com", category: "news", weight: 1.0, maxHops: 1, dwellMultiplier: 1.3, searchTerms: ["business insider deals"] },
    { url: "https://finance.yahoo.com", category: "news", weight: 1.2, maxHops: 2, dwellMultiplier: 1.2, searchTerms: ["stock market today", "crypto news", "apple stock"] },
    // tech
    { url: "https://www.engadget.com", category: "news", weight: 1.0, maxHops: 2, dwellMultiplier: 1.3, searchTerms: ["engadget reviews"] },
    { url: "https://techcrunch.com", category: "news", weight: 0.9, maxHops: 2, dwellMultiplier: 1.3, searchTerms: ["techcrunch startups"] },
    // reference / learning
    { url: "https://en.wikipedia.org", category: "reference", weight: 1.2, maxHops: 2, dwellMultiplier: 1.3, searchTerms: ["wikipedia"] },
    { url: "https://www.medium.com", category: "reference", weight: 0.9, maxHops: 2, dwellMultiplier: 1.4, searchTerms: ["medium productivity", "medium investing"] },
    // sports
    { url: "https://www.cbssports.com", category: "sports", weight: 1.0, maxHops: 2, dwellMultiplier: 1.3, searchTerms: ["cbs sports scores"] },
    { url: "https://bleacherreport.com", category: "sports", weight: 1.0, maxHops: 2, dwellMultiplier: 1.3, searchTerms: ["bleacher report nba"] },
    // travel / food / utility / health
    { url: "https://www.tripadvisor.com", category: "travel", weight: 1.0, maxHops: 2, dwellMultiplier: 1.4, searchTerms: ["tripadvisor things to do", "tripadvisor hotels"] },
    { url: "https://www.allrecipes.com", category: "food", weight: 1.0, maxHops: 2, dwellMultiplier: 1.4, searchTerms: ["allrecipes dinner", "allrecipes chicken"] },
    { url: "https://www.weather.com", category: "utility", weight: 1.1, maxHops: 1, dwellMultiplier: 0.7, searchTerms: ["weather forecast"] },
    { url: "https://www.webmd.com", category: "reference", weight: 0.8, maxHops: 2, dwellMultiplier: 1.3, searchTerms: ["webmd cold remedies"] },
    { url: "https://www.cars.com", category: "shopping", weight: 0.9, maxHops: 3, dwellMultiplier: 1.2, searchTerms: ["cars.com used suv", "cars.com toyota"], search: "https://www.cars.com/shopping/results/?keyword={q}" },
  ],
});

/** Load personas/*.json (validated) and always include the built-in default. */
export function loadPersonas(dir: string): Persona[] {
  const out = new Map<string, Persona>([[DEFAULT_PERSONA.id, DEFAULT_PERSONA]]);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      try {
        const p = PersonaSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
        out.set(p.id, p);
      } catch (e) {
        throw new Error(`invalid persona ${f}: ${(e as Error).message}`);
      }
    }
  }
  return [...out.values()];
}
