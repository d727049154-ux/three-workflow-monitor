'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {inside, sha, canonical, nowIso} = require('./core.cjs');
const {describeSkill, invocationFor} = require('./catalog-guide.cjs');

const MAX_META = 512 * 1024;
const MAX_INDEX = 4 * 1024 * 1024;
const SKIP = /^(?:\.|__pycache__$|node_modules$|backups?$|runtime_cache$|site-packages$)/i;
const DISPLAY_FILE = /\.(?:md|txt|pdf|html|blend|max|fbx|obj|abc|usd[acz]?|glb|gltf|ply|stl|bvh|mat|vrmat|vdb|ies|uasset|uproject|uplugin|drp|otio[dz]?|mp4|mov|mkv|avi|wav|mp3|flac|png|jpe?g|webp|tiff?|tga|exr|hdr|dds|psd|svg|zip|7z|rar|csv|json|ya?ml|toml|ini|docx?|xlsx?|pptx?|pyw?|cjs|mjs|js|ps1|cmd|bat|vbs|ms|mcr|exe|onnx|safetensors)$/i;
const clean = (value, max = 600) => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, max);
const normalized = value => path.resolve(value).toLowerCase();
const labels = {codex: 'Codex 技能目录', central: '中央技能库', system: '系统技能文件', plugin: '插件技能文件'};

// Read just the small, displayable YAML fields; skill bodies are never executed.
function parseMetadata(text) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
  if (lines[0]?.trim() !== '---') return {};
  const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end < 0) return {};
  const result = {};
  for (let i = 1; i < end; i++) {
    const match = /^(name|display_name|description|version|category):\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    let value = match[2].trim();
    if (/^[|>][-+]?\s*$/.test(value)) {
      const block = [];
      while (i + 1 < end && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim());
      value = block.join(' ');
    } else if (/^["']/.test(value)) {
      const quote = value[0];
      while (!value.endsWith(quote) && i + 1 < end && /^\s/.test(lines[i + 1])) value += ` ${lines[++i].trim()}`;
      if (value.endsWith(quote)) {
        if (quote === '"') {try {value = JSON.parse(value);} catch {value = value.slice(1, -1);}}
        else value = value.slice(1, -1).replace(/''/g, "'");
      }
    }
    result[match[1]] = clean(value, match[1] === 'description' ? 1800 : 160);
  }
  return result;
}

async function boundedText(file, limit = MAX_META) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw new Error('目录文件过大或不是普通文件');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const {bytesRead} = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('来源正在更新，请稍后重新扫描');
    return {text: bytes.toString('utf8').replace(/^\uFEFF/, ''), sha256: sha(bytes), modifiedAt: before.mtime.toISOString()};
  } finally {await handle?.close();}
}

function validateSources(value) {
  if (value?.schema !== 'workflow-catalog-sources/1' || !Array.isArray(value.skillRoots) || !Array.isArray(value.resources)) throw new Error('技能资源关联清单格式不正确');
  if (value.skillRoots.length > 32 || value.resources.length > 100) throw new Error('关联范围超过上限');
  const ids = new Set();
  for (const item of [...value.skillRoots, ...value.resources]) {
    if (!item || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)) throw new Error('目录条目 ID 无效或重复');
    ids.add(item.id);
    if (typeof item.path !== 'string' || !path.isAbsolute(item.path) || /[\x00-\x1f]/.test(item.path)) throw new Error('目录关联需要绝对路径');
  }
  for (const root of value.skillRoots) if (!Object.hasOwn(labels, root.kind)) throw new Error('技能来源类型无效');
  for (const resource of value.resources) {
    for (const key of ['workflows','skills']) if (resource[key] !== undefined && (!Array.isArray(resource[key]) || resource[key].some(item => typeof item !== 'string'))) throw new Error('资源分类需要字符串列表');
    if (resource.pinned !== undefined && (!Array.isArray(resource.pinned) || resource.pinned.length > 80 || resource.pinned.some(item => !item || typeof item.path !== 'string'))) throw new Error('资源固定文件列表无效');
  }
  return value;
}

