use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

fn references(task: &Value) -> Vec<Value> {
    let pattern = Regex::new(r"\[[^\]]*\]\((?:<([^>]+)>|([^\)\r\n]+))\)|`([^`\r\n]+)`").unwrap();
    let mut refs = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for message in task["messages"].as_array().into_iter().flatten() {
        let text = message["text"].as_str().unwrap_or("");
        for capture in pattern.captures_iter(text) {
            let reference = (1..=3)
                .find_map(|index| capture.get(index))
                .unwrap()
                .as_str()
                .trim();
            let reference = reference.split('#').next().unwrap_or(reference);
            if reference.len() > 1024
                || reference.contains("://")
                || reference.chars().any(char::is_control)
                || Path::new(reference).extension().is_none()
                || !seen.insert(reference.to_owned())
            {
                continue;
            }
            let id = format!(
                "{:x}",
                Sha256::digest(format!("{}\n{reference}", task["id"]).as_bytes())
            );
            refs.push(json!({"id":id,"reference":reference,"evidenceAt":message["at"],"messageId":message["id"]}));
        }
    }
    refs
}
fn target(task: &Value, reference: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(task["projectRoot"].as_str().ok_or("任务缺少工程目录")?)
        .map_err(|_| "当前工程目录不可用")?;
    let path = Path::new(reference);
    if path
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("文件引用超出任务目录边界".into());
    }
    let path = fs::canonicalize(if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    })
    .map_err(|_| "当前文件不可用，可能已移动或删除")?;
    if !path.starts_with(root) || !path.is_file() {
        return Err("文件引用超出任务目录或不是普通文件".into());
    }
    Ok(path)
}
pub fn list(task: &Value) -> Value {
    let items: Vec<_> = references(task)
        .into_iter()
        .map(|mut item| {
            match target(task, item["reference"].as_str().unwrap()) {
                Ok(_) => item["available"] = json!(true),
                Err(issue) => {
                    item["available"] = json!(false);
                    item["issue"] = json!(issue);
                }
            }
            item
        })
        .collect();
    json!({"items":items,"scope":"文件入口检查当前可访问性，未归档文件内容或历史版本。"})
}
pub fn open_target(task: &Value, id: &str) -> Result<PathBuf, String> {
    let reference = references(task)
        .into_iter()
        .find(|item| item["id"] == id)
        .ok_or("文件引用不属于这个任务")?;
    target(task, reference["reference"].as_str().unwrap())
}
