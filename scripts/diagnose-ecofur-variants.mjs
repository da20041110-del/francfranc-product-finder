/**
 * One-product diagnostic for Francfranc color variants.
 * Read-only: does not modify catalog.json or production.
 */
const URL = "https://francfranc.com/products/1106010032266";
const response = await fetch(URL, {
  headers: {
    "user-agent": "FrancfrancProductFinder/0.1 (authorized internal prototype)",
    "accept": "text/html,application/xhtml+xml,*/*",
  },
  redirect: "follow",
});
if (!response.ok) throw new Error("HTTP " + response.status + " for " + URL);
const html = await response.text();

const codes = [...new Set([...html.matchAll(/\b\d{13}\b/g)].map((m) => m[0]))];
const snippets = [];
for (const code of codes) {
  const positions = [...html.matchAll(new RegExp(code, "g"))].slice(0, 8);
  for (const match of positions) {
    const start = Math.max(0, match.index - 300);
    const end = Math.min(html.length, match.index + code.length + 300);
    snippets.push({ code, context: html.slice(start, end).replace(/\s+/g, " ").slice(0, 650) });
  }
}

const normalizedHtml = html.replaceAll("\\/", "/");
const imageUrls = [...new Set(
  [...normalizedHtml.matchAll(/https?:\/\/[^"'\s<>]+/gi)]
    .map((match) => match[0])
    .filter((url) => /\.(?:jpe?g|png|webp|avif)(?:[?#]|$)/i.test(url))
)];
const colorWords = ["ブラウン","ピンク","アイボリー","ライトブルー","BR","PK","IV","LBL"];
const colorHits = colorWords.map(color => ({
  color,
  occurrences: (html.match(new RegExp(color, "g")) || []).length,
}));
const report = {
  generatedAt: new Date().toISOString(),
  requestedUrl: URL,
  finalUrl: response.url,
  httpStatus: response.status,
  htmlLength: html.length,
  thirteenDigitCodes: codes,
  colorHits,
  imageUrlCount: imageUrls.length,
  imageUrls: imageUrls.slice(0, 250),
  codeContexts: snippets,
  interpretation: "Diagnostic only. Codes and image URLs are candidates, not verified color-to-code mappings. Confirm each mapping against the official visible 品番 and selected color before catalog use.",
};
console.log(JSON.stringify(report, null, 2));
