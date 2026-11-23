import fs from "node:fs/promises";

const audit = JSON.parse(await fs.readFile("test/input/variant-catalog-diff.json", "utf8"));
const baseline = JSON.parse(await fs.readFile("baseline/catalog.json", "utf8"));
const candidates = (audit.newCandidates || []).filter(c => c.familyTitleMatch === true);
const heldByFamily = (audit.newCandidates || []).filter(c => c.familyTitleMatch !== true);
const OUT = "test/variant-catalog-additions.json";
const DELAY = 1200;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const headers = {
  "user-agent": "FrancfrancProductFinder/0.1 (authorized internal prototype)",
  "accept": "text/html,application/xhtml+xml,*/*"
};

function decode(value = "") {
  return String(value)
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
function validEan(code) {
  if (!/^\d{13}$/.test(String(code || ""))) return false;
  const digits = [...code].map(Number);
  return (10 - digits.slice(0, 12).reduce((sum, n, i) => sum + n * (i % 2 === 0 ? 1 : 3), 0) % 10) % 10 === digits[12];
}
function positivePrice(value) {
  const amount = Number(String(value ?? "").replace(/,/g, "").replace(/[^\d.]/g, ""));
  return Number.isFinite(amount) && amount > 0;
}
function visibleCodes(html) {
  const text = decode(html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " "));
  return [...new Set([...text.matchAll(/品番\s*[:：|]?\s*(\d{13})/g)].map(match => match[1]))];
}
function jsonProducts(html) {
  const products = [];
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = node => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
        if (types.includes("Product")) products.push(node);
        if (node["@graph"]) walk(node["@graph"]);
        if (node.hasVariant) walk(node.hasVariant);
      };
      walk(JSON.parse(match[1].trim()));
    } catch {}
  }
  return products;
}
function meta(html, key) {
  for (const tag of html.match(/<meta\\b[^>]*>/gi) || []) {
    const name = tag.match(/(?:property|name)=["']([^"']+)["']/i)?.[1];
    const content = tag.match(/content=["']([^"']*)["']/i)?.[1];
    if (name === key && content != null) return decode(content).trim();
  }
  return "";
}
function imageFor(html, code) {
  // Shopify product images may be served from /cdn/shop/products/ on Francfranc,
  // or from cdn.shopify.com. Scan HTML URL attributes without relying on a
  // single image-host/path convention.
  const normalized = html
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&");
  const urls = [...normalized.matchAll(/(?:https?:)?\/\/[^"' \t\r\n<>]+|\/cdn\/shop\/(?:files|products)\/[^"' \t\r\n<>]+/gi)]
    .map(match => decode(match[0]).replace(/[),;]+$/, ""));
  const found = [];
  for (const raw of urls) {
    try {
      const url = new URL(raw.startsWith("//") ? "https:" + raw : raw, "https://francfranc.com");
      const host = url.hostname.toLowerCase();
      if (host !== "francfranc.com" && host !== "cdn.shopify.com") continue;
      // Keep official Francfranc image URLs HTTPS for the HTTPS PWA.
      if (host === "francfranc.com" && url.protocol === "http:") url.protocol = "https:";
      const filename = decodeURIComponent(url.pathname.split("/").pop() || "");
      if (new RegExp("^" + code + "(?:[_-][^/]*)?\\.(?:jpe?g|png|webp|avif)$", "i").test(filename)) {
        if (url.pathname.includes("/cdn/shop/") && url.searchParams.has("width")) url.searchParams.set("width", "1200");
        found.push(url.href);
      }
    } catch {}
  }
  return found.find(value => /_d1\./i.test(new URL(value).pathname)) || found[0] || "";
}
function norm(value = "") {
  return String(value).normalize("NFKC").toLocaleLowerCase("ja")
    .replace(/[\s　・･‐‑‒–—―ー_/.,、。()（）［］【】「」『』]/g, "");
}
function officialProductUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === "francfranc.com" && url.pathname.startsWith("/products/");
  } catch { return false; }
}

const baselineProducts = Array.isArray(baseline.products) ? baseline.products : [];
const existingCodes = new Set(baselineProducts.map(p => String(p.itemCode || "")).filter(Boolean));
const additions = [];
const rejected = [];
const seen = new Set();
let cursor = 0;
let done = 0;