async function checkedPath(root, relative = '') {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('资源子路径必须相对');
  const target = path.resolve(root, relative);
  if (!inside(root, target)) throw new Error('资源路径越界');
  const [realRoot, realPath, stat] = await Promise.all([fs.realpath(root), fs.realpath(target), fs.stat(target)]);
  if (!inside(realRoot, realPath)) throw new Error('资源链接指向目录之外');
  return {path: target, realPath, kind: stat.isDirectory() ? 'directory' : 'file', bytes: stat.isFile() ? stat.size : null, modifiedAt: stat.mtime.toISOString()};
}

async function scanSkills(roots, issues) {
  const availableRoots = [];
  for (const root of roots) {
    try {availableRoots.push({...root, realPath: await fs.realpath(root.path)});}
    catch {issues.push(`${root.label || root.id}：目录不可读`);}
  }
  const records = [];
  let copies = 0, ignored = 0;
  for (const root of availableRoots) {
    let dirs;
    try {dirs = await fs.readdir(root.path, {withFileTypes: true});}
    catch {issues.push(`${root.label || root.id}：无法列出技能`); continue;}
    if (dirs.length > 512) issues.push(`${root.label || root.id}：只检查前 512 个一级目录`);
    for (const dir of dirs.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 512)) {
      if (SKIP.test(dir.name) || (!dir.isDirectory() && !dir.isSymbolicLink())) continue;
      const file = path.join(root.path, dir.name, 'SKILL.md');
      let realPath, metadata;
      try {
        realPath = await fs.realpath(file);
        if (!availableRoots.some(r => inside(r.realPath, realPath))) throw new Error('技能链接超出配置的技能根');
        metadata = await boundedText(file);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') ignored++;
        else issues.push(`${root.label || root.id}/${dir.name}：${error.message}`);
        continue;
      }
      const meta = parseMetadata(metadata.text);
      if (!meta.name || !/^[\p{L}\p{N}_.:-]+$/u.test(meta.name)) {ignored++; continue;}
      copies++;
      const managed = root.kind === 'central' || root.kind === 'codex';
      const callName = root.namespace ? `${root.namespace}:${meta.name}` : meta.name;
      // Deployment copies collapse; same-named skills from different plugins do not.
      const duplicate = records.find(r => (normalized(r.realPath) === normalized(realPath) && r.namespace === (root.namespace || '')) || (managed && r.managed && r.name === meta.name && r.sha256 === metadata.sha256));
      const location = {label: root.label || labels[root.kind], kind: root.kind, path: file, realPath};
      if (duplicate) {duplicate.locations.push(location); continue;}
      const guide = describeSkill(meta, root);
      const supports = [];
      const skillRoot = path.dirname(realPath);
      for (const [relative, label] of [['技能说明.zh-CN.md', '中文说明'], ['references', '参考资料'], ['scripts', '配套脚本'], ['assets', '素材与模板'], ['templates', '模板'], ['guides', '专题指南'], ['docs', '配套文档'], ['examples', '示例'], ['rules', '规则配方']]) {
        try {supports.push({id: relative, label, ...await checkedPath(skillRoot, relative)});} catch {}
      }
      const topicNames = {'animation':'动画与关键帧','expert':'三维制作总纲','geometry-nodes':'几何节点','grease-pencil':'蜡笔与二维动画','hair':'毛发与曲线','hard-surface':'硬表面建模','lighting-rendering':'灯光与渲染','previs-storyboard':'预演与分镜','retopology':'重拓扑','rigging':'绑定与控制器','sculpting':'雕刻','texturing-shading':'材质与着色','uv-baking':'UV 与烘焙','video-reconstruction':'视频白模复刻'};
      if(meta.name==='blender-expert-suite')for(const [suffix,label] of Object.entries(topicNames)) {
        const relative=`scenario-blender-${suffix}/GUIDE.md`;
        try {const target=await checkedPath(skillRoot,relative);supports.push({id:relative,label,topic:true,...target,prompt:`使用 $blender-expert-suite，按「${label}」专题处理 [具体目标]，工程和资料在 [路径]。\n专题指南：${target.path}`});}catch{}
      }
      const record = {
        id: `skill-${sha(`${root.namespace || 'local'}|${realPath}`).slice(0, 20)}`,
        name: meta.name, callName, title: guide.title, description: guide.description || meta.description || '说明文件未提供简介，可定位 SKILL.md 查看。',
        category: guide.category, workflows: guide.workflows, version: meta.version || '',
        namespace: root.namespace || '', sourceKind: root.kind, sourceLabel: root.label || labels[root.kind],
        path: file, realPath, sha256: metadata.sha256, modifiedAt: metadata.modifiedAt,
        locations: [location], supports, managed, prompt: invocationFor(meta, root, file, guide),
        invocationNote: root.kind === 'plugin' ? '插件文件已找到；可在支持该插件的聊天选择技能，也可按此完整路径读取说明。' : root.kind === 'system' ? '系统文件已找到；当前聊天是否提供此入口，以技能选择列表为准。' : root.kind === 'central' ? '中央库文件已找到，未发现对应的 Codex 部署副本；调用时可附此说明文件。' : '在对应项目的 Codex 聊天输入；需要软件或在线服务时再检查连接。'
      };
      records.push(record);
    }
  }
  const groupedNames = new Map();
  for (const record of records.filter(r => r.managed)) {
    const group = groupedNames.get(record.name) || []; group.push(record); groupedNames.set(record.name, group);
  }
  for (const group of groupedNames.values()) if (group.length > 1) for (const record of group) record.invocationNote += ' 同名的中央库与部署内容不同，已分开列出。';
  const primary = ['skill-router','eagle-reference-edit','blender-expert-suite','blender-automotive-shot-recreation','automotive-shot-analysis','car-render-pipeline'];
  const rank = record => record.sourceKind === 'codex' && primary.includes(record.name) ? primary.indexOf(record.name) : 100;
  records.sort((a, b) => rank(a) - rank(b) || a.category.localeCompare(b.category, 'zh-CN') || a.title.localeCompare(b.title, 'zh-CN'));
  return {records, copies, ignored};
}

