'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {Catalog,parseMetadata,scanSkills,scanResource,validateSources} = require('../plugin/catalog.cjs');
const {sha} = require('../plugin/core.cjs');

async function fixture() {
  const parent = path.resolve(__dirname,'../qa/tests'); await fs.mkdir(parent,{recursive:true});
  const root = await fs.mkdtemp(path.join(parent,'catalog-'));
  const codex=path.join(root,'codex'),central=path.join(root,'central'),plugin=path.join(root,'plugin');
  for(const dir of [codex,central,plugin])await fs.mkdir(dir);
  return {root,codex,central,plugin};
}
async function skill(root,folder,text) {const dir=path.join(root,folder);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'SKILL.md'),text);return path.join(dir,'SKILL.md');}
const sample='---\nname: sample\ndescription: "用于测试的真实用途"\n---\n正文只作资料。\n';

test('metadata handles BOM, CRLF, folded descriptions and quoted text without treating the body as metadata',()=>{
  const result=parseMetadata('\uFEFF---\r\nname: sample\r\ndescription: >-\r\n  第一行用途\r\n  第二行用途\r\ndisplay_name: "测试 \\"别名\\""\r\n---\r\nname: do-not-run\r\n');
  assert.equal(result.name,'sample');assert.equal(result.description,'第一行用途 第二行用途');
  assert.equal(parseMetadata('# body only').name,undefined);
  assert.equal(parseMetadata('---\nname: example\ndescription: \'one \'\'quote\'\'\'\n---').description,"one 'quote'");
});

test('deployment copies merge, distinct plugin names and differing deployments remain separate, backup shells are excluded',async()=>{
  const f=await fixture();await skill(f.codex,'a',sample);await skill(f.central,'a',sample);await skill(f.plugin,'a',sample);
  await skill(f.central,'different',sample.replace('真实用途','不同用途'));await skill(f.codex,'.backup',sample);
  await fs.mkdir(path.join(f.codex,'empty'));const issues=[];
  const result=await scanSkills([{id:'c',kind:'codex',path:f.codex},{id:'s',kind:'central',path:f.central},{id:'p',kind:'plugin',namespace:'p',path:f.plugin}],issues);
  assert.equal(result.records.length,3);assert.equal(result.copies,4);assert.equal(result.ignored,1);assert.deepEqual(issues,[]);
  assert.equal(result.records.find(item=>item.sourceKind==='codex').locations.length,2);
  assert.equal(result.records.find(item=>item.sourceKind==='plugin').callName,'p:sample');
  assert.ok(result.records.filter(item=>item.managed).every(item=>item.invocationNote.includes('内容不同')));
  assert.ok(result.records.every(item=>item.prompt.includes('sample')));
});

test('an unconfigured junction cannot make the skill scanner read another directory',async()=>{
  const f=await fixture();const outside=path.join(f.root,'outside');await skill(outside,'hidden',sample);
  await fs.symlink(path.join(outside,'hidden'),path.join(f.codex,'redirect'),'junction');
  const issues=[];const result=await scanSkills([{id:'c',kind:'codex',path:f.codex}],issues);
  assert.equal(result.records.length,0);assert.ok(issues.some(value=>value.includes('超出')));
});

test('resource subpaths and junctions cannot escape the configured collection',async()=>{
  const f=await fixture();await fs.writeFile(path.join(f.root,'outside.md'),'not a resource');
  const outside=path.join(f.root,'other');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'file.txt'),'not a resource');
  await fs.symlink(outside,path.join(f.codex,'escape'),'junction');
  const resource=await scanResource({id:'r',title:'资料',path:f.codex,pinned:[{path:'../outside.md'},{path:'escape/file.txt'}],browse:true});
  assert.equal(resource.available,true);assert.equal(resource.parts.length,0);assert.match(resource.note,/暂不可读/);
  assert.throws(()=>validateSources({schema:'workflow-catalog-sources/1',skillRoots:[],resources:[{id:'r',path:'relative'}]}),/绝对/);
});

