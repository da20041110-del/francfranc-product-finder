/**
 * Test-only comparison of verified variant candidates against current catalog.
 * Does not edit catalog.json, index.html, or production data.
 */
import fs from "node:fs/promises";
const catalog=JSON.parse(await fs.readFile("catalog.json","utf8"));
const candidates=JSON.parse(await fs.readFile("test/input/verified-variant-candidates.json","utf8"));
const products=Array.isArray(catalog.products)?catalog.products:[];
const existingCodes=new Set(products.map(p=>String(p.itemCode||"")).filter(x=>/^\\d{13}$/.test(x)));
const existingUrls=new Set(products.map(p=>String(p.url||"")).filter(Boolean));
const byCode=new Map();
for(const c of candidates){
 const code=String(c.itemCode||"");
 if(!/^\\d{13}$/.test(code)||c.itemCodeSource!=="visible_label"||c.verifiedCode!==true||c.codeStatus!=="normal")continue;
 if(!byCode.has(code))byCode.set(code,c);
}
const newCandidates=[...byCode.values()].filter(c=>!existingCodes.has(c.itemCode));
const alreadyPresent=[...byCode.values()].filter(c=>existingCodes.has(c.itemCode));
const sameUrlNewCode=newCandidates.filter(c=>existingUrls.has(c.url));
const report={
 generatedAt:new Date().toISOString(),
 currentCatalogGeneratedAt:catalog.generatedAt||null,
 currentCatalogProductRecords:products.length,
 currentCatalogUniqueCodes:existingCodes.size,
 currentCatalogUniqueUrls:existingUrls.size,
 verifiedCandidateRecords:candidates.length,
 uniqueVerifiedCandidateCodes:byCode.size,
 alreadyInCatalog:alreadyPresent.length,
 newCodeCandidates:newCandidates.length,
 newCodesOnExistingUrls:sameUrlNewCode.length,
 newCodesOnNewUrls:newCandidates.length-sameUrlNewCode.length,
 familyTitleMatch:newCandidates.filter(c=>c.familyTitleMatch).length,
 familyTitleNeedsReview:newCandidates.filter(c=>!c.familyTitleMatch).length,
 safety:"Comparison only. No production catalog edits. New candidates still require official page re-fetch and title/image/price validation before being eligible for test catalog integration."
};
await fs.mkdir("test",{recursive:true});
await fs.writeFile("test/variant-catalog-diff.json",JSON.stringify({report,newCandidates},null,2)+"\\n");
await fs.writeFile("test/variant-catalog-diff-report.json",JSON.stringify(report,null,2)+"\\n");
console.log(JSON.stringify(report,null,2));
