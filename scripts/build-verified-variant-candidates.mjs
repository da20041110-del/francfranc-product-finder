import fs from "node:fs/promises";
const input="test/input/variant-url-probe.json";
const output="test/verified-variant-candidates.json";
const audit=JSON.parse(await fs.readFile(input,"utf8"));
function validEan13(code){
 if(!/^\\d{13}$/.test(String(code||"")))return false;
 const d=[...code].map(Number);
 return (10-d.slice(0,12).reduce((s,n,i)=>s+n*(i%2===0?1:3),0)%10)%10===d[12];
}
const rows=audit.rows||[];
const exact=rows.filter(r=>r.statusClass==="confirmed_exact_official_code"&&r.visibleOfficialCodes?.length===1&&r.visibleOfficialCodes[0]===r.sku&&r.finalUrl===r.url);
const valid=exact.filter(r=>validEan13(r.sku));
const seen=new Set(),duplicates=[];
const candidates=[];
for(const r of valid){
 if(seen.has(r.sku)){duplicates.push(r.sku);continue;}
 seen.add(r.sku);
 candidates.push({
  itemCode:r.visibleOfficialCodes[0],
  itemCodeSource:"visible_label",
  verifiedCode:true,
  codeStatus:"normal",
  title:r.title,
  url:r.finalUrl,
  variantLabel:r.variantTitle||r.option1||r.option2||r.option3||"",
  sourceProductTitle:r.sourceTitle||"",
  sourceProductUrl:r.sourceUrl||"",
  familyTitleMatch:r.titleLooksRelated===true,
  evidence:"Official product URL opened; visible official 品番 exactly equals code; EAN-13 check digit valid."
 });
}
const report={
 generatedAt:new Date().toISOString(),
 inputRunId:44848634539,
 catalogPagesScanned:audit.pagesScanned,
 skuUrlsProbed:rows.length,
 exactOfficialCode:exact.length,
 exactWithValidEan13:valid.length,
 exactButInvalidEan13:exact.length-valid.length,
 candidateRecords:candidates.length,
 familyTitleMatch:candidates.filter(x=>x.familyTitleMatch).length,
 familyTitleNeedsReview:candidates.filter(x=>!x.familyTitleMatch).length,
 duplicateCodes:duplicates.length,
 blockedNonExact:rows.length-exact.length,
 safety:"Test-only candidate export. No production catalog is modified. Parent-family match is advisory; official visible 品番 and EAN-13 validity are mandatory."
};
await fs.mkdir("test",{recursive:true});
await fs.writeFile(output,JSON.stringify(candidates));
await fs.writeFile("test/verified-variant-candidate-report.json",JSON.stringify(report,null,2)+"\\n");
console.log(JSON.stringify(report,null,2));