async function worker() {
  while (cursor < candidates.length) {
    const candidate = candidates[cursor++];
    try {
      if (!officialProductUrl(candidate.url)) throw new Error("candidate URL is not an official Francfranc product page");
      if (!validEan(candidate.itemCode)) throw new Error("candidate EAN-13 is invalid");
      if (existingCodes.has(candidate.itemCode)) throw new Error("already present in baseline catalog");
      if (seen.has(candidate.itemCode)) throw new Error("duplicate candidate code");

      let response;
      let lastError;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          response = await fetch(candidate.url, { headers, redirect: "follow" });
          if (response.status === 429 || response.status >= 500) {
            lastError = new Error("HTTP " + response.status);
            await sleep([5000, 15000, 45000, 90000][attempt]);
            response = null;
            continue;
          }
          break;
        } catch (error) {
          lastError = error;
          await sleep([3000, 10000, 30000, 60000][attempt]);
        }
      }
      if (!response) throw lastError || new Error("official page fetch failed");
      if (!response.ok) throw new Error("HTTP " + response.status);

      const requestedUrl = new URL(candidate.url);
      const finalUrl = new URL(response.url);
      if (finalUrl.hostname !== "francfranc.com" || finalUrl.pathname !== requestedUrl.pathname) {
        throw new Error("official page redirected to a different product URL: " + response.url);
      }

      const html = await response.text();
      const codes = visibleCodes(html);
      if (codes.length !== 1 || codes[0] !== candidate.itemCode) {
        throw new Error("visible official 品番 mismatch/ambiguous: " + codes.join(","));
      }

      const product = jsonProducts(html)[0] || {};
      const rawTitle = product.name ||
        html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, " ") ||
        meta(html, "og:title");
      const title = decode(String(rawTitle || "").replace(/\s*[|｜].*$/, "")).trim();
      const actualTitle = norm(title);
      const familyTitle = norm(candidate.sourceProductTitle || "");
      if (!title || !familyTitle || !(actualTitle.includes(familyTitle) || familyTitle.includes(actualTitle))) {
        throw new Error("official title family mismatch: " + title);
      }

      const offers = Array.isArray(product.offers) ? (product.offers[0] || {}) : (product.offers || {});
      const price = offers.price != null ? String(offers.price) : meta(html, "product:price:amount");
      if (!positivePrice(price)) throw new Error("official price missing or invalid: " + price);

      const image = imageFor(html, candidate.itemCode);
      if (!image) throw new Error("no official image filename matched to the visible 品番");
      const imageUrl = new URL(image);
      if (imageUrl.hostname !== "francfranc.com" && !imageUrl.hostname.endsWith(".francfranc.com")) {
        throw new Error("image is not hosted on the official Francfranc domain");
      }

      seen.add(candidate.itemCode);
      additions.push({
        title,
        price,
        currency: offers.priceCurrency || "JPY",
        image,
        imageSource: "visible_code_filename",
        imageStatus: "matched_visible_code",
        variantImageCandidatesCount: 1,
        url: candidate.url,
        urlItemCode: candidate.itemCode,
        itemCode: candidate.itemCode,
        detectedItemCode: candidate.itemCode,
        itemCodeSource: "visible_label",
        visibleCodeCandidates: codes,
        codeStatus: "normal",
        urlCodeMismatch: false,
        source: "Francfranc公式商品ページ（追加候補を再取得）",
        checkedAt: new Date().toISOString(),
        verifiedCode: true,
        variantLabel: candidate.variantLabel || "",
        sourceProductTitle: candidate.sourceProductTitle || "",
        sourceProductUrl: candidate.sourceProductUrl || ""
      });
    } catch (error) {
      rejected.push({
        itemCode: candidate.itemCode,
        title: candidate.title || "",
        url: candidate.url,
        reason: String(error?.message || error)
      });
    }

    done++;
    if (done % 100 === 0) {
      console.log("Revalidated", done, "/", candidates.length, "accepted", additions.length, "rejected", rejected.length);
    }
    if (done < candidates.length) await sleep(DELAY);
  }
}

await Promise.all(Array.from({ length: 3 }, () => worker()));
additions.sort((a, b) => a.title.localeCompare(b.title, "ja") || a.itemCode.localeCompare(b.itemCode));

const testProducts = [...baselineProducts, ...additions];
const report = {
  generatedAt: new Date().toISOString(),
  sourceCandidateArtifactRunId: 44876212152,
  inputNewCodeCandidates: audit.newCandidates?.length || 0,
  familyMatchedCandidates: candidates.length,
  heldForFamilyTitleReview: heldByFamily.length,
  revalidated: done,
  acceptedForTestCatalog: additions.length,
  rejected: rejected.length,
  withPositivePrice: additions.filter(p => positivePrice(p.price)).length,
  withCodeMatchedOfficialImage: additions.filter(p => p.imageStatus === "matched_visible_code").length,
  uniqueAcceptedCodes: new Set(additions.map(p => p.itemCode)).size,
  baselineProducts: baselineProducts.length,
  testCatalogProducts: testProducts.length,
  rejectionReasons: rejected.reduce((counts, item) => {
    counts[item.reason] = (counts[item.reason] || 0) + 1;
    return counts;
  }, {}),
  safety: "Test-only. Each original family-matched candidate URL is re-fetched. The visible official 品番 must uniquely equal the candidate, EAN-13 must be valid, the live official title must match its source family, a positive official price must exist, and an official image filename must match the visible code. Production catalog is untouched.",
  rejections: rejected
};

await fs.mkdir("test", { recursive: true });
await fs.writeFile(OUT, JSON.stringify({ report, products: additions }, null, 2) + "\n");
await fs.writeFile("test/variant-catalog-additions-report.json", JSON.stringify(report, null, 2) + "\n");
await fs.writeFile("test/catalog-additions.json", JSON.stringify({
  generatedAt: report.generatedAt,
  source: "Francfranc official product pages; revalidated original variant candidates",
  attempted: additions.length,
  found: additions.length,
  products: additions
}, null, 2) + "\n");
await fs.writeFile("test/catalog.json", JSON.stringify({
  ...baseline,
  generatedAt: report.generatedAt,
  source: "既存カタログ + 公式情報を再確認した追加候補（テスト専用）",
  attempted: (baseline.attempted || 0) + additions.length,
  found: testProducts.length,
  products: testProducts
}, null, 2) + "\n");

console.log(JSON.stringify({ ...report, rejections: undefined }, null, 2));
