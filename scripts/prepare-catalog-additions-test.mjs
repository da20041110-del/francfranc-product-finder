import fs from "node:fs/promises";

const BASELINE_PATH = "baseline/catalog.json";
const FRESH_PATH = "catalog.json";
const OUT_DIR = "test";
const readJson = async path => JSON.parse(await fs.readFile(path, "utf8"));
const isEan13 = value => {
  const code = String(value || "");
  if (!/^\\d{13}$/.test(code)) return false;
  const digits = [...code].map(Number);
  const sum = digits.slice(0, 12).reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === digits[12];
};
const officialProductUrl = value => {
  try {
    const url = new URL(value);
    return url.hostname === "francfranc.com" && url.pathname.startsWith("/products/");
  } catch { return false; }
};
const officialImageUrl = value => {
  try {
    const url = new URL(value);
    return url.hostname === "francfranc.com" || url.hostname.endsWith(".francfranc.com");
  } catch { return false; }
};
const hasPrice = value => {
  const price = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(price) && price > 0;
};

const baseline = await readJson(BASELINE_PATH);
const fresh = await readJson(FRESH_PATH);
const baselineProducts = Array.isArray(baseline.products) ? baseline.products : [];
const freshProducts = Array.isArray(fresh.products) ? fresh.products : [];
const existingCodes = new Set(
  baselineProducts
    .filter(p => p.itemCodeSource === "visible_label" && p.codeStatus === "normal" && isEan13(p.itemCode))
    .map(p => p.itemCode)
);

const candidateGroups = new Map();
for (const product of freshProducts) {
  if (product.itemCodeSource !== "visible_label" || product.codeStatus !== "normal" ||
      product.verifiedCode !== true || !isEan13(product.itemCode)) continue;
  const rows = candidateGroups.get(product.itemCode) || [];
  rows.push(product);
  candidateGroups.set(product.itemCode, rows);
}

const alreadyRegistered = [];
const newCandidateGroups = [];
for (const [code, rows] of candidateGroups) {
  if (existingCodes.has(code)) alreadyRegistered.push({ code, records: rows.length });
  else newCandidateGroups.push({ code, rows });
}

const additions = [];
const review = [];
for (const group of newCandidateGroups) {
  const distinctUrls = [...new Set(group.rows.map(p => p.url).filter(Boolean))];
  const reasons = [];
  if (distinctUrls.length !== 1 || group.rows.some(p => !officialProductUrl(p.url))) reasons.push("official_code_not_unique_to_one_product_page");
  const product = [...group.rows].sort((a, b) =>
    Number(Boolean(b.title)) - Number(Boolean(a.title)) ||
    Number(hasPrice(b.price)) - Number(hasPrice(a.price)) ||
    Number(Boolean(b.image)) - Number(Boolean(a.image))
  )[0];
  if (!String(product.title || "").trim()) reasons.push("missing_official_product_name");
  if (!hasPrice(product.price)) reasons.push("missing_or_invalid_price");
  if (!product.image || !officialImageUrl(product.image)) reasons.push("missing_or_non_official_image");
  if (product.imageStatus !== "matched_visible_code") reasons.push("image_not_verified_against_visible_code");
  if (reasons.length) {
    review.push({
      code: group.code,
      reasons,
      pageUrls: distinctUrls,
      records: group.rows.map(p => ({
        title: p.title || "",
        url: p.url || "",
        price: p.price || "",
        image: p.image || "",
        imageStatus: p.imageStatus || "",
        imageSource: p.imageSource || ""
      }))
    });
    continue;
  }
  additions.push({
    ...product,
    source: "Francfranc公式商品ページ（追加候補再取得）",
    additionVerifiedAt: new Date().toISOString()
  });
}

additions.sort((a, b) => a.title.localeCompare(b.title, "ja") || a.itemCode.localeCompare(b.itemCode));
const testProducts = [...baselineProducts, ...additions];
const report = {
  generatedAt: new Date().toISOString(),
  baseline: {
    generatedAt: baseline.generatedAt || null,
    productRecords: baselineProducts.length,
    validVisibleOfficialCodes: existingCodes.size
  },
  freshOfficialScan: {
    generatedAt: fresh.generatedAt || null,
    attemptedUrls: fresh.attempted ?? null,
    productRecords: freshProducts.length,
    uniqueProductPages: fresh.uniqueProductPagesFound ?? new Set(freshProducts.map(p => p.url)).size,
    uniqueValidVisibleOfficialCodes: candidateGroups.size
  },
  comparison: {
    alreadyRegisteredCodes: alreadyRegistered.length,
    newOfficialCodeCandidates: newCandidateGroups.length,
    acceptedForTestCatalog: additions.length,
    heldForManualReview: review.length
  },
  rules: [
    "Only a valid EAN-13 from the official page's visible 品番 label is eligible.",
    "URL slugs, Shopify SKU, and variant IDs are never barcode sources.",
    "The code must be unique to one official product page in the fresh scan.",
    "The official product name and positive price must be present.",
    "The product image must be on the official Francfranc domain and explicitly matched to the visible code.",
    "Candidates that fail any check are held for review and are not added."
  ],
  alreadyRegistered,
  acceptedItemCodes: additions.map(p => p.itemCode),
  review
};

await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(`${OUT_DIR}/catalog-additions.json`, JSON.stringify({
  generatedAt: report.generatedAt,
  source: fresh.source || "https://francfranc.com",
  attempted: additions.length,
  found: additions.length,
  products: additions
}, null, 2) + "\n");
await fs.writeFile(`${OUT_DIR}/catalog.json`, JSON.stringify({
  ...baseline,
  generatedAt: report.generatedAt,
  source: "既存カタログ + 公式情報を再確認した追加候補（テスト専用）",
  attempted: (baseline.attempted || 0) + additions.length,
  found: testProducts.length,
  products: testProducts
}, null, 2) + "\n");
await fs.writeFile(`${OUT_DIR}/catalog-additions-report.json`, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report.comparison, null, 2));
if (!additions.length) {
  console.warn("No additions passed all official-code, name, price, and image checks. Production data remains untouched.");
}
