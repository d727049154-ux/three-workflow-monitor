use crate::{storage, workspace::Workspace};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resource {
    #[serde(default)]
    pub id: String,
    pub title: String,
    pub kind: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub workflow_ids: Vec<String>,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub connection_id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    #[serde(default)]
    pub id: String,
    pub kind: String,
    pub path: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceSettings {
    pub id: String,
    pub category: String,
    pub workflow_ids: Vec<String>,
    pub paused: bool,
}

fn text(value: &str, max: usize, empty: bool) -> Result<(), String> {
    if (!empty && value.trim().is_empty())
        || value.chars().count() > max
        || value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
    {
        return Err(format!("资源文字为空、含无效字符或超过 {max} 字"));
    }
    Ok(())
}
fn validate_resource(resource: &Resource) -> Result<(), String> {
    text(&resource.id, 200, false)?;
    text(&resource.title, 100, false)?;
    text(&resource.category, 60, true)?;
    text(&resource.content, 16000, true)?;
    if !matches!(resource.kind.as_str(), "file" | "prompt") {
        return Err("资源类型须为 file 或 prompt".into());
    }
    if resource.kind == "file"
        && (!Path::new(&resource.path).is_absolute() || resource.path.chars().any(char::is_control))
    {
        return Err("资源文件须为绝对路径".into());
    }
    if resource.kind == "prompt" && resource.content.trim().is_empty() {
        return Err("提示词不能为空".into());
    }
    Ok(())
}
fn links(ids: &[String], workspace: &Workspace) -> Result<(), String> {
    if ids.len() > 40
        || ids.iter().collect::<HashSet<_>>().len() != ids.len()
        || ids
            .iter()
            .any(|id| !workspace.workflows.iter().any(|flow| flow.id == *id))
    {
        return Err("关联工作流已变化，请重新选择".into());
    }
    Ok(())
}
pub fn validate(workspace: &Workspace) -> Result<(), String> {
    if workspace.resources.len() > 80
        || workspace.connections.len() > 8
        || workspace.resource_settings.len() > 300
        || workspace.favorites.len() > 380
        || workspace.recent.len() > 30
    {
        return Err("资源数量超过容量".into());
    }
    let mut ids = HashSet::new();
    for resource in &workspace.resources {
        validate_resource(resource)?;
        if !resource.connection_id.is_empty() || !ids.insert(&resource.id) {
            return Err("手工资源身份无效或重复".into());
        }
        links(&resource.workflow_ids, workspace)?;
    }
    let mut connections = HashSet::new();
    for connection in &workspace.connections {
        text(&connection.id, 100, false)?;
        if !connections.insert(&connection.id)
            || !matches!(connection.kind.as_str(), "directory" | "catalog")
            || !Path::new(&connection.path).is_absolute()
            || connection.path.chars().any(char::is_control)
        {
            return Err("资源连接无效".into());
        }
    }
    let mut settings = HashSet::new();
    for setting in &workspace.resource_settings {
        text(&setting.category, 60, true)?;
        if !settings.insert(&setting.id)
            || !workspace
                .connections
                .iter()
                .any(|c| setting.id.starts_with(&format!("{}:", c.id)))
        {
            return Err("资源设置身份无效".into());
        }
        links(&setting.workflow_ids, workspace)?;
    }
    for list in [&workspace.favorites, &workspace.recent] {
        if list.iter().collect::<HashSet<_>>().len() != list.len() {
            return Err("资源访问记录重复".into());
        }
        for id in list {
            text(id, 200, false)?;
        }
    }
    Ok(())
}

fn bounded_text(path: &Path, budget: &mut usize) -> Result<String, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take((*budget + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > *budget {
        return Err("资源内容总量超过 512 KiB".into());
    }
    *budget -= bytes.len();
    String::from_utf8(bytes).map_err(|_| "资源须为 UTF-8 文本".into())
}
fn within(path: &Path, root: &Path) -> Result<PathBuf, String> {
    let target = fs::canonicalize(path).map_err(|e| format!("资源不可访问：{e}"))?;
    if !target.starts_with(root) {
        return Err("资源路径越出所选目录".into());
    }
    Ok(target)
}
fn imported_id(connection: &Connection, key: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{}:{:x}", connection.id, Sha256::digest(key.as_bytes()))
}
fn read_connection(connection: &Connection) -> Result<Vec<Resource>, String> {
    let selected =
        fs::canonicalize(&connection.path).map_err(|e| format!("连接路径不可访问：{e}"))?;
    let mut budget = storage::MAX_WORKSPACE_BYTES;
    let mut items = Vec::new();
    if connection.kind == "catalog" {
        let root = selected.parent().ok_or("清单目录不存在")?;
        let text = bounded_text(&selected, &mut budget)?;
        let mut resources: Vec<Resource> =
            serde_json::from_str(&text).map_err(|e| format!("清单须为资源 JSON 数组：{e}"))?;
        if resources.len() > 300 {
            return Err("清单最多 300 项".into());
        }
        let mut keys = HashSet::new();
        for item in &mut resources {
            if item.id.is_empty() || !keys.insert(item.id.clone()) {
                return Err("清单每项须有唯一 id".into());
            }
            if item.kind == "file" {
                let path = Path::new(&item.path);
                let path = if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    root.join(path)
                };
                item.path = within(&path, root)?.to_string_lossy().into();
            }
            item.id = imported_id(connection, &item.id);
            item.connection_id = connection.id.clone();
            item.workflow_ids.clear();
            validate_resource(item)?;
        }
        items = resources;
    } else {
        if !selected.is_dir() {
            return Err("连接路径不是目录".into());
        }
        for (index, entry) in walkdir::WalkDir::new(&selected)
            .max_depth(5)
            .follow_links(false)
            .into_iter()
            .enumerate()
        {
            if index >= 5000 {
                return Err("目录超过 5000 个条目，请选择更具体的目录".into());
            }
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().is_file()
                || entry
                    .path()
                    .extension()
                    .is_none_or(|e| !e.eq_ignore_ascii_case("md"))
            {
                continue;
            }
            if items.len() >= 300 {
                return Err("目录最多读取 300 个 Markdown 资源，请选择更具体的目录".into());
            }
            let path = within(entry.path(), &selected)?;
            let content = bounded_text(&path, &mut budget)?;
            let relative = entry
                .path()
                .strip_prefix(&selected)
                .map_err(|e| e.to_string())?
                .to_string_lossy();
            let title = content
                .lines()
                .find_map(|line| line.strip_prefix("# "))
                .unwrap_or(&relative)
                .trim()
                .chars()
                .take(100)
                .collect();
            let resource = Resource {
                id: imported_id(connection, &relative),
                title,
                kind: "file".into(),
                path: path.to_string_lossy().into(),
                content,
                category: String::new(),
                workflow_ids: vec![],
                paused: false,
                connection_id: connection.id.clone(),
            };
            validate_resource(&resource)?;
            items.push(resource);
        }
        items.sort_by(|a, b| a.path.cmp(&b.path));
    }
    Ok(items)
}

pub fn catalog(workspace: &Workspace) -> Value {
    let mut resources = workspace.resources.clone();
    let mut issues = Vec::new();
    for connection in &workspace.connections {
        match read_connection(connection) {
            Ok(mut items) => {
                for item in &mut items {
                    if let Some(setting) =
                        workspace.resource_settings.iter().find(|s| s.id == item.id)
                    {
                        item.category = setting.category.clone();
                        item.workflow_ids = setting.workflow_ids.clone();
                        item.paused = setting.paused;
                    }
                }
                resources.extend(items);
            }
            Err(issue) => issues
                .push(json!({"connectionId":connection.id,"path":connection.path,"issue":issue})),
        }
    }
    json!({"resources":resources,"issues":issues})
}
pub fn find(workspace: &Workspace, id: &str) -> Result<Resource, String> {
    let catalog = catalog(workspace);
    let item = catalog["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"].as_str() == Some(id))
        .ok_or("资源不存在或连接已失效")?;
    serde_json::from_value(item.clone()).map_err(|e| e.to_string())
}
pub fn open_target(workspace: &Workspace, id: &str) -> Result<PathBuf, String> {
    let item = find(workspace, id)?;
    if item.kind != "file" || item.paused {
        return Err("该资源已暂停或不是文件".into());
    }
    let target = fs::canonicalize(&item.path).map_err(|e| format!("文件不可访问：{e}"))?;
    if !item.connection_id.is_empty() {
        let connection = workspace
            .connections
            .iter()
            .find(|c| c.id == item.connection_id)
            .ok_or("连接已移除")?;
        let selected = fs::canonicalize(&connection.path).map_err(|e| e.to_string())?;
        let root = if connection.kind == "catalog" {
            selected.parent().ok_or("清单目录不存在")?
        } else {
            &selected
        };
        within(&target, root)?;
    }
    Ok(target)
}