async function libraryIndex(resource, definition) {
  const registryTarget = await checkedPath(definition.path, definition.registry);
  const source = await boundedText(registryTarget.path);
  const registry = JSON.parse(source.text);
  if (registry.schema !== 'white_replay.native_releases.v1') throw new Error('动作库登记格式不匹配');
  const release = registry.releases?.find(item => item.id === registry.default_release && item.status === 'released');
  if (!release?.files?.catalog || !release.files.blend) throw new Error('未找到已登记的默认动作库');
  const indexTarget = await checkedPath(definition.path, release.files.catalog.path);
  const indexSource = await boundedText(indexTarget.path, MAX_INDEX);
  if (indexSource.sha256 !== release.files.catalog.sha256) throw new Error('动作目录与正式登记哈希不符');
  const data = JSON.parse(indexSource.text);
  if (data.schema !== 'white-model-pose-library/1' || !Array.isArray(data.motions) || !Array.isArray(data.poses)) throw new Error('动作目录结构不正确');
  if (data.motions.length + data.poses.length > 5000) throw new Error('动作目录超过 5000 项，未载入');
  const blend = await checkedPath(definition.path, release.files.blend.path);
  resource.path = path.dirname(indexTarget.path); resource.realPath = path.dirname(indexTarget.realPath); resource.kind = 'directory';
  resource.parts.push({id: 'registry', label: '正式版本登记', ...registryTarget}, {id: 'index', label: '姿势与动作目录', ...indexTarget}, {id: 'blend', label: '可编辑动作库工程', ...blend});
  resource.library = {release: release.id, version: clean(data.version), motions: data.motions.length, poses: data.poses.length, projectRoot: definition.path, guide: path.join(definition.path, 'pipeline', '动作库接入.md'), indexHash: indexSource.sha256, registryHash: source.sha256, validationScope: clean(data.validation_scope), entries: []};
  const ids = new Set();
  for (const [kind, values] of [['motion', data.motions], ['pose', data.poses]]) for (const item of values) {
    if (!/^[a-zA-Z0-9_-]+$/.test(item.id) || ids.has(item.id)) throw new Error('动作编号重复或无效');
    ids.add(item.id);
    resource.library.entries.push({id: item.id, kind, title: clean(item.label, 120), category: clean(item.category, 80), duration: Number.isFinite(item.duration_seconds) ? item.duration_seconds : null, entryType: clean(item.entry_type, 40), note: clean(item.note || item.support_note), continuity: clean(item.continuity_status, 80), windows: Number.isInteger(item.continuity_review_window_count) ? item.continuity_review_window_count : null});
  }
  const pending = resource.library.entries.filter(item => item.continuity === 'review_required').length;
  resource.summary = `默认 v${data.version} · ${data.motions.length} 条动作 · ${data.poses.length} 个姿势${pending ? ` · ${pending} 条动作有待复核提示` : ''}`;
  resource.note = `正式版本取自项目登记；目录哈希已核对，工程核对存在。${clean(data.validation_scope)} 调用前按项目当前检测器检查连续性。`;
  resource.updatedAt = indexSource.modifiedAt;
}

