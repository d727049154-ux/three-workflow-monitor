use crate::{models::Source, observation::now, storage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stage {
    #[serde(default)]
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workflow {
    #[serde(default)]
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub root: String,
    pub stages: Vec<Stage>,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workspace {
    pub revision: u64,
    pub workflows: Vec<Workflow>,
    #[serde(default)]
    pub resources: Vec<crate::resources::Resource>,
    #[serde(default)]
    pub connections: Vec<crate::resources::Connection>,
    #[serde(default)]
    pub resource_settings: Vec<crate::resources::ResourceSettings>,
    #[serde(default)]
    pub favorites: Vec<String>,
    #[serde(default)]
    pub recent: Vec<String>,
}

pub fn load(data_dir: &Path) -> Result<Workspace, String> {
    let workspace: Workspace = storage::read(&data_dir.join("workspace.json"))?.unwrap_or_default();
    validate(&workspace).map_err(|error| {
        format!(
            "{} 配置无效：{error}；请关闭应用后修复 workspace.json，再重新打开。原文件保留",
            data_dir.join("workspace.json").display()
        )
    })?;
    Ok(workspace)
}

fn text(value: &str, max: usize, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().count() > max || value.chars().any(char::is_control)
    {
        return Err(format!("{label}须为 1–{max} 字且不能含控制字符"));
    }
    Ok(())
}

pub fn validate(workspace: &Workspace) -> Result<(), String> {
    if workspace.workflows.len() > 40 {
        return Err("最多 40 个工作流".into());
    }
    let mut flow_ids = HashSet::new();
    let mut titles = HashSet::new();
    for flow in &workspace.workflows {
        text(&flow.id, 100, "工作流标识")?;
        text(&flow.title, 60, "工作流名称")?;
        if !flow_ids.insert(&flow.id) || !titles.insert(&flow.title) {
            return Err("工作流标识或名称重复".into());
        }
        if !flow.root.is_empty() {
            text(&flow.root, 512, "项目路径")?;
            if !Path::new(&flow.root).is_absolute() {
                return Err("项目路径必须为绝对目录".into());
            }
        }
        if !(1..=10).contains(&flow.stages.len()) {
            return Err("请填写 1–10 个阶段".into());
        }
        let mut stage_ids = HashSet::new();
        for stage in &flow.stages {
            text(&stage.id, 100, "阶段标识")?;
            text(&stage.label, 30, "阶段名称")?;
            if !stage_ids.insert(&stage.id) {
                return Err("阶段标识重复".into());
            }
        }
        let ids: HashSet<_> = flow.source_ids.iter().collect();
        if ids.len() != flow.source_ids.len() || ids.len() > 40 {
            return Err("来源关联重复或超过 40 项".into());
        }
        for id in ids {
            text(id, 100, "来源标识")?;
        }
    }
    crate::resources::validate(workspace)
}

pub fn mutate(
    data_dir: &Path,
    sources: &[Source],
    method: &str,
    args: Value,
) -> Result<Value, String> {
    let mut workspace = load(data_dir)?;
    if args["expectedRevision"].as_u64() != Some(workspace.revision) {
        return Err("工作区已在其他窗口更新；草稿已保留，请重新载入后合并再保存".into());
    }
    if method.starts_with("resource") {
        crate::resources::mutate(&mut workspace, method, &args)?;
    } else if method == "workflowSave" {
        let mut flow: Workflow = serde_json::from_value(args["workflow"].clone())
            .map_err(|error| format!("工作流字段无效：{error}"))?;
        let previous = workspace
            .workflows
            .iter()
            .position(|item| item.id == flow.id);
        if !flow.id.is_empty() && previous.is_none() {
            return Err("要修改的工作流不存在".into());
        }
        let old = previous.map(|index| &workspace.workflows[index]);
        let mut seen = HashSet::new();
        for stage in &mut flow.stages {
            if stage.id.is_empty() {
                stage.id = format!("stage-{}", uuid::Uuid::new_v4());
            } else if !old.is_some_and(|flow| flow.stages.iter().any(|old| old.id == stage.id)) {
                return Err("阶段身份已变化；新增阶段请留空标识".into());
            }
            if !seen.insert(stage.id.clone()) {
                return Err("阶段标识重复".into());
            }
            stage.label = stage.label.trim().into();
        }
        if flow
            .source_ids
            .iter()
            .any(|id| !sources.iter().any(|source| source.id == *id))
        {
            return Err("关联来源已变化，请刷新后重选".into());
        }
        if !flow.root.is_empty() && !Path::new(&flow.root).is_dir() {
            return Err("项目路径必须为可访问的目录".into());
        }
        flow.title = flow.title.trim().into();
        flow.created_at = old.map(|flow| flow.created_at.clone()).unwrap_or_else(now);
        flow.paused = old.is_some_and(|flow| flow.paused);
        flow.updated_at = now();
        if let Some(index) = previous {
            workspace.workflows[index] = flow;
        } else {
            flow.id = format!("flow-{}", uuid::Uuid::new_v4());
            workspace.workflows.push(flow);
        }
    } else {
        let id = args["id"].as_str().ok_or("缺少工作流标识")?;
        let index = workspace
            .workflows
            .iter()
            .position(|flow| flow.id == id)
            .ok_or("工作流不存在")?;
        match method {
            "workflowDelete" => {
                workspace.workflows.remove(index);
                for resource in &mut workspace.resources {
                    resource.workflow_ids.retain(|flow| flow != id);
                }
                for setting in &mut workspace.resource_settings {
                    setting.workflow_ids.retain(|flow| flow != id);
                }
            }
            "workflowPause" => {
                workspace.workflows[index].paused =
                    args["paused"].as_bool().ok_or("暂停状态必须是布尔值")?;
                workspace.workflows[index].updated_at = now();
            }
            _ => return Err("未知工作流操作".into()),
        }
    }
    workspace.revision = workspace.revision.checked_add(1).ok_or("配置版本已满")?;
    validate(&workspace)?;
    storage::write(&data_dir.join("workspace.json"), &workspace)?;
    Ok(json!(workspace))
}

pub fn prompt(flow: &Workflow) -> String {
    let file = Path::new(&flow.root).join("workflow-progress.json");
    let example = json!({"schema":"workflow-progress/1","workflowId":flow.id,"project":flow.title,"updatedAt":now(),"state":"running","summary":"填写真实公开进展","tasks":[{"id":"task-1","title":"填写任务名称","stageId":flow.stages[0].id,"state":"running","detail":"填写本次完成、未完成及依据","updatedAt":now()}],"acceptance":"unknown"});
    format!("继续「{}」。沿用当前授权，将真实公开进展写入 {}；先写同目录临时文件再替换。每次更新填写实际带时区时间，任务 ID 和阶段 ID 保持稳定。执行结束与成果验收分开；只有用户确认后才将 acceptance 设为 accepted。\n阶段：{}\n{}", flow.title, file.display(), flow.stages.iter().map(|stage| format!("{} = {}",stage.id,stage.label)).collect::<Vec<_>>().join("；"), serde_json::to_string_pretty(&example).unwrap())
}
