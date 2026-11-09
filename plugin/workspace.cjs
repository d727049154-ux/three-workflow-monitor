'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {canonical,sha,nowIso} = require('./core.cjs');
const empty = () => ({schema:'workflow-workspace/1',revision:0,favorites:[],recent:[],seen:null,workflows:[],resources:[]});
class Workspace {
  constructor(root) {this.root=root;this.file=path.join(root,'workspace.json');this.value=empty();this.error=null;}
  async init() {
    try {
      const bytes=await fs.readFile(this.file);if(bytes.length>512*1024)throw new Error('too large');
      const value=JSON.parse(bytes);const {hash,...contents}=value;
      if(contents.schema!=='workflow-workspace/1'||!Number.isSafeInteger(contents.revision)||contents.revision<1||!Array.isArray(contents.favorites)||!Array.isArray(contents.recent)||!Array.isArray(contents.workflows)||hash!==sha(canonical(contents)))throw new Error('invalid');
      if(contents.favorites.length>64||contents.recent.length>12||contents.workflows.length>40||contents.resources&&(!Array.isArray(contents.resources)||contents.resources.length>80))throw new Error('invalid');
      this.value=contents;
    } catch(error) {if(error.code!=='ENOENT')this.error='常用入口与新增流程配置不可读，原文件已保留；请从 workspace-history 中恢复有效版本。';}
    return this;
  }
  view() {return {resources:[],...structuredClone(this.value),error:this.error};}
  async save(next) {
    if(this.error)throw new Error(this.error);
    if(canonical({...next,revision:0})===canonical({...this.value,revision:0}))return this.view();
    const contents={...next,schema:'workflow-workspace/1',revision:this.value.revision+1};
    const hash=sha(canonical(contents));const bytes=JSON.stringify({...contents,hash},null,2);
    const archive=path.join(this.root,'workspace-history');await fs.mkdir(archive,{recursive:true});
    const stamp=path.join(archive,`${String(contents.revision).padStart(8,'0')}-${hash}.json`);
    await fs.writeFile(stamp,bytes,{flag:'wx'});
    const pending=`${this.file}.pending-${process.pid}-${Date.now()}`;const handle=await fs.open(pending,'wx');
    try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    await fs.rename(pending,this.file);this.value=contents;return this.view();
  }
  async favorite(target,title,key,enabled) {
    const remaining=this.value.favorites.filter(item=>item.key!==key);
    if(enabled){if(remaining.length>=64)throw new Error('最多收藏 64 个入口');remaining.push({target,title,key,at:nowIso()});}
    return this.save({...this.value,favorites:remaining});
  }
  async visit(target,title,key) {
    if(this.value.recent[0]?.key===key && Date.now()-Date.parse(this.value.recent[0].at)<60000)return this.view();
    return this.save({...this.value,recent:[{target,title,key,at:nowIso()},...this.value.recent.filter(item=>item.key!==key)].slice(0,12)});
  }
  async acknowledge(record) {
    if(this.value.seen?.id>=record.id)return this.view();
    return this.save({...this.value,seen:{id:record.id,hash:record.hash,at:nowIso()}});
  }
}
module.exports={Workspace};
