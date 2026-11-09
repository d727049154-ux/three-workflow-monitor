'use strict';
const fs=require('node:fs/promises');const path=require('node:path');const {randomUUID}=require('node:crypto');
const {nowIso}=require('./core.cjs');
async function validateResource(input,catalog,projects,existing=[]){
  const text=(value,max)=>{if(typeof value!=='string'||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))throw new Error('资源字段过长或含无效字符');return value.trim();};
  const title=text(input.title||'',80),target=text(input.path||'',512),category=text(input.category||'资料',40);
  if(!title||!target||!category)throw new Error('请填写资源名称、路径和分类');
  if(!path.isAbsolute(target))throw new Error('资源路径应为本机绝对路径');const stat=await fs.stat(target);if(!stat.isDirectory()&&!stat.isFile())throw new Error('请选择普通文件或目录');
  const previous=existing.find(item=>item.id===input.id);if(input.id&&!previous)throw new Error('要编辑的资源不存在');if(!previous&&existing.length>=80)throw new Error('当前最多登记 80 个自定义资源集合');
  const normalize=value=>path.resolve(value).toLocaleLowerCase();if(existing.some(item=>item.id!==input.id&&normalize(item.path)===normalize(target)))throw new Error('这个路径已经登记过，可以编辑原条目');
  const chosen=input.skillIds||[];if(!Array.isArray(chosen)||chosen.length>40)throw new Error('关联技能过多');const skills=chosen.map(id=>catalog.skills.find(item=>item.id===id));if(skills.some(item=>!item))throw new Error('技能目录已变化，请刷新后重选');
  const flows=input.workflows||[];if(!Array.isArray(flows)||flows.length>43||flows.some(id=>!projects.some(project=>project.id===id)))throw new Error('关联的工作流已变化，请重新选择');
  return {id:previous?.id||`resource-${randomUUID()}`,title,path:path.resolve(target),category,kind:stat.isDirectory()?'directory':'file',browse:stat.isDirectory(),description:text(input.description||'',1200)||`本机${stat.isDirectory()?'目录':'文件'}：${title}`,prompt:text(input.prompt||'',2500)||`使用 $skill-router，参考「${title}」处理 [具体目标]。\n资源位置：${path.resolve(target)}\n先核对现有内容和适用规则，保留原始文件。`,skills:[...new Set(skills.map(skill=>skill.name))],skillIds:[...new Set(chosen)],workflows:flows.length?[...new Set(flows)]:['general'],note:'用户登记的本机资源；目录仅列一级文件，最多 80 项。',createdAt:previous?.createdAt||nowIso(),updatedAt:nowIso(),paused:previous?.paused||false};
}
module.exports={validateResource};
