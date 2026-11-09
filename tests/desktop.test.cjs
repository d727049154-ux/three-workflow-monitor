'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');
const {EventEmitter}=require('node:events');
const {validateCall,validateCommand}=require('../desktop/contract.cjs');
const {fitBounds,compactTransition,readPreferences}=require('../desktop/window-state.cjs');
const {BackendService}=require('../desktop/service.cjs');
const {createShutdown}=require('../desktop/shutdown.cjs');
const {copyHistory,retainedFiles}=require('../tools/desktop-history.cjs');
const {History}=require('../plugin/history.cjs');
const {sha}=require('../plugin/core.cjs');
const {dockBounds}=require('../desktop/dock-layout.cjs');
test('desktop bridge refuses unlisted operations and unbounded payloads',()=>{
  assert.equal(validateCall({method:'refreshAll'}).method,'refreshAll');
  assert.throws(()=>validateCall({method:'exec',args:{command:'ignored'}}));
  assert.throws(()=>validateCall({method:'configure',args:[]}));
  assert.throws(()=>validateCall({method:'configure',args:{value:'x'.repeat(33000)}}));
  assert.throws(()=>validateCommand('openAnyPath'));
});
test('window recovery clamps removed-monitor coordinates and keeps compact windows on screen',()=>{
  const area={x:0,y:0,width:1920,height:1040};
  const full=fitBounds({x:5000,y:-1200,width:396,height:760},area);
  assert.deepEqual(full,{x:1524,y:0,width:396,height:760});
  const small=fitBounds({x:1910,y:1020,width:396,height:760},area,true);
  assert.equal(small.height,244);assert.equal(small.y,796);assert.equal(small.x,1524);
});
test('worker replies stay matched during concurrent requests and shutdown waits for preservation',async()=>{
  const worker=new EventEmitter();const sent=[];worker.postMessage=message=>sent.push(message);
  const service=new BackendService('unused',{workerFactory:()=>worker});worker.emit('message',{type:'ready'});
  const a=service.call('current'),b=service.call('history');await new Promise(resolve=>setImmediate(resolve));
  worker.emit('message',{type:'result',id:sent[1].id,value:'history'});worker.emit('message',{type:'result',id:sent[0].id,value:'current'});
  assert.equal(await a,'current');assert.equal(await b,'history');
  let stopped=false;const close=service.close().then(()=>{stopped=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);
  await assert.rejects(service.call('current'),/退出/);
  worker.emit('message',{type:'closed'});await close;assert.equal(stopped,true);
});
test('worker errors reject pending requests instead of leaving refresh spinning',async()=>{
  const worker=new EventEmitter();worker.postMessage=()=>{};
  const service=new BackendService('unused',{workerFactory:()=>worker});worker.emit('message',{type:'ready'});
  const result=service.call('current');await new Promise(resolve=>setImmediate(resolve));worker.emit('error',new Error('test failure'));
  await assert.rejects(result,/test failure/);await assert.rejects(service.call('history'),/test failure/);
});
test('history migration preserves evidence and source bytes, excludes control tokens, and refuses an existing target',async()=>{
  const root=path.join(__dirname,'..','qa','tests',`desktop-history-${Date.now()}`);const source=path.join(root,'source'),target=path.join(root,'target');
  await fs.mkdir(source,{recursive:true});const history=await new History(source).init();const bytes=Buffer.from('verified source');
  await history.record([{id:'sample',title:'sample',sources:[{sha256:sha(bytes)}],tasks:[]}],new Map([[sha(bytes),bytes]]));
  const active=await new History(path.join(source,'active-task-history')).init();
  await active.record([{id:'active-tasks',title:'tasks',sources:[{sha256:sha(bytes)}],tasks:[]}],new Map([[sha(bytes),bytes]]));
  await fs.writeFile(path.join(source,'control-token.txt'),'test-control-value');
  const before=await retainedFiles(source);const result=await copyHistory(source,target,path.join(root,'receipt.json'));
  assert.equal(result.snapshots,1);assert.deepEqual(await retainedFiles(source),before);assert.deepEqual(await retainedFiles(target),before);
  assert.equal(result.activeIntegrity.snapshots,1);assert.equal(result.activeIntegrity.headHash,active.last.hash);
  await assert.rejects(fs.stat(path.join(target,'control-token.txt')),error=>error.code==='ENOENT');
  await assert.rejects(copyHistory(source,target,path.join(root,'second.json')),/已经存在/);
  const next=await new History(target).init();await next.record([],new Map(),'checkpoint');assert.equal(next.last.id,2);assert.equal(next.last.previousHash,history.last.hash);
});
test('damaged window settings are retained and reported',async()=>{
  const file=path.join(__dirname,'..','qa','tests',`desktop-settings-${Date.now()}.json`);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'{broken');
  await assert.rejects(readPreferences(file),/原文件已保留/);assert.equal(await fs.readFile(file,'utf8'),'{broken');
});
test('repeated quit requests cannot skip a pending history flush',async()=>{
  const events=[];let releaseStop;
  const stopping=new Promise(resolve=>{releaseStop=resolve;});
  const shutdown=createShutdown({onStart:()=>events.push('start'),stop:async()=>{events.push('stop');await stopping;},flush:async()=>events.push('flush'),exit:()=>events.push('exit'),onError:error=>{throw error;}});
  const first=shutdown.request();assert.equal(shutdown.request(),first);
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['start','stop']);
  assert.equal(shutdown.request(),first);releaseStop();assert.equal(await first,true);
  assert.deepEqual(events,['start','stop','flush','exit']);
});
test('failed shutdown keeps the process available and permits a deliberate retry',async()=>{
  let attempts=0,exits=0;const errors=[];
  const shutdown=createShutdown({stop:async()=>{if(++attempts===1)throw new Error('still saving');},flush:async()=>{},exit:()=>{exits++;},onError:error=>errors.push(error.message)});
  assert.equal(await shutdown.request(),false);assert.equal(exits,0);assert.deepEqual(errors,['still saving']);
  assert.equal(await shutdown.request(),true);assert.equal(exits,1);
});
test('valid JSON with invalid window geometry is rejected without losing the original file',async()=>{
  const file=path.join(__dirname,'..','qa','tests',`desktop-geometry-${Date.now()}.json`);
  const content=JSON.stringify({schema:'workflow-desktop-window/1',bounds:[],alwaysOnTop:true});
  await fs.writeFile(file,content);await assert.rejects(readPreferences(file),/尺寸格式无效/);assert.equal(await fs.readFile(file,'utf8'),content);
  const centered=fitBounds(undefined,{x:0,y:0,width:1920,height:1080});assert.deepEqual(centered,{x:762,y:160,width:396,height:760});
});
test('expanding a moved compact window restores its full height, not an intermediate minimum size',()=>{
  const full={x:100,y:40,width:396,height:760},area={x:0,y:0,width:1920,height:1080};
  const collapse=compactTransition({compact:false,bounds:full},full,area,true);
  assert.equal(collapse.next.height,244);assert.equal(collapse.full.height,760);
  const expand=compactTransition({compact:true,bounds:collapse.full},{...collapse.next,x:300,y:120},area,false);
  assert.deepEqual(expand.next,{x:300,y:120,width:396,height:760});
});
test('task rail stays anchored on negative-coordinate monitors and fits small work areas',()=>{
  for(const area of [{x:-1920,y:-180,width:1920,height:1040},{x:0,y:0,width:320,height:240}])for(const side of ['left','right'])for(const expanded of [true,false]){
    const bounds=dockBounds(area,{side,expanded,y:9000,count:200});
    assert.ok(bounds.x>=area.x&&bounds.x+bounds.width<=area.x+area.width);
    assert.ok(bounds.y>=area.y&&bounds.y+bounds.height<=area.y+area.height);
    assert.equal(side==='left'?bounds.x:bounds.x+bounds.width,side==='left'?area.x:area.x+area.width);
  }
});
test('dock preferences survive reopen while malformed state is preserved and rejected',async()=>{
  const file=path.join(__dirname,'..','qa','tests','dock-settings-'+Date.now()+'.json');
  await fs.writeFile(file,JSON.stringify({schema:'workflow-desktop-window/1',mainVisible:false,dock:{visible:true,side:'right',x:1812,y:120}}));
  const prefs=await readPreferences(file);assert.equal(prefs.dock.side,'right');assert.equal(prefs.dock.y,120);assert.equal(prefs.mainVisible,false);
  const bad=JSON.stringify({schema:'workflow-desktop-window/1',dock:{side:'outside'}});await fs.writeFile(file,bad);
  await assert.rejects(readPreferences(file),/侧边条位置/);assert.equal(await fs.readFile(file,'utf8'),bad);
});
