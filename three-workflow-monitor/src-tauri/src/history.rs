use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_RECORD: usize = 4 * 1024 * 1024;
const MAX_EXPORT: u64 = 8 * 1024 * 1024;

fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(value).unwrap()))
}
fn selected(value: &Value, keys: &[&str]) -> Value {
    let mut result = json!({});
    for key in keys {
        if let Some(value) = value.get(*key) {
            result[*key] = value.clone();
        }
    }
    result
}
// History deliberately excludes the workspace and resource catalog, which contain private prompts.
pub fn observation(view: &Value) -> Value {
    let tasks: Vec<_> = view["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|task| {
            let mut task = selected(
                task,
                &[
                    "id",
                    "sourceId",
                    "title",
                    "projectRoot",
                    "threadId",
                    "execution",
                    "acceptance",
                    "eventAt",
                    "observedAt",
                    "sourcePath",
                    "workflowId",
                    "stageId",
                    "progress",
                    "sourceHealth",
                    "messages",
                ],
            );
            task["progress"] = selected(
                &task["progress"],
                &[
                    "workflowTitle",
                    "workflowPaused",
                    "stageLabel",
                    "stageStatus",
                ],
            );
            task
        })
        .collect();
    json!({"sources":view["sources"],"tasks":tasks,"sourceHealth":view["sourceHealth"],"observedAt":view["observedAt"]})
}
fn substantive(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            fields.remove("observedAt");
            for item in fields.values_mut() {
                substantive(item);
            }
        }
        Value::Array(items) => {
            for item in items {
                substantive(item);
            }
        }
        _ => {}
    }
}
fn files(data: &Path) -> Result<Vec<PathBuf>, String> {
    let dir = data.join("history");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut paths = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}
