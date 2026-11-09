'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {TaskFeed,collectTasks,STAGE_IDS} = require('./tasks.cjs');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const MAX_SOURCE = 2 * 1024 * 1024;
const STAGES = {source: '输入检查', shots: '分镜', observations: '人物观察', scene: '场景与相机', library: '动作候选', solve: '动作求解', build: '工程生成', render: '渲染', package: '交付整理', review: '保存工程检查'};
const nowIso = () => new Date().toISOString();
function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}
function validRun(run) {
  return typeof run === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(run) && !run.includes('..');
}
function dateValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  if (typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return null;
}
function stateCard(id, title, root) {
  return {id, title, root, project: root ? path.basename(root) : '尚未关联工程', state: root ? 'unknown' : 'unconfigured', stateLabel: root ? '读取中' : '待关联', phase: root ? '正在读取项目记录' : '关联工程后开始观察', summary: '', updatedAt: null, progress: null, facts: [], issues: [], sources: [], activities: []};
}
class Reader {
  constructor() {this.evidence = new Map();}
  async read(root, relative, {tail = false, optional = false, json = false, role = relative} = {}) {
    const file = path.resolve(root, relative);
    if (!inside(root, file)) throw new Error('状态路径超出已关联项目');
    let handle;
    try {
      // Resolve links before reading. A source cannot redirect into another project.
      const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
      if (!inside(realRoot, realFile)) throw new Error('状态文件链接指向项目之外');
      handle = await fs.open(file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('状态来源不是普通文件');
      if (!tail && stat.size > MAX_SOURCE) throw new Error('状态文件超过 2 MiB，未读取');
      const limit = tail ? 128 * 1024 : MAX_SOURCE;
      const start = Math.max(0, stat.size - limit);
      let bytes = Buffer.alloc(Math.min(stat.size, limit));
      const read = await handle.read(bytes, 0, bytes.length, start);
      bytes = bytes.subarray(0, read.bytesRead);
      if (start > 0) { const line = bytes.indexOf(10); bytes = line < 0 ? Buffer.alloc(0) : bytes.subarray(line + 1); }
      const after = await handle.stat();
      if (stat.mtimeMs !== after.mtimeMs || stat.size !== after.size) throw new Error('源文件正在更新，等待下次读取');
      const digest = sha(bytes);
      const source = {path: file, role, sha256: digest, bytes: bytes.length, modifiedAt: stat.mtime.toISOString(), scope: start > 0 ? '文件末尾，最多 128 KiB' : '完整文件'};
      this.evidence.set(digest, bytes);
      const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
      let value = text;
      if (json) {try {value = JSON.parse(text);} catch {return {source, error: '状态 JSON 暂时不可读，保留上次历史供核对'};}}
      return {source, value};
    } catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      return {error: error.code === 'ENOENT' ? '尚未找到状态文件' : error.code === 'EACCES' ? '无权读取状态文件' : error.message, path: file};
    } finally {await handle?.close();}
  }
}
function addSource(card, record) {if (record?.source && !card.sources.some(s => s.path === record.source.path && s.sha256 === record.source.sha256)) card.sources.push(record.source); if (record?.error && !card.issues.includes(record.error)) card.issues.push(record.error);}
function reportStatus(card, report, source) {
  const names = {running: '进行中', waiting: '待确认', blocked: '受阻', rework: '需返修', complete: '已完成', partial: '部分完成', paused: '已暂停', idle: '暂无任务'};
  card.state = Object.hasOwn(names, report.state) ? report.state : 'unknown';
  card.stateLabel = names[card.state] || '状态未登记';
  card.project = String(report.project || card.project).slice(0, 100);
  card.phase = String(report.stage || '阶段未登记').slice(0, 120);
  card.summary = String(report.summary || '').slice(0, 400);
  card.updatedAt = dateValue(report.updatedAt) || source.modifiedAt;
  if (card.state === 'running' && Date.now() - Date.parse(card.updatedAt) > 120000) {card.state = 'stale'; card.stateLabel = '运行状态待同步';}
  const p = report.progress;
  if (p && Number.isSafeInteger(p.completed) && Number.isSafeInteger(p.total) && p.total > 0 && p.completed >= 0 && p.completed <= p.total) {
    card.progress = {completed: p.completed, total: p.total, unit: String(p.unit || '项').slice(0, 20), label: String(p.label || '已登记进度').slice(0, 40)};
  }
  if (Array.isArray(report.issues)) card.issues.push(...report.issues.slice(0, 8).map(x => String(x).slice(0, 300)));
  if (Array.isArray(report.facts)) card.facts.push(...report.facts.slice(0, 8).map(x => String(x).slice(0, 200)));
  // A writer's complete flag does not establish visual or user acceptance.
  if (card.state === 'complete') {
    const accepted = report.acceptance?.user === true && report.acceptance?.visual === true;
    card.state = accepted ? 'accepted' : 'produced';
    card.stateLabel = accepted ? '已登记验收' : '制作步骤完成';
    card.facts.push(accepted ? '来源明确登记了视觉与用户验收' : '视觉与用户验收尚未同时登记');
  }
}
async function generic(reader, card) {
  if (!card.root) return false;
  const report = await reader.read(card.root, 'workflow-progress.json', {json: true, optional: true, role: '项目统一进度'});
  if (!report) return false;
  addSource(card, report);
  if (!report.error && report.value?.schema === 'workflow-progress/1') {
    reportStatus(card, report.value, report.source);
    if(card.custom){
      const ids=new Set();
      card.reportTasks=(Array.isArray(report.value.tasks)?report.value.tasks:[]).slice(0,100).flatMap(item=>{
        if(typeof item.id!=='string'||!item.id||item.id.length>100||ids.has(item.id)){card.issues.push('进度记录中有无效或重复的小任务 ID，已略过该项');return [];}
        ids.add(item.id);const stage=card.workflow.stages.find(stage=>stage.id===item.stage);
        const labels={running:'来源登记：进行中',waiting:'来源登记：等待中',blocked:'来源登记：受阻',complete:'来源登记：步骤完成',pending:'来源登记：待开始'};
        const title=String(item.title||item.id).slice(0,160),detail=String(item.detail||'尚无说明').slice(0,2000),updatedAt=dateValue(item.updatedAt)||card.updatedAt;
        return [{id:`${card.id}:progress:${item.id}`,threadId:null,title,focus:stage?`环节：${stage.label}`:'进度文件中的小任务，环节未登记',workflow:card.id,stages:stage?[stage.id]:[],projectRoot:card.root,linkedAt:card.workflow.updatedAt,messages:[],items:[{id:item.id,title,detail,stages:stage?[stage.id]:[],stateLabel:labels[item.state]||'已有进度记录',updatedAt,sourcePath:report.source.path,sourceHash:report.source.sha256}],sources:[report.source],issues:[],updatedAt,latestText:detail,session:{status:'reported'},reportedLabel:labels[item.state]||'已有进度记录'}];
      });
    }
  }
  else {card.state = 'error'; card.stateLabel = '状态读取异常'; card.phase = '请检查统一进度记录'; if (!report.error) card.issues.push('需要 workflow-progress/1 数据格式');}
  return true;
}
async function white(reader, settings) {
  const card = stateCard('white', '白模复刻', settings.whiteRoot);
  if (!card.root || await generic(reader, card)) return card;
  const run = settings.whiteRun;
  if (!validRun(run)) {card.state = 'error'; card.stateLabel = '入口未配置'; card.phase = '请选择要观察的运行入口'; return card;}
  card.project = `${path.basename(card.root)} · ${run}`;
  const prefix = `runs/${run}`;
  const status = await reader.read(card.root, `${prefix}/status.json`, {json: true, role: '当前入口阶段记录'});
  const events = await reader.read(card.root, `${prefix}/events.jsonl`, {tail: true, optional: true, role: '当前入口运行事件'});
  addSource(card, status); addSource(card, events);
  if (status.error) {card.state = 'error'; card.stateLabel = '记录不可用'; card.phase = status.error; return card;}
  const stages = status.value.stages;
  const entries = stages && typeof stages === 'object' ? Object.entries(stages) : [];
  const done = entries.filter(([, v]) => v?.state === 'complete');
  const activity = String(events?.value || '').trim().split('\n').slice(-80).flatMap(line => {try {const v = JSON.parse(line); return v && typeof v.stage === 'string' ? [v] : [];} catch {return [];}});
  const last = activity.at(-1);
  const stageName = (last?.stage || entries.at(-1)?.[0] || '').split('/');
  card.phase = stageName[0] ? `${STAGES[stageName[0]] || stageName[0]}${stageName[1] ? ` · ${stageName[1]}` : ''}` : '尚无阶段记录';
  card.updatedAt = dateValue(last?.time) || dateValue(status.value.updated) || status.source.modifiedAt;
  const eventNames = {start: '启动', complete: '完成', reuse: '复用', error: '失败', fail: '失败', failed: '失败'};
  card.activities = activity.slice(-6).reverse().map(e => ({label: `${eventNames[e.event] || e.event} · ${e.stage}`, time: dateValue(e.time)}));
  if (['error', 'fail', 'failed'].includes(last?.event)) {card.state = 'blocked'; card.stateLabel = '记录到失败';}
  else if (last?.event === 'start') {card.state = Date.now() - Date.parse(card.updatedAt) < 120000 ? 'running' : 'stale'; card.stateLabel = card.state === 'running' ? '最近启动' : '运行状态待同步';}
  else {card.state = 'recorded'; card.stateLabel = '阶段已记录';}
  card.summary = '显示所选入口最近一次命令；独立脚本与整片审片可能另有记录。';
  card.facts.push(`本入口登记了 ${done.length} 项完成阶段`);
  card.facts.push('全片视觉与用户验收：此来源未提供');
  card.issues.push('没有可靠的全片任务总数，暂不计算完成百分比');
  return card;
}
async function eagle(reader, settings) {
  const card = stateCard('eagle', 'Eagle 参考与剪辑', settings.eagleRoot);
  if (!card.root || await generic(reader, card)) return card;
  card.project = `${path.basename(card.root)} · 参考与剪辑`;
  const report = await reader.read(card.root, 'commercial/current-validation.json', {json: true, role: '当前交付与验收记录'});
  const continuation = await reader.read(card.root, 'commercial/本轮成果与继续入口.md', {optional: true, role: '当前继续入口与历史说明'});
  addSource(card, report); addSource(card, continuation);
  if (report.error) {card.state = 'error'; card.stateLabel = '记录不可用'; card.phase = report.error; return card;}
  const v = report.value;
  card.updatedAt = dateValue(v.updated_at) || report.source.modifiedAt;
  const headline = String(continuation?.value || '').split('\n').find(line => /^#\s+/.test(line));
  card.phase = headline?.replace(/^#\s+/, '').trim().slice(0, 120) || '查看当前制作与验收记录';
  card.state = v.goal_complete === true ? 'produced' : 'partial';
  card.stateLabel = v.goal_complete === true ? '来源登记完成' : '部分完成';
  const local = v.local_workflow_optimization;
  if (local?.offline_render_verified === true) card.facts.push('本机试听与离线导出：已登记检查通过');
  if (local?.native_import_verified === false) card.facts.push('最新试听结果回到 Resolve：尚未验证');
  if (v.blockers?.aesthetic_acceptance) {card.state = 'waiting'; card.stateLabel = '待听感确认'; card.issues.push('最新声音版本仍待用户试听确认');}
  if (v.blockers?.different_computer_toolkit) card.facts.push('异机安装与验收另行记录，不计入本机进度');
  card.summary = '从现有交付记录读取；技术检查和用户听感分别显示。';
  if (card.phase.includes('完成') && card.state !== 'accepted') card.facts.push('标题中的“完成”仅对应所述局部工作');
  return card;
}
async function workflowConstruction(reader, cards, settings) {
  const [e, w, c] = cards;
  const read = async (card, root, file, opts) => {if (!root) return null; const record = await reader.read(root, file, {optional: true, ...opts}); addSource(card, record); return record;};
  const [evidence, whiteGuide, historicalRun, carGuide, carShots, carRender] = await Promise.all([
    read(e, settings.eagleRoot, 'commercial/current-validation.json', {json: true, role: '当前交付与验收记录'}),
    read(w, settings.whiteRoot, 'pipeline/README.md', {role: '白模流程建设说明'}),
    read(w, settings.whiteRoot, 'runs/wind_song_pipeline_v1/status.json', {json: true, role: '历史入口技术运行记录'}),
    read(c, settings.carFlowRoot, 'SKILL.md', {role: '汽车动画复刻工作流规范'}),
    read(c, settings.carFlowRoot, 'references/shot-plan.md', {role: '汽车分镜与状态规范'}),
    read(c, settings.carFlowRoot, 'assets/render-job.template.json', {json: true, role: '汽车受控渲染任务模板'})
  ]);
  const stage = (label, known, pending = false) => ({label, state: pending ? 'pending' : known ? 'recorded' : 'defined', stateLabel: pending ? '待完善' : known ? '有验证记录' : '已定义'});
  const v = evidence && !evidence.error ? evidence.value : null;
  e.workflow = {
    stateLabel: v ? '主链有验证，继续优化' : '建设记录待接入',
    summary: v ? '参考、归档与本机剪辑已有检查记录；声音与人工验收继续完善。' : '等待流程建设与验证记录。',
    defined: Boolean(v), updatedAt: evidence?.source?.modifiedAt || null,
    stages: v ? [stage('参考获取', v.source_quality?.full_decode_verified), stage('Eagle 归档', v.eagle?.repeat_import_verified), stage('原生剪辑', v.resolve?.import_verified), stage('字幕与声音', v.native_caption_acceptance?.status === 'native_helper_same_machine_acceptance_passed'), stage('导出与重开', v.resolve?.native_render?.same_machine_drp_reopen_render_verified), stage('人工审听', false, !v.resolve?.native_render?.listening_verified)] : [],
    note: '验证记录对应已做过的样例和版本；其他素材及异机仍需各自检查。'
  };
  const historical = historicalRun && !historicalRun.error ? historicalRun.value.stages || {} : {};
  const seen = new Set(Object.entries(historical).filter(([, value]) => value?.state === 'complete').map(([key]) => key.split('/')[0]));
  const hasWhiteDefinition = Boolean(whiteGuide?.source && !whiteGuide.error);
  w.workflow = {
    stateLabel: seen.size ? '基础可运行，匹配待优化' : hasWhiteDefinition ? '流程已定义' : '建设记录待接入',
    summary: seen.size ? '输入到出片有技术运行记录；动作、接触与精确匹配仍需持续修正。' : '读取白模制作流程规范与检查记录。',
    defined: hasWhiteDefinition, updatedAt: whiteGuide?.source?.modifiedAt || null,
    stages: hasWhiteDefinition ? [stage('输入与拆镜', seen.has('source') && seen.has('shots')), stage('人物观察', seen.has('observations')), stage('场景与相机', seen.has('scene')), stage('动作制作', seen.has('build')), stage('渲染交付', seen.has('render')), stage('精确复刻验收', false, true)] : [],
    note: '技术记录含历史入口，不代表当前人物版本或整片视觉已通过。下方单独显示当前任务入口。'
  };
  const hasCarDefinition = Boolean(carGuide?.source && !carGuide.error);
  c.workflow = {
    stateLabel: hasCarDefinition ? '规范已整理，执行待验证' : '流程规范待读取',
    summary: hasCarDefinition ? '已有汽车镜头复刻、分镜与受控渲染规范；当前执行验收尚未接入。' : '未找到汽车动画复刻规范。',
    defined: hasCarDefinition, updatedAt: carGuide?.source?.modifiedAt || null,
    stages: hasCarDefinition ? ['参考拉片', '资产与绑定', '运镜与车辆', '白模对照', '渲染交付', '重开验收'].map(label => ({label, state: 'defined', stateLabel: '已定义'})) : [],
    note: `${carShots?.source ? '镜头表规范已找到。' : ''}${carRender?.source ? '渲染任务模板已找到。' : ''}规范文件存在不等于已在当前任务中验证。`
  };
  if (!c.root) {c.project = '汽车动画复刻流程'; c.state = 'idle'; c.stateLabel = '暂无执行记录'; c.phase = '当前任务尚未上报'; c.summary = '流程已纳入观察；有执行记录时在这里显示，不要求先指定固定工程。';}
}
async function collect(settings, {taskFeed = new TaskFeed(),customWorkflows=[],additionalLinks=[],discoveryIssues=[]} = {}) {
  const reader = new Reader();
  const [e, w] = await Promise.all([eagle(reader, settings), white(reader, settings)]);
  const car = stateCard('car', '汽车动画复刻', settings.carRoot);
  if (settings.carRoot && !await generic(reader, car)) {car.state = 'unreported'; car.stateLabel = '待接入记录'; car.phase = '已关联工程，尚无统一进度'; car.summary = '需要 workflow-progress.json；不会从模型文件数量推算进度。';}
  await workflowConstruction(reader, [e, w, car], settings);
  const custom=[];
  for(const flow of customWorkflows.filter(flow=>!flow.paused)){
    const card=stateCard(flow.id,flow.title,flow.root);card.custom=true;card.skillIds=flow.skillIds;card.resourceIds=flow.resourceIds;
    card.workflow={defined:true,stateLabel:'自定义流程已登记',summary:'环节表示流程定义；下方任务保留各自的执行记录。',updatedAt:flow.updatedAt,stages:flow.stages.map(stage=>({...stage,state:'defined',stateLabel:'已定义'})),note:flow.autoDiscover?'按工程目录精确关联最近的本机聊天，每 60 秒发现新增；任务内容每 15 秒读取。':'按指定聊天与工程进度文件读取。'};
    if(!await generic(reader,card)){card.state='unreported';card.stateLabel='待接入记录';card.phase=flow.root?'等待工程进度或关联聊天':'尚未关联执行来源';card.summary='填写工程目录或聊天 ID 后持续更新；进度文件为 workflow-progress.json。';}
    card.issues.push(...discoveryIssues.filter(item=>item.flow===flow.id).map(item=>item.message));custom.push(card);
  }
  const cards=[e,w,car,...custom];
  const linked = await collectTasks(reader,settings,taskFeed,additionalLinks);
  for(const card of cards){
    card.tasks=[...linked.tasks.filter(task=>task.workflow===card.id),...(card.reportTasks||[])];delete card.reportTasks;
    for(const source of linked.sources)addSource(card,{source});
    for(const task of card.tasks)for(const source of task.sources)addSource(card,{source});
    for(const issue of linked.issues)card.issues.push(`任务关联：${issue}`);
    card.workflow?.stages.forEach((stage,index)=>{stage.id=stage.id||STAGE_IDS[card.id]?.[index];stage.taskCount=card.tasks.filter(task=>task.stages.includes(stage.id)).length;});
    if(card.custom&&card.tasks.length&&card.state==='unreported'){card.state='linked';card.stateLabel=`已关联 ${card.tasks.length} 个任务`;card.phase='从关联聊天持续读取进展';}
  }
  if(car.tasks.length&&!car.root){car.state='linked';car.stateLabel=`已关联 ${car.tasks.length} 个任务`;car.phase='汽车流程已有任务进展';car.summary='按环节查看关联聊天与实际报告；单项完成不代表整个汽车流程验收通过。';car.workflow.stateLabel='规范已整理，已关联执行任务';car.workflow.summary='已接入汽车镜头复刻和拉片任务；建设记录与各任务的实际进展分开显示。';}
  // Parallel file reads must not create history solely because they finish in a different order.
  for (const card of cards) {card.sources.sort((a, b) => a.path.localeCompare(b.path) || a.role.localeCompare(b.role)); card.issues.sort();}
  return {projects: cards, evidence: reader.evidence,liveTasks:linked.live};
}
async function validateConfig(input) {
  const keys = ['eagleRoot', 'whiteRoot', 'whiteRun', 'carRoot', 'carFlowRoot','taskLinksFile','codexSessionsRoot','catalogFile','managerRoot','managerApp'];
  if (!input || Object.keys(input).some(key => !keys.includes(key))) throw new Error('包含不支持的配置项');
  const result = {};
  for (const key of keys) {
    result[key] = String(input[key] || '').trim();
    if (result[key].length > 512 || /[\x00-\x1f]/.test(result[key])) throw new Error('目录字段含无效字符');
    if (key === 'whiteRun') {if (!validRun(result[key])) throw new Error('运行入口应是 runs 下的一个目录名'); continue;}
    if (result[key]) {
      if (!path.isAbsolute(result[key])) throw new Error('请选择绝对工程目录');
      const stat=await fs.stat(result[key]);
      if(key==='managerApp'){if(!stat.isFile()||path.basename(result[key]).toLocaleLowerCase()!=='skills-manager.exe')throw new Error('请选择 Skills Manager 的 skills-manager.exe');}
      else if(key==='taskLinksFile'||key==='catalogFile'){if(!stat.isFile()||!result[key].endsWith('.json'))throw new Error('请选择关联清单 JSON 文件');}
      else if(!stat.isDirectory())throw new Error('所选路径不是工程目录');
      result[key] = path.resolve(result[key]);
    }
  }
  return result;
}
module.exports = {canonical, sha, inside, validRun, collect, validateConfig, Reader, nowIso};
