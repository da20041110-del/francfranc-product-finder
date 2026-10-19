/**
 * Francfranc official-site catalog prototype.
 *
 * Usage:
 *   node scripts/build-catalog.mjs --limit=5
 *   node scripts/build-catalog.mjs --all
 *
 * Uses only Node.js built-ins. Start with a small test. Run at low request
 * volume and only where company permission and site access rules allow it.
 */
import { writeFile } from "node:fs/promises";

const ORIGIN = "https://francfranc.com";
const args = process.argv.slice(2);
const all = args.includes("--all");
const limitArg = args.find((x) => x.startsWith("--limit="));
const limit = all ? Infinity : Math.max(1, Number(limitArg?.split("=")[1] || 5));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "FrancfrancProductFinder/0.1 (authorized internal prototype)" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

function xmlLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) =>
    m[1].replaceAll("&amp;", "&")
  );
}

async function getProductUrls() {
  // Shopify may expose either a sitemap index or direct product URLs.
  // Walk sitemap indexes recursively so we don't silently miss product pages.
  const queue = [`${ORIGIN}/sitemap.xml`];
  const seenSitemaps = new Set();
  const productUrls = new Set();
  while (queue.length) {
    const sitemapUrl = queue.shift();
    if (seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);
    let xml;
    try {
      xml = await getText(sitemapUrl);
    } catch (error) {
      console.warn(`Sitemap not available: ${sitemapUrl} (${error.message})`);
      continue;
    }
    for (const loc of xmlLocs(xml)) {
      let parsed;
      try { parsed = new URL(loc); } catch { continue; }
      if (parsed.hostname !== new URL(ORIGIN).hostname) continue;
      if (parsed.pathname.startsWith("/products/")) {
        productUrls.add(parsed.origin + parsed.pathname);
      } else if (/sitemap/i.test(parsed.pathname) && !seenSitemaps.has(loc)) {
        queue.push(loc);
      }
    }
    await sleep(300);
  }
  return [...productUrls];
}

function decodeHtml(value = "") {
  return value
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function getJsonLdProducts(html) {
  const out = [];
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(match[1].trim());
      const entries = Array.isArray(data) ? data : [data];
      for (const entry of entries) {
        const graph = entry?.["@graph"] || [entry];
        for (const node of graph) {
          const types = Array.isArray(node?.["@type"]) ? node["@type"] : [node?.["@type"]];
          if (types.includes("Product")) out.push(node);
        }
      }
    } catch { /* Ignore unrelated or invalid JSON-LD blocks. */ }
  }
  return out;
}

function extractItemCode(html, product) {
  // Prefer the visible official page's "品番" label. Never guess from the URL.
  const text = decodeHtml(html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " "));
  const match = text.match(/品番\s*[:：|]?\s*(\d{13})/);
  if (match) return match[1];
  const sku = String(product?.sku || "");
  if (/^\d{13}$/.test(sku)) return sku;
  // Fallback for official product pages whose structured data omits the code.
  const slugCode = String(url).match(/\/products\/(\d{13})(?:[/?#]|$)/)?.[1] || "";
  return /^\d{13}$/.test(slugCode) ? slugCode : "";
}

function parseProduct(url, html) {
  const nodes = getJsonLdProducts(html);
  const p = nodes.find((x) => x.name && (x.image || x.offers)) || nodes[0] || {};
  const offers = Array.isArray(p.offers) ? p.offers[0] : (p.offers || {});
  const image = Array.isArray(p.image) ? p.image[0] : (typeof p.image === "object" ? p.image?.url : p.image);
  const code = extractItemCode(html, p);
  return {
    title: decodeHtml(String(p.name || "")).trim(),
    price: offers.price != null ? String(offers.price) : "",
    currency: offers.priceCurrency || "JPY",
    image: typeof image === "string" ? image : "",
    url,
    itemCode: code,
    source: "Francfranc公式商品ページ",
    checkedAt: new Date().toISOString(),
    verifiedCode: /^\d{13}$/.test(code),
  };
}

const urls = await getProductUrls();
if (!urls.length) {
  console.error("商品サイトマップから商品URLを取得できませんでした。サイト側の公開方式を確認する必要があります。");
  process.exitCode = 1;
} else {
  const selected = urls.slice(0, limit);
  const products = [];
  // A small fixed worker pool keeps the full catalog refresh practical without
  // sending a burst of requests to the official site.
  const concurrency = 3;
  let completed = 0;
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < selected.length) {
      const index = nextIndex++;
      const url = selected[index];
      try {
        const html = await getText(url);
        const product = parseProduct(url, html);
        if (product.title || product.itemCode) products.push(product);
        completed++;
        console.log(`${completed}/${selected.length} checked: ${product.title || url}`);
      } catch (error) {
        completed++;
        console.warn(`${completed}/${selected.length} failed: ${url} (${error.message})`);
      }
      // Per-worker delay limits request frequency while allowing a large catalog
      // to finish within the workflow time budget.
      await sleep(1200);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, selected.length) },
    () => worker()
  ));
  const output = {
    generatedAt: new Date().toISOString(),
    source: ORIGIN,
    attempted: selected.length,
    found: products.length,
    note: "Prototype catalog. Verify official item code and price before operational use.",
    products,
  };
  await writeFile("catalog.json", JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Wrote catalog.json: ${products.length} products from ${selected.length} URLs.`);
}