fn remove_connection(workspace: &mut Workspace, id: &str) {
    workspace.connections.retain(|c| c.id != id);
    let prefix = format!("{id}:");
    workspace
        .resource_settings
        .retain(|s| !s.id.starts_with(&prefix));
    workspace.favorites.retain(|s| !s.starts_with(&prefix));
    workspace.recent.retain(|s| !s.starts_with(&prefix));
}
pub fn mutate(workspace: &mut Workspace, method: &str, args: &Value) -> Result<(), String> {
    match method {
        "resourceConnect" => {
            let mut connection: Connection =
                serde_json::from_value(args["connection"].clone()).map_err(|e| e.to_string())?;
            if !matches!(connection.kind.as_str(), "directory" | "catalog")
                || !Path::new(&connection.path).is_absolute()
            {
                return Err("请选择目录或 JSON 清单的绝对路径".into());
            }
            if connection.id.is_empty() {
                connection.id = format!("connection-{}", uuid::Uuid::new_v4());
            } else if !workspace.connections.iter().any(|c| c.id == connection.id) {
                return Err("要修改的连接不存在".into());
            }
            read_connection(&connection)?;
            remove_connection(workspace, &connection.id);
            workspace.connections.push(connection);
        }
        "resourceDisconnect" => {
            let id = args["id"].as_str().ok_or("缺少连接标识")?;
            if !workspace.connections.iter().any(|c| c.id == id) {
                return Err("连接不存在".into());
            }
            remove_connection(workspace, id);
        }
        "resourceSave" => {
            let mut resource: Resource = serde_json::from_value(args["resource"].clone())
                .map_err(|e| format!("资源字段无效：{e}"))?;
            if resource.id.is_empty() {
                resource.id = format!("resource-{}", uuid::Uuid::new_v4());
            } else {
                find(workspace, &resource.id)?;
            }
            resource.title = resource.title.trim().into();
            validate_resource(&resource)?;
            links(&resource.workflow_ids, workspace)?;
            if resource.connection_id.is_empty() {
                if !resource.id.starts_with("resource-") {
                    return Err("资源归属不能修改".into());
                }
                if resource.kind == "file" {
                    fs::canonicalize(&resource.path).map_err(|e| format!("文件不可访问：{e}"))?;
                }
                workspace.resources.retain(|item| item.id != resource.id);
                workspace.resources.push(resource);
            } else {
                let imported = find(workspace, &resource.id)?;
                if imported.connection_id != resource.connection_id {
                    return Err("资源连接身份不匹配".into());
                }
                workspace.resource_settings.retain(|s| s.id != resource.id);
                workspace.resource_settings.push(ResourceSettings {
                    id: resource.id,
                    category: resource.category,
                    workflow_ids: resource.workflow_ids,
                    paused: resource.paused,
                });
            }
        }
        "resourceFavorite" | "resourceRecent" | "resourcePause" | "resourceDelete" => {
            let id = args["id"].as_str().ok_or("缺少资源标识")?;
            let mut item = find(workspace, id)?;
            match method {
                "resourceFavorite" => {
                    let enabled = args["favorite"].as_bool().ok_or("收藏状态无效")?;
                    workspace.favorites.retain(|s| s != id);
                    if enabled {
                        workspace.favorites.push(id.into());
                    }
                }
                "resourceRecent" => {
                    workspace.recent.retain(|s| s != id);
                    workspace.recent.insert(0, id.into());
                    workspace.recent.truncate(30);
                }
                "resourcePause" => {
                    item.paused = args["paused"].as_bool().ok_or("暂停状态无效")?;
                    mutate(workspace, "resourceSave", &json!({"resource":item}))?;
                }
                _ => {
                    if !item.connection_id.is_empty() {
                        return Err("导入资源请暂停，或清空其连接".into());
                    }
                    workspace.resources.retain(|s| s.id != id);
                    workspace.favorites.retain(|s| s != id);
                    workspace.recent.retain(|s| s != id);
                }
            }
        }
        _ => return Err("未知资源操作".into()),
    }
    Ok(())
}