async function libraryFixture() {
  const f=await fixture();const lib=path.join(f.root,'assets','library');await fs.mkdir(lib,{recursive:true});await fs.writeFile(path.join(lib,'library.blend'),'fixture, not Blender data');
  const data={schema:'white-model-pose-library/1',version:'3.2',motions:[{id:'back_flip',kind:'motion',label:'后空翻',category:'翻滚',duration_seconds:3,continuity_status:'review_required',continuity_review_window_count:2}],poses:[{id:'stand',label:'站姿',category:'日常'}],validation_scope:'样例只供目录验证'};
  const bytes=JSON.stringify(data);await fs.writeFile(path.join(lib,'catalog.json'),bytes);
  const registry={schema:'white_replay.native_releases.v1',default_release:'new',releases:[{id:'old',status:'released',files:{}},{id:'new',status:'released',files:{catalog:{path:'assets/library/catalog.json',sha256:sha(bytes)},blend:{path:'assets/library/library.blend'}}}]};
  await fs.writeFile(path.join(f.root,'registry.json'),JSON.stringify(registry));
  return {...f,lib,definition:{id:'motions',title:'动作库',path:f.root,adapter:'white-library',registry:'registry.json',skills:['blender-expert-suite'],workflows:['white'],prompt:'生成独立候选'}};
}
test('motion entries follow the registered default and retain per-item review requirements; mismatched indexes fail closed',async()=>{
  const f=await libraryFixture();let resource=await scanResource(f.definition);
  assert.equal(resource.available,true);assert.equal(resource.library.release,'new');assert.equal(resource.library.motions,1);assert.equal(resource.library.poses,1);
  assert.equal(resource.library.entries[0].windows,2);assert.match(resource.summary,/待复核/);
  await fs.appendFile(path.join(f.lib,'catalog.json'),' ');resource=await scanResource(f.definition);
  assert.equal(resource.available,false);assert.equal(resource.library,null);assert.match(resource.issue,/哈希不符/);
});

test('manual scans are cached, changes create new immutable inventories, exports retain invocation text and opening requires an exact registered ID',async()=>{
  const f=await fixture();const file=await skill(f.codex,'a',sample);const sources=path.join(f.root,'sources.json');
  await fs.writeFile(sources,JSON.stringify({schema:'workflow-catalog-sources/1',skillRoots:[{id:'c',kind:'codex',path:f.codex}],resources:[],scope:'测试范围'}));
  const catalog=new Catalog(path.join(f.root,'data'));const first=await catalog.get(sources);const original=await fs.readFile(first.archiveFile);
  await fs.writeFile(file,sample.replace('真实用途','更新用途'));
  assert.equal((await catalog.get(sources)).fingerprint,first.fingerprint);
  const second=await catalog.get(sources,true);assert.notEqual(second.fingerprint,first.fingerprint);assert.deepEqual(await fs.readFile(first.archiveFile),original);
  assert.equal(await catalog.resolveTarget({kind:'skill',id:second.skills[0].id}),file);
  await assert.rejects(catalog.resolveTarget({kind:'skill',id:'../../other',path:f.root}),/不存在/);
  await assert.rejects(catalog.resolveTarget({kind:'skill',id:second.skills[0].id,part:'../../other'}),/未登记/);
  const output=await catalog.export();const markdown=await fs.readFile(output.path,'utf8');assert.match(markdown,/使用 \$sample/);assert.match(markdown,/更新用途/);
  const restarted=new Catalog(path.join(f.root,'data'));assert.equal((await restarted.get(sources)).fingerprint,second.fingerprint);
  await fs.writeFile(second.archiveFile,'{"fingerprint":"tampered"}');await assert.rejects(restarted.get(sources,true),/校验失败/);
  assert.equal(await fs.readFile(second.archiveFile,'utf8'),'{"fingerprint":"tampered"}');
});

test('a registered resource whose root junction changes is not opened as the old target',async()=>{
  const f=await fixture();const one=path.join(f.root,'one'),two=path.join(f.root,'two'),link=path.join(f.root,'link');await fs.mkdir(one);await fs.mkdir(two);await fs.symlink(one,link,'junction');
  const source=path.join(f.root,'sources.json');await fs.writeFile(source,JSON.stringify({schema:'workflow-catalog-sources/1',skillRoots:[],resources:[{id:'r',title:'目录',path:link}]}));
  const catalog=new Catalog(path.join(f.root,'data'));await catalog.get(source);await fs.unlink(link);await fs.symlink(two,link,'junction');
  await assert.rejects(catalog.resolveTarget({kind:'resource',id:'r'}),/来源路径已变化/);
});
