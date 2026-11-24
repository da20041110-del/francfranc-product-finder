import fs from "node:fs";
const candidateDir = process.env.CANDIDATE_DIR || "candidate";
const catalogPath = "catalog.json";
const featurePath = "image-features.json";
const additions = JSON.parse(fs.readFileSync(candidateDir + "/catalog-additions.json", "utf8"));
const candidateFeatures = JSON.parse(fs.readFileSync(candidateDir + "/image-features.json", "utf8"));
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const features = JSON.parse(fs.readFileSync(featurePath, "utf8"));
if (!Array.isArray(additions.products) || additions.products.length !== 2868) throw new Error("Expected 2,868 verified additions; got " + additions.products?.length);
if (!candidateFeatures.features || typeof candidateFeatures.features !== "object") throw new Error("Candidate image feature map is missing");
if (!Array.isArray(catalog.products) || !features.features) throw new Error("Current production catalog or image feature map has an invalid shape");
const byCode = new Map();
for (const p of catalog.products) {
  if (p.itemCode) {
    if (byCode.has(p.itemCode)) throw new Error("Duplicate itemCode already exists in production: " + p.itemCode);
    byCode.set(p.itemCode, p);
  }
}
const seenCandidates = new Set();
const accepted = [];
const featureAdds = new Map();
const skippedExisting = [];
for (const p of additions.products) {
  const code = p.itemCode;
  if (!/^\d{13}$/.test(code || "")) throw new Error("Invalid 13-digit code: " + code);
  if (p.urlItemCode !== code || p.detectedItemCode !== code || p.verifiedCode !== true) throw new Error("Official visible code mismatch or unverified code: " + code);
  if (!/^https:\/\/francfranc\.com\/products\/\d{13}$/.test(p.url || "")) throw new Error("Non-official or malformed product URL: " + code);
  if (!/^https:\/\/francfranc\.com\/cdn\/shop\/(files|products)\//.test(p.image || "")) throw new Error("Non-official or non-HTTPS image URL: " + code);
  if (!(Number(p.price) > 0)) throw new Error("Missing/non-positive price: " + code);
  if (seenCandidates.has(code)) throw new Error("Duplicate code in candidate additions: " + code);
  seenCandidates.add(code);
  if (byCode.has(code)) { skippedExisting.push(code); continue; }
  if (!candidateFeatures.features[p.image]) throw new Error("Missing reusable image feature for " + code + ": " + p.image);
  accepted.push(p);
  featureAdds.set(p.image, candidateFeatures.features[p.image]);
  byCode.set(code, p);
}
const originalCount = catalog.products.length;
const originalFeatureCount = Object.keys(features.features).length;
catalog.products.push(...accepted);
for (const [url, vector] of featureAdds) if (!(url in features.features)) features.features[url] = vector;
catalog.generatedAt = new Date().toISOString();
catalog.source = "Francfranc公式商品ページ（定期更新 + 品番照合済み追加候補）";
catalog.found = catalog.products.length;
catalog.uniqueProductPagesFound = new Set(catalog.products.map(p => p.url).filter(Boolean)).size;
catalog.visibleLabelCodeCount = (catalog.visibleLabelCodeCount || 0) + accepted.length;
catalog.imageMatchedToVisibleCodeCount = (catalog.imageMatchedToVisibleCodeCount || 0) + accepted.length;
features.generatedAt = new Date().toISOString();
features.catalogGeneratedAt = catalog.generatedAt;
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
fs.writeFileSync(featurePath, JSON.stringify(features, null, 2) + "\n");
const report = {
  productionBaselineProducts: originalCount,
  candidateInput: additions.products.length,
  acceptedNewProducts: accepted.length,
  skippedAlreadyPresent: skippedExisting.length,
  productionProductsAfterMerge: catalog.products.length,
  featureCountBefore: originalFeatureCount,
  featureUrlsAdded: featureAdds.size,
  featureCountAfter: Object.keys(features.features).length,
  allNewProductsHaveFeatures: accepted.every(p => Boolean(features.features[p.image])),
  allNewImageUrlsHttps: accepted.every(p => p.image.startsWith("https://")),
  duplicateCodesInFinalCatalog: catalog.products.length - new Set(catalog.products.map(p => p.itemCode).filter(Boolean)).size
};
if (report.duplicateCodesInFinalCatalog !== 0 || !report.allNewProductsHaveFeatures || !report.allNewImageUrlsHttps) throw new Error("Post-merge validation failed: " + JSON.stringify(report));
fs.writeFileSync("variant-additions-merge-report.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
