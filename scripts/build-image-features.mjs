import { readFile, writeFile } from "node:fs/promises";
import { pipeline, env } from "@xenova/transformers";

env.allowLocalModels = false;

const catalog = JSON.parse(await readFile("catalog.json", "utf8"));
const outputPath = "image-features.json";
let previous = { features: {} };
try {
  previous = JSON.parse(await readFile(outputPath, "utf8"));
} catch {}
const products = (catalog.products || []).filter(p => p.image && p.title);
const features = {};
for (const product of products) {
  if (previous.features?.[product.image]) features[product.image] = previous.features[product.image];
}
const pending = products.filter(p => !features[p.image]);
console.log(`Catalog images: ${products.length}; reusable vectors: ${Object.keys(features).length}; to compute: ${pending.length}`);

if (pending.length) {
  const extractor = await pipeline("image-feature-extraction", "Xenova/clip-vit-base-patch32");
  let completed = 0;
  let failed = 0;
  for (const product of pending) {
    try {
      const output = await extractor(product.image);
      const values = output?.data;
      if (!values?.length) throw new Error("Empty feature vector");
      let norm = 0;
      for (const value of values) norm += value * value;
      norm = Math.sqrt(norm) || 1;
      const quantized = Int8Array.from(values, value => Math.max(-127, Math.min(127, Math.round((value / norm) * 127))));
      features[product.image] = Buffer.from(quantized.buffer, quantized.byteOffset, quantized.byteLength).toString("base64");
    } catch (error) {
      failed++;
      console.warn(`Failed image: ${product.image}: ${error?.message || error}`);
    }
    completed++;
    if (completed % 25 === 0 || completed === pending.length) {
      console.log(`Processed ${completed}/${pending.length}; failed ${failed}`);
      await writeFile(outputPath, JSON.stringify({
        model: "Xenova/clip-vit-base-patch32",
        generatedAt: new Date().toISOString(),
        dimension: 512,
        quantization: "normalized-int8-base64",
        catalogGeneratedAt: catalog.generatedAt || null,
        features
      }));
    }
  }
}
await writeFile(outputPath, JSON.stringify({
  model: "Xenova/clip-vit-base-patch32",
  generatedAt: new Date().toISOString(),
  dimension: 512,
  quantization: "normalized-int8-base64",
  catalogGeneratedAt: catalog.generatedAt || null,
  features
}));
console.log(JSON.stringify({ catalogImages: products.length, cachedOrGenerated: Object.keys(features).length, missing: products.length - Object.keys(features).length }));
