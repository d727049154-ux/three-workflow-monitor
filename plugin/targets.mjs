export const targetKey = target => JSON.stringify([target?.kind, target?.parentId || '', target?.id]);
export const KIND_LABELS = {workflow:'工作流',task:'任务',item:'任务小项',skill:'技能',resource:'资源',file:'资源文件',motion:'动作',pose:'姿势',topic:'制作专题'};
export function validTarget(target) {
  if (!target || !Object.hasOwn(KIND_LABELS, target.kind) || typeof target.id !== 'string' || !target.id || target.id.length > 600 || /[\x00-\x1f]/.test(target.id)) throw new Error('入口标识无效');
  const child = ['item','motion','pose','topic','file'].includes(target.kind);
  if (child && (typeof target.parentId !== 'string' || !target.parentId || target.parentId.length > 300 || /[\x00-\x1f]/.test(target.parentId))) throw new Error('入口所属项目无效');
  return {kind: target.kind, id: target.id, ...(child ? {parentId: target.parentId} : {})};
}
export function buildEntries(snapshot, catalog) {
  const entries = [];
  const push = (target, title, subtitle, description, workflows, identity = '', keywords = '') => entries.push({target, key: targetKey(target), title, subtitle, description: String(description || '').slice(0,2000), workflows, identity, keywords, kindLabel: KIND_LABELS[target.kind]});
  for (const project of snapshot?.projects || []) {
    push({kind:'workflow',id:project.id}, project.title, '流程建设与当前任务', project.workflow?.summary || project.summary, [project.id], project.id, (project.workflow?.stages || []).map(s=>s.label).join(' '));
    for (const task of project.tasks || []) {
      push({kind:'task',id:task.id},task.title,project.title,task.priorityNote || task.latestText,[project.id],task.threadId || task.id,`${task.focus} ${(task.items || []).map(i=>i.title).join(' ')}`);
      for (const item of task.items || []) push({kind:'item',id:item.id,parentId:task.id},item.title,`${project.title} · ${task.title}`,item.detail,[project.id],item.id,`${item.stateLabel} ${task.title}`);
    }
  }
  for (const skill of catalog?.skills || []) {
    push({kind:'skill',id:skill.id},skill.title,skill.callName,skill.description,skill.workflows,`${skill.name} ${skill.callName}`,`${skill.category} ${(skill.manager?.tags || []).join(' ')} ${(skill.manager?.presets || []).join(' ')}`);
    for (const topic of skill.supports || []) if (topic.topic) push({kind:'topic',id:topic.id,parentId:skill.id},topic.label,skill.title,topic.prompt,skill.workflows,topic.id,skill.name);
  }
  for (const resource of catalog?.resources || []) {
    push({kind:'resource',id:resource.id},resource.title,resource.category,resource.description,resource.workflows,resource.id,`${resource.summary} ${(resource.skills || []).join(' ')}`);
    for(const part of resource.parts || [])push({kind:'file',id:part.id,parentId:resource.id},part.label,resource.title,`${resource.category} · ${part.path || ''}`,resource.workflows,part.label,resource.category);
    for (const entry of resource.library?.entries || []) push({kind:entry.kind,id:entry.id,parentId:resource.id},entry.title,`${resource.title} · ${entry.category}`,entry.note || '',resource.workflows,entry.id,`${entry.category} ${entry.kind === 'pose' ? '静态姿势' : '动作'} ${entry.continuity === 'review_required' ? '连续性待复核' : ''}`);
  }
  return entries;
}
