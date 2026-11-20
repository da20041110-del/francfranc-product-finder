/**
 * Read-only probe: test whether Shopify variant SKU codes resolve to
 * Francfranc official product URLs whose visible 品番 matches the SKU.
 * Never writes catalog.json or registers any SKU automatically.
 */
import fs from "node:fs/promises";
const CATALOG_PATH="catalog.json";
const OUT="test/variant-url-probe.json";
const PAGE_LIMIT=120;
const SKU_LIMIT=300;
const DELAY=650;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const decode=s=>String(s||"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n));
function visibleCodes(html){
 const t=decode(html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," "));
 return [...new Set([...t.matchAll(/品番\s*[:：|]?\s*(\d{13})/g)].map(m=>m[1]))];
}
function variants(html){
 const out=[];
 for(const m of html.matchAll(/"variants"\s*:\s*(\[[\s\S]*?\])\s*[,}]/g)){
  try{const a=JSON.parse(m[1]);if(Array.isArray(a))for(const v of a){
   const sku=String(v.sku||""); if(/^\d{13}$/.test(sku))out.push({sku,title:v.public_title||v.title||"",option1:v.option1||"",option2:v.option2||"",option3:v.option3||""});
  }}catch{}
 }
 const seen=new Set();return out.filter(v=>{if(seen.has(v.sku))return false;seen.add(v.sku);return true;});
}
const catalog=JSON.parse(await fs.readFile(CATALOG_PATH,"utf8"));
const products=catalog.products||[];
const pages=products.filter(p=>p.url&&/^https:\/\/francfranc\.com\/products\//.test(p.url)).slice(0,PAGE_LIMIT);
const candidates=new Map(); const pageErrors=[];
for(let i=0;i<pages.length;i++){
 try{
  const res=await fetch(pages[i].url,{headers:{"user-agent":"FrancfrancProductFinder/0.1 (read-only variant URL audit)"}});
  if(!res.ok)throw Error("HTTP "+res.status);
  const html=await res.text();
  for(const v of variants(html))if(!candidates.has(v.sku))candidates.set(v.sku,{...v,sourceTitle:pages[i].title||"",sourceUrl:pages[i].url});
 }catch(e){pageErrors.push({url:pages[i].url,error:String(e)});}
 if(i<pages.length-1)await sleep(DELAY);
}
const selected=[...candidates.values()].slice(0,SKU_LIMIT);
const rows=[];
for(let i=0;i<selected.length;i++){
 const v=selected[i],url="https://francfranc.com/products/"+v.sku;
 try{
  const res=await fetch(url,{redirect:"follow",headers:{"user-agent":"FrancfrancProductFinder/0.1 (read-only variant URL audit)"}});
  const html=res.ok?await res.text():"";
  const codes=visibleCodes(html);
  const title=(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||"";
  rows.push({sku:v.sku,variantTitle:v.title,option1:v.option1,option2:v.option2,sourceTitle:v.sourceTitle,sourceUrl:v.sourceUrl,url,status:res.status,finalUrl:res.url,title:decode(title.replace(/<[^>]+>/g," ")).trim(),visibleOfficialCodes:codes,skuEqualsOfficialCode:codes.includes(v.sku),statusClass:!res.ok?"http_error":codes.includes(v.sku)?"confirmed_exact_official_code":codes.length?"official_code_differs":"no_visible_official_code"});
 }catch(e){rows.push({sku:v.sku,url,statusClass:"fetch_failed",error:String(e)});}
 if(i<selected.length-1)await sleep(DELAY);
 if((i+1)%50===0)console.log("Probed",i+1,"/",selected.length);
}
const summary={generatedAt:new Date().toISOString(),catalogProducts:products.length,pagesScanned:pages.length,variantSkuCandidates:candidates.size,skuUrlsProbed:rows.length,confirmedExact:rows.filter(x=>x.statusClass==="confirmed_exact_official_code").length,officialCodeDiffers:rows.filter(x=>x.statusClass==="official_code_differs").length,noVisibleOfficialCode:rows.filter(x=>x.statusClass==="no_visible_official_code").length,httpErrors:rows.filter(x=>x.statusClass==="http_error"||x.statusClass==="fetch_failed").length,pageErrors:pageErrors.length,rows,pageErrors,safety:"Read-only probe. Shopify SKU is only a URL candidate. No catalog records are changed; only visible official 品番 is authoritative."};
await fs.mkdir("test",{recursive:true});await fs.writeFile(OUT,JSON.stringify(summary,null,2)+"\n");
console.log(JSON.stringify({...summary,rows:undefined,pageErrors:undefined},null,2));
