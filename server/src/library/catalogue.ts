/** Cheap daily metadata check. Weekly sync still verifies complete public source bytes. */
import {AUTHORS,type InstalledSource} from './sync.ts';
export interface CatalogueRow {id:string;author:string;name:string;url:string;updated:string|null;access:number}
export interface CatalogueReport {at:string;complete:boolean;publications:CatalogueRow[];changes:Array<{id:string;kind:'new-publication'|'metadata-changed'|'not-installed'}>;issues:Array<{author:string;reason:string}>}
export async function scanCatalogue(known:InstalledSource[],text:(url:string)=>Promise<string>,previous?:CatalogueReport,authors=AUTHORS):Promise<CatalogueReport>{
 const rows=new Map((previous?.publications??[]).map(p=>[p.id,p]));
 const changes:CatalogueReport['changes']=[],issues:CatalogueReport['issues']=[];
 const installed=new Set(known.map(s=>s.pub).filter(Boolean));
 for(const author of authors){
  try{
   const found=new Map<string,CatalogueRow>();
   for(let page=1;page<=20;page++){
    const data=JSON.parse(await text(`https://www.tradingview.com/api/v1/scripts/?page=${page}&per_page=50&by=${encodeURIComponent(author)}&q=`));
    if(!Array.isArray(data.results))throw Error('Invalid publication catalogue');
    for(const r of data.results){
     if(typeof r.script_id_part!=='string'||typeof r.chart_url!=='string')throw Error('Missing publication identity');
     found.set(r.script_id_part,{id:r.script_id_part,author,name:String(r.name),url:r.chart_url,updated:r.updated_at??r.created_at??null,access:r.script_access});
    }
    if(!data.next)break;
    if(page===20)throw Error('Catalogue pagination incomplete');
   }
   for(const p of found.values()){
    const old=rows.get(p.id);
    if(old&&(old.updated!==p.updated||old.access!==p.access))changes.push({id:p.id,kind:'metadata-changed'});
    else if(!old&&previous)changes.push({id:p.id,kind:'new-publication'});
    else if(!old&&!installed.has(p.id)&&p.access===1)changes.push({id:p.id,kind:'not-installed'});
    rows.set(p.id,p);
   }
  }catch(e){issues.push({author,reason:(e as Error).message});}
 }
 return {at:new Date().toISOString(),complete:issues.length===0,publications:[...rows.values()],changes,issues};
}