async function scanResource(definition) {
  const resource = {id: definition.id, title: clean(definition.title, 120), category: clean(definition.category, 60), workflows: definition.workflows || ['general'], skills: definition.skills || [], description: clean(definition.description), note: clean(definition.note), prompt: clean(definition.prompt, 2500), path: definition.path, available: false, parts: [], summary: '', library: null};
  try {
    const base = await checkedPath(definition.path);
    Object.assign(resource, base, {available: true, updatedAt: base.modifiedAt});
    if (definition.adapter === 'white-library') await libraryIndex(resource, definition);
    else {
      for (const [index, item] of (definition.pinned || []).entries()) {
        try {resource.parts.push({id: `pinned-${index}`, label: clean(item.label || item.path, 150), ...await checkedPath(definition.path, item.path)});}
        catch {resource.note += ` ${clean(item.label || item.path, 100)} 暂不可读。`;}
      }
      if (definition.browse && base.kind === 'directory') {
        const entries = (await fs.readdir(definition.path, {withFileTypes: true})).filter(item => !SKIP.test(item.name) && (item.isDirectory() || DISPLAY_FILE.test(item.name))).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        resource.directChildren = entries.length;
        for (const item of entries.slice(0, 80)) {
          try {
            const target = await checkedPath(definition.path, item.name);
            if (!resource.parts.some(part => normalized(part.path) === normalized(target.path))) resource.parts.push({id: `child-${sha(item.name).slice(0, 14)}`, label: clean(item.name, 160), ...target});
          } catch {}
        }
        resource.summary = `${entries.length} 项一级内容${entries.length > 80 ? ' · 展示前 80 项' : ''}`;
      }
    }
  } catch (error) {resource.available = false; resource.issue = error.code === 'ENOENT' ? '此路径当前不存在' : clean(error.message); resource.parts = []; resource.library = null;}
  return resource;
}

