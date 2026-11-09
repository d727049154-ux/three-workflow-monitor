import Fuse from './fuse.basic-7.5.0.min.mjs';
export const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/白膜/g,'白模').replace(/\b(edgle|eagel|egale)\b/g,'eagle').trim();
const kindGroup = kind => ['workflow','task','item'].includes(kind) ? 'task' : ['skill','topic'].includes(kind) ? 'skill' : ['motion','pose'].includes(kind) ? 'motion' : kind==='file'?'resource':kind;
export class SearchIndex {
  constructor(entries) {
    this.entries = entries;
    this.docs = entries.map((entry,index)=>({index,title:normalize(entry.title),identity:normalize(entry.identity),keywords:normalize(`${entry.keywords} ${entry.subtitle} ${entry.kindLabel}`),description:normalize(entry.description)}));
    this.fuse = new Fuse(this.docs,{keys:[{name:'title',weight:0.45},{name:'identity',weight:0.25},{name:'keywords',weight:0.2},{name:'description',weight:0.1}],threshold:0.32,ignoreLocation:true,ignoreFieldNorm:true,includeScore:true});
  }
  search(query, {kind='all', flow='all', limit=40} = {}) {
    const terms = normalize(query).split(/\s+/).filter(Boolean).slice(0,12);
    if (!terms.length) return [];
    const matches = terms.map(term=>{
      const values = new Map();
      // Short Chinese queries stay exact; longer misspellings use the local Fuse build.
      if (term.length >= 3) for (const hit of this.fuse.search(term)) values.set(hit.item.index,0.4 + (hit.score || 0));
      for (const doc of this.docs) {
        const exact = doc.title === term || doc.identity === term ? 0 : doc.title.includes(term) ? 0.02 : doc.identity.includes(term) ? 0.04 : doc.keywords.includes(term) ? 0.12 : doc.description.includes(term) ? 0.22 : null;
        if (exact != null) values.set(doc.index, exact);
      }
      return values;
    });
    const ranked=[];
    for (const [index,first] of matches[0]) {
      const entry=this.entries[index];
      if (kind !== 'all' && kindGroup(entry.target.kind) !== kind || flow !== 'all' && !entry.workflows.includes(flow)) continue;
      if (matches.some(map=>!map.has(index))) continue;
      ranked.push({entry,score:matches.reduce((sum,map)=>sum+map.get(index),0)/terms.length,index});
    }
    ranked.sort((a,b)=>a.score-b.score || a.index-b.index);
    return ranked.slice(0,limit).map(item=>item.entry);
  }
}
