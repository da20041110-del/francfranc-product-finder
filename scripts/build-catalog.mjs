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
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "FrancfrancProductFinder/0.1 (authorized internal prototype)",
          "accept": "text/html,application/xml,application/xhtml+xml,*/*",
        },
        redirect: "follow",
      });
      if (response.ok) return await response.text();
      const error = new Error(`HTTP ${response.status} for ${url}`);
      // Retry only transient server/rate-limit responses.
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      await sleep(Math.max(retryAfter * 1000, attempt * 1500));
    } catch (error) {
      lastError = error;
      if (/HTTP 4(?!29)/.test(error.message) || attempt === 3) throw error;
      await sleep(attempt * 1500);
    }
  }
  throw lastError || new Error(`Unable to fetch ${url}`);
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
  const seen = new Set();
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    if (types.includes("Product") && !seen.has(node)) {
      seen.add(node);
      out.push(node);
    }
    if (node["@graph"]) visit(node["@graph"]);
    if (node.hasVariant) visit(node.hasVariant);
    if (node.itemListElement) visit(node.itemListElement);
  }
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1].trim())); }
    catch { /* Ignore unrelated or invalid JSON-LD blocks. */ }
  }
  return out;
}

function getMeta(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]).trim();
  }
  return "";
}

function extractVisibleItemCode(html) {
  const text = decodeHtml(html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " "));
  return text.match(/品番\s*[:：|]?\s*(\d{13})/)?.[1] || "";
}

function extractItemCode(html, product, allowVisibleCode = true) {
  const sku = String(product?.sku || product?.mpn || "");
  if (/^\d{13}$/.test(sku)) return sku;
  if (allowVisibleCode) return extractVisibleItemCode(html);
  return "";
}

function parseProducts(url, html) {
  const nodes = getJsonLdProducts(html);
  const visibleCode = nodes.length <= 1 ? extractVisibleItemCode(html) : "";
  const usableNodes = nodes.length ? nodes : [{}];
  const metaTitle = getMeta(html, "og:title") || getMeta(html, "twitter:title");
  const h1 = decodeHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, " ") || "").trim();
  const metaImage = getMeta(html, "og:image") || getMeta(html, "twitter:image");
  const metaPrice = getMeta(html, "product:price:amount");
  return usableNodes.map((p) => {
    const offers = Array.isArray(p.offers) ? p.offers[0] : (p.offers || {});
    const rawImage = Array.isArray(p.image) ? p.image[0] : p.image;
    const image = typeof rawImage === "object" ? (rawImage?.url || rawImage?.contentUrl || "") : rawImage;
    const code = extractItemCode(html, p, nodes.length <= 1);
    return {
      title: decodeHtml(String(p.name || h1 || metaTitle).replace(/\s*[|｜].*$/, "")).trim(),
      price: offers.price != null ? String(offers.price) : (metaPrice || ""),
      currency: offers.priceCurrency || "JPY",
      image: typeof image === "string" && image ? image : metaImage,
      url,
      itemCode: code || (nodes.length <= 1 ? visibleCode : ""),
      source: "Francfranc公式商品ページ",
      checkedAt: new Date().toISOString(),
      verifiedCode: /^\d{13}$/.test(code || visibleCode),
    };
  }).filter(p => p.title || p.itemCode || p.image);
}

const urls = await getProductUrls();
if (!urls.length) {
  console.error("商品サイトマップから商品URLを取得できませんでした。サイト側の公開方式を確認する必要があります。");
  process.exitCode = 1;
} else {
  const selected = urls.slice(0, limit);
  const products = [];
  const failed = [];
  const noProductData = [];
  const concurrency = 3;
  let completed = 0;
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < selected.length) {
      const url = selected[nextIndex++];
      try {
        const html = await getText(url);
        const parsed = parseProducts(url, html);
        if (parsed.length) {
          products.push(...parsed);
          console.log(`${completed + 1}/${selected.length} found: ${parsed[0].title || url} (${parsed.length} record(s))`);
        } else {
          noProductData.push({ url, reason: "no_title_code_or_image", jsonLdProducts: getJsonLdProducts(html).length });
          console.warn(`${completed + 1}/${selected.length} no product data: ${url}`);
        }
      } catch (error) {
        failed.push({ url, reason: String(error?.message || error) });
        console.warn(`${completed + 1}/${selected.length} fetch failed: ${url} (${error.message})`);
      }
      completed++;
      await sleep(1200);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()));
  const output = {
    generatedAt: new Date().toISOString(),
    source: ORIGIN,
    attempted: selected.length,
    found: products.length,
    uniqueProductPagesFound: new Set(products.map(p => p.url)).size,
    fetchFailed: failed.length,
    noProductData: noProductData.length,
    failed,
    noProductDataUrls: noProductData,
    note: "Item codes are populated only from official visible 品番 or structured 13-digit SKU. URL slugs are never used as JAN.",
    products,
  };
  await writeFile("catalog.json", JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Wrote catalog.json: ${products.length} products from ${selected.length} URLs.`);
}
