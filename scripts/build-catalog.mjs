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

function extractVisibleItemCodes(html) {
  const text = decodeHtml(html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " "));
  return [...new Set([...text.matchAll(/品番\s*[:：|]?\s*(\d{13})/g)].map((m) => m[1]))];
}
function extractVisibleItemCode(html) {
  const candidates = extractVisibleItemCodes(html);
  return candidates.length === 1 ? candidates[0] : "";
}
function hasValidEan13CheckDigit(code) {
  if (!/^\d{13}$/.test(String(code || ""))) return false;
  const digits = String(code).split("").map(Number);
  const sum = digits.slice(0, 12).reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === digits[12];
}

function extractItemCode(html) {
  // The user-confirmed source of truth is the single 13-digit 品番 visibly
  // displayed on the official product page. Do not substitute the URL slug.
  return extractVisibleItemCode(html);
}

function diagnoseCodeMismatch(url, html, product) {
  const urlCode = url.match(/\/products\/(\d{13})(?:$|[/?#])/i)?.[1] || "";
  const code = product?.detectedItemCode || "";
  const occurrences = [];
  const patterns = [/品番/g, /\b\d{13}\b/g];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const start = Math.max(0, match.index - 220);
      const end = Math.min(html.length, match.index + match[0].length + 220);
      occurrences.push({
        kind: pattern.source === "品番" ? "label_context" : "13_digit_context",
        matched: match[0],
        snippet: html.slice(start, end).replace(/\s+/g, " ").slice(0, 480),
      });
      if (occurrences.length >= 12) break;
    }
    if (occurrences.length >= 12) break;
  }
  const structured = getJsonLdProducts(html).slice(0, 8).map((node) => ({
    name: node.name || "",
    sku: node.sku || "",
    mpn: node.mpn || "",
    productID: node.productID || "",
    description: String(node.description || "").slice(0, 500),
  }));
  return {
    url,
    urlItemCode: urlCode,
    detectedItemCode: code,
    title: product?.title || "",
    itemCodeSource: product?.itemCodeSource || "",
    htmlLength: html.length,
    occurrences,
    structured,
  };
}

function parseProducts(url, html) {
  const nodes = getJsonLdProducts(html);
  const visibleCodeCandidates = extractVisibleItemCodes(html);
  const visibleCodeAmbiguous = visibleCodeCandidates.length > 1;
  const visibleCode = !visibleCodeAmbiguous ? extractVisibleItemCode(html) : "";
  const usableNodes = nodes.length ? nodes : [{}];
  const metaTitle = getMeta(html, "og:title") || getMeta(html, "twitter:title");
  const h1 = decodeHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, " ") || "").trim();
  const metaImage = getMeta(html, "og:image") || getMeta(html, "twitter:image");
  const metaPrice = getMeta(html, "product:price:amount");
  return usableNodes.map((p) => {
    const offers = Array.isArray(p.offers) ? p.offers[0] : (p.offers || {});
    const rawImage = Array.isArray(p.image) ? p.image[0] : p.image;
    const image = typeof rawImage === "object" ? (rawImage?.url || rawImage?.contentUrl || "") : rawImage;
    const detectedCode = visibleCodeAmbiguous ? "" : extractItemCode(html);
    const detectedCodeSource = detectedCode ? "visible_label" : (visibleCodeAmbiguous ? "ambiguous_visible_labels" : "none");
    // Keep the URL number only for diagnostics; it never replaces the visible 品番.
    const urlItemCode = url.match(/\/products\/(\d{13})(?:$|[/?#])/i)?.[1] || "";
    const urlCodeMismatch = Boolean(detectedCode && urlItemCode && detectedCode !== urlItemCode);
    const itemCode = detectedCode;
    const itemCodeSource = detectedCodeSource;
    return {
      title: decodeHtml(String(p.name || h1 || metaTitle).replace(/\s*[|｜].*$/, "")).trim(),
      price: offers.price != null ? String(offers.price) : (metaPrice || ""),
      currency: offers.priceCurrency || "JPY",
      image: typeof image === "string" && image ? image : metaImage,
      url,
      urlItemCode,
      itemCode,
      detectedItemCode: detectedCode,
      itemCodeSource,
      visibleCodeCandidates,
      codeStatus: itemCode && hasValidEan13CheckDigit(itemCode) ? "normal" : "blocked",
      urlCodeMismatch,
      source: "Francfranc公式商品ページ",
      checkedAt: new Date().toISOString(),
      // This indicates extraction from the visible official label, not certification of the site's registration.
      verifiedCode: itemCodeSource === "visible_label" && Boolean(itemCode) && hasValidEan13CheckDigit(itemCode),
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
        for (const product of parsed.filter((item) => item.urlCodeMismatch)) {
          console.warn("JAN_MISMATCH_DIAGNOSTIC " + JSON.stringify(diagnoseCodeMismatch(url, html, product)));
        }
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
    officialUrlCodeCount: products.filter(p => p.itemCodeSource === "official_url").length,
    // Count mismatching pages once, even if JSON-LD exposes multiple Product records.
    visibleLabelMismatchCount: new Set(products.filter(p => p.urlCodeMismatch).map(p => p.url)).size,
    urlCodeMismatchProductCount: products.filter(p => p.urlCodeMismatch).length,
    missingCodeCount: products.filter(p => !p.itemCode).length,
    invalidCheckDigitCount: products.filter(p => p.itemCode && !hasValidEan13CheckDigit(p.itemCode)).length,
    // Compare the extracted visible 品番 against the URL slug; URL is diagnostic only.
    urlCodeMismatchCount: new Set(products.filter(p => p.urlCodeMismatch).map(p => p.url)).size,
    ambiguousVisibleLabelCount: products.filter(p => p.codeStatus === "blocked" && p.itemCodeSource === "ambiguous_visible_labels").length,
    fetchFailed: failed.length,
    noProductData: noProductData.length,
    failed,
    noProductDataUrls: noProductData,
    note: "The single 13-digit 品番 visibly displayed on the official product page is the item code. URL-slug differences are counted for diagnostics only and never replace the visible 品番. Missing or ambiguous visible labels and invalid EAN-13 check digits remain blocked.",
    products,
  };
  await writeFile("catalog.json", JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Wrote catalog.json: ${products.length} products from ${selected.length} URLs.`);
}