fn read(path: &Path) -> Result<Value, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take((MAX_RECORD + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_RECORD {
        return Err("历史记录超过 4 MiB；原记录保留，请关闭应用后检查历史目录".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| format!("历史记录损坏：{}；原记录保留", path.display()))
}
fn scan(data: &Path, mut visit: impl FnMut(&Value)) -> Result<(u64, String), String> {
    let mut previous = String::new();
    let mut sequence = 0;
    for path in files(data)? {
        let mut record = read(&path)?;
        let hash = record["hash"].as_str().ok_or("历史缺少校验值")?.to_string();
        record.as_object_mut().ok_or("历史格式无效")?.remove("hash");
        sequence += 1;
        if record["sequence"] != sequence
            || record["previousHash"] != previous
            || digest(&record) != hash
            || path.file_stem().and_then(|s| s.to_str()) != record["id"].as_str()
        {
            return Err(format!(
                "历史校验链损坏：{}；停止追加，原记录保留",
                path.display()
            ));
        }
        record["hash"] = json!(hash);
        visit(&record);
        previous = hash;
    }
    Ok((sequence, previous))
}
pub fn snapshot(data: &Path, id: &str) -> Result<Value, String> {
    let mut found = None;
    scan(data, |record| {
        if record["id"] == id && record["kind"] != "acknowledgement" {
            found = Some(record.clone())
        }
    })?;
    found.ok_or("历史快照不存在".into())
}
pub fn list(data: &Path, args: &Value) -> Result<Value, String> {
    let before = args["beforeId"].as_str();
    let limit = args["limit"].as_u64().unwrap_or(25).clamp(1, 100) as usize;
    let mut items = Vec::new();
    let mut acknowledged = std::collections::HashSet::new();
    scan(data, |record| {
        if record["kind"] == "acknowledgement" {
            if let Some(id) = record["snapshotId"].as_str() {
                acknowledged.insert(id.to_string());
            }
        } else {
            items.push(json!({"id":record["id"],"kind":record["kind"],"observedAt":record["snapshot"]["observedAt"],"changeCount":record["changes"].as_array().map(Vec::len),"taskCount":record["snapshot"]["tasks"].as_array().map(Vec::len)}));
        }
    })?;
    let total = items.len();
    let end = if let Some(id) = before {
        items
            .iter()
            .position(|item| item["id"] == id)
            .ok_or("历史分页位置不存在，请重新打开历史列表")?
    } else {
        total
    };
    let start = end.saturating_sub(limit);
    let page: Vec<_> = items
        .drain(start..end)
        .rev()
        .map(|mut item| {
            item["acknowledged"] = json!(acknowledged.contains(item["id"].as_str().unwrap()));
            item
        })
        .collect();
    Ok(
        json!({"nextBefore":if start>0 {page.last().map(|item|item["id"].clone())}else{None},"items":page,"total":total,"beforeId":before,"limit":limit}),
    )
}
fn changes(before: &Value, after: &Value) -> Value {
    let mut changes = Vec::new();
    for field in ["sources", "sourceHealth"] {
        let mut left = before[field].clone();
        let mut right = after[field].clone();
        substantive(&mut left);
        substantive(&mut right);
        if left != right {
            changes.push(json!({"field":field,"before":left,"after":right}));
        }
    }
    let empty = vec![];
    let old = before["tasks"].as_array().unwrap_or(&empty);
    let new = after["tasks"].as_array().unwrap_or(&empty);
    for task in new {
        let prior = old.iter().find(|old| old["id"] == task["id"]);
        for field in [
            "title",
            "execution",
            "acceptance",
            "eventAt",
            "messages",
            "workflowId",
            "stageId",
            "progress",
        ] {
            if prior.map(|p| &p[field]) != Some(&task[field]) {
                changes.push(json!({"taskId":task["id"],"field":field,"before":prior.map(|p|&p[field]),"after":task[field]}));
            }
        }
    }
    for task in old {
        if !new.iter().any(|new| new["id"] == task["id"]) {
            changes.push(json!({"taskId":task["id"],"field":"removed"}));
        }
    }
    json!(changes)
}
struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn append(
    data: &Path,
    kind: &str,
    view: Value,
    snapshot_id: Option<&str>,
) -> Result<Value, String> {
    let dir = data.join("history");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let lock = dir.join("append.lock");
    // 进程被强杀/关机后残留的锁会让历史永久停止追加；超过 120 秒的锁视为失效。
    let stale = fs::metadata(&lock)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.elapsed().ok())
        .is_some_and(|age| age >= std::time::Duration::from_secs(120));
    if stale {
        let _ = fs::remove_file(&lock);
    }
    let _file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
        .map_err(|error| {
            format!("历史追加锁不可用：{error}；如应用异常退出，请关闭所有窗口后移除 history/append.lock，再重试")
        })?;
    let _guard = Lock(lock);
    let mut last = json!({});
    let (sequence, previous) = scan(data, |record| {
        if record["kind"] != "acknowledgement" {
            last = record.clone()
        }
    })?;
    let mut fact = view.clone();
    substantive(&mut fact);
    let fingerprint = digest(&fact);
    if kind == "observation" && last["fingerprint"] == fingerprint {
        return Ok(last);
    }
    if kind == "acknowledgement" {
        snapshot(data, snapshot_id.ok_or("缺少快照标识")?)?;
    }
    let id = format!("{:020}-{}", sequence + 1, uuid::Uuid::new_v4());
    let mut record = json!({"schema":"workflow-history/1","id":id,"sequence":sequence+1,"previousHash":previous,"kind":kind,"recordedAt":crate::observation::now()});
    if kind == "acknowledgement" {
        record["snapshotId"] = json!(snapshot_id);
    } else {
        record["fingerprint"] = json!(fingerprint);
        record["changes"] = changes(&last["snapshot"], &view);
        record["snapshot"] = view;
    }
    record["hash"] = json!(digest(&record));
    let bytes = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_RECORD {
        return Err("历史观察超过 4 MiB，未写入；请减少来源或公开进展长度".into());
    }
    let temp = dir.join(format!(".{id}.tmp"));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::hard_link(&temp, dir.join(format!("{id}.json"))).map_err(|e| e.to_string())
    })();
    let _ = fs::remove_file(temp);
    result?;
    Ok(record)
}
pub fn record(data: &Path, view: &Value, checkpoint: bool) -> Result<Value, String> {
    append(
        data,
        if checkpoint {
            "checkpoint"
        } else {
            "observation"
        },
        observation(view),
        None,
    )
}
pub fn acknowledge(data: &Path, id: &str) -> Result<Value, String> {
    append(data, "acknowledgement", Value::Null, Some(id))
}
pub fn verify(data: &Path) -> Result<Value, String> {
    let (count, hash) = scan(data, |_| {})?;
    Ok(json!({"valid":true,"recordCount":count,"headHash":hash}))
}
pub fn export(data: &Path, args: &Value) -> Result<Value, String> {
    let ids = args["ids"].as_array().ok_or("请明确选择要导出的快照")?;
    if ids.is_empty() || ids.len() > 100 {
        return Err("请选择 1 至 100 份快照".into());
    }
    let mut paths = Vec::new();
    let mut size = 0u64;
    let mut unique = std::collections::HashSet::new();
    for id in ids {
        let id = id.as_str().ok_or("快照标识无效")?;
        if id.len() != 57
            || !id.as_bytes()[..20].iter().all(|c| c.is_ascii_digit())
            || id.as_bytes()[20] != b'-'
            || uuid::Uuid::parse_str(&id[21..]).is_err()
            || !unique.insert(id)
        {
            return Err("快照标识无效或重复".into());
        }
        let path = data.join("history").join(format!("{id}.json"));
        size = size
            .checked_add(fs::metadata(&path).map_err(|e| e.to_string())?.len())
            .ok_or("导出过大")?;
        if size > MAX_EXPORT {
            return Err("所选历史超过 8 MiB，请减少选择后导出".into());
        }
        paths.push(path);
    }
    verify(data)?;
    let mut snapshots = Vec::new();
    for path in paths {
        let record = read(&path)?;
        if record["kind"] == "acknowledgement" {
            return Err("请选择观察快照".into());
        }
        snapshots.push(record);
    }
    let result = json!({"schema":"workflow-observation-export/1","scope":"仅所选历史观察、公开进展、状态变化与当时文件引用；不含资源正文、工作区提示词或文件内容。当前路径不代表历史文件版本。","snapshots":snapshots});
    if serde_json::to_vec(&result)
        .map_err(|e| e.to_string())?
        .len() as u64
        > MAX_EXPORT
    {
        return Err("所选历史超过 8 MiB，请减少选择后导出".into());
    }
    Ok(result)
}