class Catalog {
  constructor(dataDirectory) {this.dataDirectory = dataDirectory; this.value = null; this.sourceFile = null;this.extrasKey='';}
  invalidate() {this.value = null; this.sourceFile = null;}
  async get(sourceFile, force = false, extras = []) {
    if (!sourceFile&&!extras.length) return {schema: 'workflow-catalog/1', skills: [], resources: [], issues: ['请在关联页选择技能资源清单。'], stats: {skills: 0, resources: 0, availableResources: 0, copies: 0, ignored: 0}, scannedAt: null};
    const extrasKey=sha(canonical(extras));
    if (!force && this.value && this.sourceFile === sourceFile&&this.extrasKey===extrasKey) return this.value;
    const configSource = sourceFile?await boundedText(sourceFile):{sha256:null};
    const config = sourceFile?validateSources(JSON.parse(configSource.text)):{skillRoots:[],resources:[],scope:'用户在弹窗中登记的本机资源。'};
    const issues = [];
    const skills = await scanSkills(config.skillRoots, issues);
    const resources = [];
    for (const definition of config.resources) resources.push(await scanResource(definition));
    for (const definition of extras.filter(item=>!item.paused))resources.push({...await scanResource(definition),custom:true});
    const contents = {schema: 'workflow-catalog/1', sourceFile, sourceHash: configSource.sha256, scope: clean(config.scope, 1000), skills: skills.records, resources, issues, stats: {skills: skills.records.length, resources: resources.length, availableResources: resources.filter(r => r.available).length, copies: skills.copies, ignored: skills.ignored, codexSkills: skills.records.filter(s => s.locations.some(l => l.kind === 'codex')).length, pluginSkills: skills.records.filter(s => s.sourceKind === 'plugin').length, systemSkills: skills.records.filter(s => s.sourceKind === 'system').length}};
    const fingerprint = sha(canonical(contents));
    const archiveDirectory = path.join(this.dataDirectory, 'catalog');
    await fs.mkdir(archiveDirectory, {recursive: true});
    const archiveFile = path.join(archiveDirectory, `inventory-${fingerprint}.json`);
    const scannedAt = nowIso();
    try {await fs.writeFile(archiveFile, JSON.stringify({...contents, fingerprint, scannedAt}, null, 2), {flag: 'wx'});}
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const archived = JSON.parse((await boundedText(archiveFile, 16 * 1024 * 1024)).text);
      const {fingerprint: archivedHash, scannedAt: archivedAt, ...archivedContents} = archived;
      if (archivedHash !== fingerprint || sha(canonical(archivedContents)) !== fingerprint || !archivedAt) throw new Error('已有目录留档校验失败，已保留原文件');
    }
    this.sourceFile = sourceFile;
    this.extrasKey=extrasKey;
    this.value = {...contents, fingerprint, scannedAt, archiveFile};
    return this.value;
  }
  async resolveTarget(args) {
    if (!this.value) throw new Error('请先打开技能与资源目录');
    const collection = args.kind === 'skill' ? this.value.skills : args.kind === 'resource' ? this.value.resources : null;
    const item = collection?.find(item => item.id === args.id);
    if (!item || item.available === false) throw new Error('目录项目不存在或当前不可用');
    const target = args.part ? (args.kind === 'skill' ? item.supports : item.parts).find(part => part.id === args.part) : item;
    if (!target?.realPath) throw new Error('目录路径未登记');
    const realPath = await fs.realpath(target.path);
    if (normalized(realPath) !== normalized(target.realPath)) throw new Error('来源路径已变化，请重新扫描后打开');
    return target.path;
  }
  async export() {
    if (!this.value) throw new Error('请先扫描目录');
    const value = this.value;
    const lines = ['# 我的技能与资源', '', `扫描时间：${value.scannedAt}`, '', value.scope, '', '复制调用示例到对应项目的 Codex 聊天。方括号内是待替换的目标或资料。磁盘文件与软件连接分别核验。', '', `技能 ${value.stats.skills} 项；资源集合 ${value.stats.availableResources}/${value.stats.resources} 项可读取。`, '', '## 技能'];
    for (const item of value.skills) {
      lines.push('', `### ${item.title} · ${item.callName}`, '', item.description, '', `位置：${item.path}`, '', item.invocationNote, '', '```text', item.prompt.replace(/```/g, "'''"), '```');
      for(const part of item.supports) {lines.push('', `配套：${part.label} · ${part.path}`);if(part.topic)lines.push('', '```text',part.prompt.replace(/```/g,"'''"),'```');}
    }
    lines.push('', '## 资源');
    for (const item of value.resources) {
      lines.push('', `### ${item.title}`, '', item.description, '', `位置：${item.path}`, '', item.available ? item.summary || '路径可读取' : item.issue, '', item.note, '', '```text', item.prompt.replace(/```/g, "'''"), '```');
      for(const part of item.parts)lines.push('',`相关文件：${part.label} · ${part.path}`);
      if (item.library) {
        lines.push('', '#### 动作与姿势目录', '', '编号 | 名称 | 分类 | 类型 | 连续性记录', '--- | --- | --- | --- | ---');
        for (const entry of item.library.entries) lines.push([entry.id, entry.title, entry.category, entry.kind === 'motion' ? '动作' : '姿势', entry.continuity || '未登记'].map(cell => String(cell).replace(/\|/g, '/').replace(/\r?\n/g, ' ')).join(' | '));
      }
    }
    const dir = path.join(this.dataDirectory, 'exports'); await fs.mkdir(dir, {recursive: true});
    const output = path.join(dir, `skills-resources-${Date.now()}-${randomUUID().slice(0, 6)}.md`);
    await fs.writeFile(output, `${lines.join('\n')}\n`, {flag: 'wx'});
    return {path: output, skills: value.stats.skills, resources: value.stats.resources};
  }
}
module.exports = {Catalog, parseMetadata, validateSources, checkedPath, scanSkills, scanResource};
