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
  const sitemap = await getText(`${ORIGIN}/sitemap.xml`);
  const sitemapUrls = xmlLocs(sitemap);
  const productSitemaps = sitemapUrls.filter((url) =>
    /sitemap.*product|product.*sitemap/i.test(url)
  );
  const candidates = productSitemaps.length ? productSitemaps : [`${ORIGIN}/sitemap_products_1.xml`];
  const productUrls = [];
  for (const url of candidates) {
    try {
      const xml = await getText(url);
      productUrls.push(...xmlLocs(xml).filter((u) => new URL(u).pathname.startsWith("/products/")));
      await sleep(500);
    } catch (error) {
      console.warn(`Sitemap not available: ${url} (${error.message})`);
    }
  }
  return [...new Set(productUrls)];
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
  return /^\d{13}$/.test(sku) ? sku : "";
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
  for (const url of selected) {
    try {
      const html = await getText(url);
      const product = parseProduct(url, html);
      if (product.title || product.itemCode) products.push(product);
      console.log(`${products.length}/${selected.length} checked: ${product.title || url}`);
    } catch (error) {
      console.warn(`Product not fetched: ${url} (${error.message})`);
    }
    await sleep(1200);
  }
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
