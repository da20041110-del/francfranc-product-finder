/**
 * Test-only audit of product pages that expose multiple visible 品番 labels.
 * Candidate extraction only. Never maps Shopify SKU to official 品番 automatically.
 * Writes test/variant-audit.json; does not touch catalog.json.
 */
import fs from "node:fs/promises";

const CATALOG_PATH = "catalog.json";
const OUTPUT_PATH = "test/variant-audit.json";
const LIMIT = Number(process.env.AUDIT_LIMIT || 500);
const DELAY_MS = Number(process.env.AUDIT_DELAY_MS || 900);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const decode = s => String(s || "")
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

function visibleCodes(html) {
  const text = decode(html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " "));
  return [...new Set([...text.matchAll(/品番\s*[:：|]?\s*(\d{13})/g)].map(m => m[1]))];
}
function productsFromJsonLd(html) {
  const found = [];
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    if (types.includes("Product")) {
      found.push({
        name: node.name || "",
        sku: node.sku || "",
        mpn: node.mpn || "",
        productID: node.productID || "",
        color: node.color || "",
        size: node.size || "",
        hasVariantCount: Array.isArray(node.hasVariant) ? node.hasVariant.length : (node.hasVariant ? 1 : 0),
      });
    }
    for (const key of ["@graph", "hasVariant", "itemListElement"]) if (node[key]) visit(node[key]);
  };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(m[1].trim())); } catch {}
  }
  return found;
}
function shopifyVariants(html) {
  const out = [];
  const patterns = [
    /"variants"\s*:\s*(\[[\s\S]*?\])\s*,\s*"(?:images|options|options_with_values)"/g,
    /"variants"\s*:\s*(\[[\s\S]*?\])\s*[,}]/g,
  ];
  for (const pattern of patterns) {
    for (const m of html.matchAll(pattern)) {
      try {
        const parsed = JSON.parse(m[1]);
        if (Array.isArray(parsed)) for (const v of parsed) {
          out.push({
            title: v.public_title || v.title || "",
            sku: v.sku || "",
            option1: v.option1 || "",
            option2: v.option2 || "",
            option3: v.option3 || "",
            imageId: v.featured_image?.id || v.image_id || null,
            available: typeof v.available === "boolean" ? v.available : null,
          });
        }
      } catch {}
    }
  }
  const seen = new Set();
  return out.filter(v => {
    const key = [v.sku,v.title,v.option1,v.option2,v.option3].join("|");
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function validEan13(code) {
  if (!/^\d{13}$/.test(code)) return false;
  const d = [...code].map(Number);
  return (10 - d.slice(0,12).reduce((s,n,i)=>s+n*(i%2?3:1),0)%10)%10 === d[12];
}

const catalog = JSON.parse(await fs.readFile(CATALOG_PATH, "utf8"));
const existingCodes = new Set((catalog.products || []).map(p => p.itemCode).filter(c => /^\d{13}$/.test(c)));
const candidates = (catalog.products || [])
  .filter(p => (p.visibleCodeCandidates || []).length > 1 || p.itemCodeSource === "ambiguous_visible_labels")
  .filter(p => p.url && /^https:\/\/francfranc\.com\/products\//.test(p.url))
  .slice(0, LIMIT);

const rows = [];
for (let i=0; i<candidates.length; i++) {
  const item = candidates[i];
  try {
    const res = await fetch(item.url, {
      headers: { "user-agent": "FrancfrancProductFinder/0.1 (test catalog audit)", "accept": "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();
    const codes = visibleCodes(html);
    const variants = shopifyVariants(html);
    const jsonLd = productsFromJsonLd(html);
    rows.push({
      title: item.title || "",
      url: item.url,
      httpStatus: res.status,
      visibleOfficialCodes: codes.map(code => ({ code, validEan13: validEan13(code), alreadyInCatalog: existingCodes.has(code) })),
      shopifyVariants: variants,
      jsonLdProducts: jsonLd,
      status: codes.length > 1 ? "manual_mapping_required" : codes.length === 1 ? "single_visible_code_review" : "no_visible_code",
      rule: "SKU/variant ID is not treated as the official 品番. Manual association requires explicit visible page evidence for each selected color/size.",
    });
  } catch (error) {
    rows.push({ title: item.title || "", url: item.url, status: "fetch_failed", error: String(error) });
  }
  if (i < candidates.length - 1) await sleep(DELAY_MS);
  if ((i+1)%25===0) console.log("Audited", i+1, "/", candidates.length);
}

const report = {
  generatedAt: new Date().toISOString(),
  scope: "catalog pages with more than one visible official 品番 candidate",
  catalogProductCount: (catalog.products || []).length,
  pagesSelected: candidates.length,
  pagesAudited: rows.length,
  pagesWithMultipleCodes: rows.filter(r => r.visibleOfficialCodes?.length > 1).length,
  pagesWithShopifyVariants: rows.filter(r => r.shopifyVariants?.length > 1).length,
  pagesRequiringManualMapping: rows.filter(r => r.status === "manual_mapping_required").length,
  fetchFailures: rows.filter(r => r.status === "fetch_failed").length,
  existingCatalogCodeCount: existingCodes.size,
  rows,
  safety: "No product records are auto-added. Only explicit visible 品番 is considered authoritative; ambiguous color/size mapping is held for review.",
};
await fs.mkdir("test", { recursive: true });
await fs.writeFile(OUTPUT_PATH, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({
  output: OUTPUT_PATH, pagesSelected: report.pagesSelected,
  pagesAudited: report.pagesAudited, pagesWithMultipleCodes: report.pagesWithMultipleCodes,
  pagesWithShopifyVariants: report.pagesWithShopifyVariants,
  pagesRequiringManualMapping: report.pagesRequiringManualMapping,
  fetchFailures: report.fetchFailures
}, null, 2));
