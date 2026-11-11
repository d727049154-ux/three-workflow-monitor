use crate::models::{Health, Message, Source, Task};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

pub fn now() -> String {
    Utc::now().to_rfc3339()
}

pub fn timestamp(value: &Value) -> Result<String, String> {
    let raw = value.as_str().ok_or("来源时间必须是带时区的文本")?;
    DateTime::parse_from_rfc3339(raw)
        .map(|date| date.with_timezone(&Utc).to_rfc3339())
        .map_err(|_| "来源时间格式无效".into())
}

pub fn health(source: &Source, state: &str, issue: Option<String>) -> Health {
    Health {
        source_id: source.id.clone(),
        state: state.into(),
        issue,
        observed_at: now(),
    }
}

pub fn source_file(source: &Source) -> Result<std::path::PathBuf, String> {
    let root =
        fs::canonicalize(&source.path).map_err(|error| format!("来源目录不可读：{error}"))?;
    let relative = if source.kind == "progress" {
        Path::new("workflow-progress.json")
    } else {
        source.session_file.as_deref().ok_or("尚未选择聊天文件")?
    };
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("来源文件必须位于所选目录内".into());
    }
    let file = fs::canonicalize(root.join(relative))
        .map_err(|error| format!("来源文件不可读：{error}"))?;
    if !file.starts_with(root) || !file.is_file() {
        return Err("来源文件超出所选目录或不是普通文件".into());
    }
    Ok(file)
}

pub fn validate_sources(sources: &[Source]) -> Result<(), String> {
    if sources.len() > 40 {
        return Err("最多接入 40 个来源".into());
    }
    let mut ids = std::collections::HashSet::new();
    for source in sources {
        if source.id.is_empty() || source.id.len() > 100 || !ids.insert(&source.id) {
            return Err("来源标识为空、过长或重复".into());
        }
        if !matches!(source.kind.as_str(), "codex" | "progress") || !source.path.is_absolute() {
            return Err("来源类型或绝对路径无效".into());
        }
        if source
            .path
            .to_str()
            .is_none_or(|path| path.chars().count() > 512 || path.chars().any(char::is_control))
            || source.title.as_ref().is_some_and(|title| {
                title.trim().is_empty()
                    || title.chars().count() > 160
                    || title.chars().any(char::is_control)
            })
        {
            return Err("来源路径或名称为空、过长或含控制字符".into());
        }
        if source.kind == "codex" {
            uuid::Uuid::parse_str(source.thread_id.as_deref().ok_or("缺少聊天标识")?)
                .map_err(|_| "聊天标识无效")?;
            if !source
                .project_root
                .as_ref()
                .is_some_and(|path| path.is_absolute())
            {
                return Err("聊天工程必须是绝对路径".into());
            }
            let path = source.session_file.as_ref().ok_or("缺少聊天文件")?;
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
                || path.is_absolute()
                || path
                    .components()
                    .any(|part| !matches!(part, std::path::Component::Normal(_)))
            {
                return Err("聊天文件路径无效".into());
            }
        }
    }
    Ok(())
}

#[derive(Default)]
pub struct Monitor {
    pub tasks: HashMap<String, Task>,
    pub source_health: Vec<Health>,
    readers: HashMap<String, SessionReader>,
}

#[derive(Default)]
struct SessionReader {
    offset: u64,
    pending: Vec<u8>,
    skipping: bool,
    header: Vec<u8>,
    task: Option<Task>,
    turn_id: Option<String>,
}

const MAX_LINE: usize = 256 * 1024;
const READ_BUDGET: u64 = 4 * 1024 * 1024;

fn session_metadata(file: &Path) -> Result<(Value, Vec<u8>), String> {
    let file = fs::File::open(file).map_err(|error| error.to_string())?;
    let mut head = Vec::new();
    BufReader::new(file.take((MAX_LINE + 1) as u64))
        .read_until(b'\n', &mut head)
        .map_err(|error| error.to_string())?;
    if head.len() > MAX_LINE || !head.ends_with(b"\n") {
        return Err("聊天文件头不完整或超过 256 KiB".into());
    }
    let record: Value = serde_json::from_slice(&head).map_err(|_| "聊天文件头 JSON 无效")?;
    if record["type"] != "session_meta" {
        return Err("聊天缺少 session_meta 身份".into());
    }
    Ok((record, head))
}

pub fn discover(path: &Path) -> Result<Value, String> {
    if !path.is_absolute() {
        return Err("请选择绝对路径的会话目录".into());
    }
    let root = fs::canonicalize(path).map_err(|error| format!("会话目录不可读：{error}"))?;
    if !root.is_dir() {
        return Err("会话来源必须是目录".into());
    }
    let mut candidates = Vec::new();
    for (count, entry) in walkdir::WalkDir::new(&root)
        .follow_links(false)
        .max_depth(12)
        .into_iter()
        .enumerate()
    {
        if count >= 10000 {
            return Err("所选目录内容较多，请选择更具体的会话子目录".into());
        }
        let entry = entry.map_err(|error| format!("候选目录不可读：{error}"))?;
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("jsonl")
        {
            continue;
        }
        let (record, _) = match session_metadata(entry.path()) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let payload = &record["payload"];
        let Some(thread_id) = payload["id"]
            .as_str()
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        else {
            continue;
        };
        let Some(cwd) = payload["cwd"]
            .as_str()
            .filter(|cwd| Path::new(cwd).is_absolute())
        else {
            continue;
        };
        let title = payload["title"]
            .as_str()
            .unwrap_or(thread_id)
            .chars()
            .take(160)
            .collect::<String>();
        candidates.push(json!({"threadId":thread_id,"projectRoot":cwd,"sessionFile":entry.path().strip_prefix(&root).map_err(|error| error.to_string())?,"title":title}));
        if candidates.len() >= 1000 {
            return Err("候选聊天较多，请选择更具体的会话子目录".into());
        }
    }
    candidates.sort_by(|left, right| {
        left["sessionFile"]
            .as_str()
            .cmp(&right["sessionFile"].as_str())
            .reverse()
    });
    Ok(json!(candidates))
}

impl SessionReader {
    fn read(&mut self, source: &Source) -> Result<(Task, Health), String> {
        let path = source_file(source)?;
        let (metadata, header) = session_metadata(&path)?;
        if metadata["payload"]["id"].as_str() != source.thread_id.as_deref() {
            return Err("聊天文件与已选择的线程标识不匹配".into());
        }
        let cwd = metadata["payload"]["cwd"]
            .as_str()
            .ok_or("聊天缺少工程路径")?;
        let actual = fs::canonicalize(cwd).map_err(|_| "聊天登记的工程目录不可读")?;
        let expected = fs::canonicalize(source.project_root.as_ref().ok_or("未选择工程目录")?)
            .map_err(|_| "已选择的工程目录不可读")?;
        if actual != expected {
            return Err("聊天所属工程与已选择的工程目录不匹配".into());
        }
        let mut file = fs::File::open(&path).map_err(|error| error.to_string())?;
        let size = file.metadata().map_err(|error| error.to_string())?.len();
        if self.header != header || size < self.offset {
            *self = Self::default();
            self.header = header;
        }
        let initial = health(source, "ok", None);
        let task = self.task.get_or_insert_with(|| Task {
            id: source.id.clone(),
            source_id: source.id.clone(),
            title: source
                .title
                .clone()
                .unwrap_or_else(|| format!("聊天 {}", &source.thread_id.as_ref().unwrap()[..8])),
            project_root: expected,
            thread_id: source.thread_id.clone(),
            execution: "unknown".into(),
            source_health: initial.clone(),
            acceptance: "unknown".into(),
            messages: vec![],
            event_at: None,
            observed_at: initial.observed_at,
            source_path: path.clone(),
            workflow_id: None,
            stage_id: None,
            progress: None,
        });
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|error| error.to_string())?;
        let mut reader = file.take(READ_BUDGET);
        let mut chunk = [0u8; 64 * 1024];
        let mut issue = None;
        loop {
            let count = reader.read(&mut chunk).map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            self.offset += count as u64;
            for byte in &chunk[..count] {
                if *byte == b'\n' {
                    if !self.skipping && !self.pending.is_empty() {
                        match serde_json::from_slice::<Value>(&self.pending) {
                            Ok(record) => {
                                if let Err(error) = consume(task, &mut self.turn_id, record) {
                                    issue = Some(error);
                                }
                            }
                            Err(_) => issue = Some("聊天包含无效 JSON 记录，已跳过该记录".into()),
                        }
                    }
                    self.pending.clear();
                    self.skipping = false;
                } else if !self.skipping {
                    if self.pending.len() < MAX_LINE {
                        self.pending.push(*byte);
                    } else {
                        self.pending.clear();
                        self.skipping = true;
                    }
                }
            }
        }
        let status = if issue.is_some() {
            health(source, "error", issue)
        } else if self.offset < size || !self.pending.is_empty() || self.skipping {
            health(
                source,
                "catchingUp",
                Some("正在顺序补读或等待当前记录写完".into()),
            )
        } else {
            health(source, "ok", None)
        };
        Ok((task.clone(), status))
    }
}

fn consume(task: &mut Task, turn_id: &mut Option<String>, record: Value) -> Result<(), String> {
    let payload = &record["payload"];
    let lifecycle = record["type"] == "event_msg"
        && matches!(
            payload["type"].as_str(),
            Some(
                "task_started"
                    | "task_complete"
                    | "task_failed"
                    | "turn_aborted"
                    | "error"
                    | "approval_requested"
                    | "waiting_for_input"
            )
        );
    let public = record["type"] == "response_item"
        && payload["type"] == "message"
        && payload["role"] == "assistant"
        && matches!(
            payload["phase"].as_str(),
            Some("commentary" | "final" | "final_answer")
        );
    if !lifecycle && !public {
        return Ok(());
    }
    let at = timestamp(&record["timestamp"])?;
    if lifecycle && task.event_at.as_ref().is_none_or(|last| at >= *last) {
        let next_turn = payload["turn_id"].as_str().map(str::to_string);
        let preserve_failure = payload["type"] == "task_complete"
            && next_turn == *turn_id
            && task.execution == "failed";
        if !preserve_failure {
            task.execution = match payload["type"].as_str().unwrap() {
                "task_started" => "inProgress",
                "task_complete" => "completed",
                "turn_aborted" => "interrupted",
                "approval_requested" | "waiting_for_input" => "waiting",
                _ => "failed",
            }
            .into();
        }
        *turn_id = next_turn;
        task.event_at = Some(at.clone());
    }
    if public {
        let content = payload["content"]
            .as_array()
            .ok_or("公开消息 content 必须是数组")?;
        let text = content
            .iter()
            .filter(|part| part["type"] == "output_text")
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
            .chars()
            .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
            .take(6000)
            .collect::<String>();
        if text.trim().is_empty() {
            return Ok(());
        }
        let id = payload["id"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| format!("{:x}", Sha256::digest(format!("{at}:{text}"))));
        task.messages.retain(|message| message.id != id);
        task.messages.push(Message {
            id,
            phase: payload["phase"].as_str().unwrap().into(),
            text,
            at,
        });
        task.messages.sort_by(|left, right| left.at.cmp(&right.at));
        if task.messages.len() > 8 {
            task.messages.drain(..task.messages.len() - 8);
        }
    }
    Ok(())
}

impl Monitor {
    pub fn refresh(&mut self, sources: &[Source]) {
        self.source_health.clear();
        for source in sources {
            let result = if source.kind == "codex" {
                self.readers
                    .entry(source.id.clone())
                    .or_default()
                    .read(source)
                    .map(|(task, status)| (vec![task], status))
            } else {
                self.read_progress(source)
                    .map(|tasks| (tasks, health(source, "ok", None)))
            };
            let status = match result {
                Ok((tasks, status)) => {
                    self.tasks.retain(|_, task| task.source_id != source.id);
                    for task in tasks {
                        self.tasks.insert(task.id.clone(), task);
                    }
                    status
                }
                Err(issue) => health(source, "error", Some(issue)),
            };
            for task in self
                .tasks
                .values_mut()
                .filter(|task| task.source_id == source.id)
            {
                task.source_health = status.clone();
                task.observed_at = status.observed_at.clone();
            }
            self.source_health.push(status);
        }
    }

    fn read_progress(&self, source: &Source) -> Result<Vec<Task>, String> {
        let file = source_file(source)?;
        let mut bytes = Vec::new();
        fs::File::open(&file)
            .map_err(|error| error.to_string())?
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("项目进度超过 2 MiB".into());
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("项目进度 JSON 无效：{error}"))?;
        if value["schema"] != "workflow-progress/1" {
            return Err("项目进度 schema 必须为 workflow-progress/1".into());
        }
        let parent = progress_task(source, &file, &value, None, None)?;
        let mut tasks = vec![parent];
        if let Some(children) = value.get("tasks") {
            let children = children.as_array().ok_or("tasks 必须是任务对象数组")?;
            if children.len() > 200 {
                return Err("一个项目最多 200 个进度任务".into());
            }
            let mut ids = std::collections::HashSet::new();
            for child in children {
                let id = progress_text(child.get("id"), 100, "任务标识", None)?;
                if !ids.insert(id.clone()) {
                    return Err("进度任务标识重复".into());
                }
                tasks.push(progress_task(
                    source,
                    &file,
                    child,
                    Some(&id),
                    value.get("workflowId"),
                )?);
            }
        }
        Ok(tasks)
    }

    pub fn current(&self, sources: &[Source]) -> Value {
        let mut tasks = Vec::new();
        for source in sources {
            let mut source_tasks: Vec<_> = self
                .tasks
                .values()
                .filter(|task| task.source_id == source.id)
                .collect();
            source_tasks.sort_by(|left, right| {
                (left.id != source.id, &left.id).cmp(&(right.id != source.id, &right.id))
            });
            tasks.extend(source_tasks);
        }
        json!({ "sources": sources, "tasks": tasks, "sourceHealth": self.source_health, "observedAt": now() })
    }
}

fn progress_text(
    value: Option<&Value>,
    max: usize,
    label: &str,
    default: Option<&str>,
) -> Result<String, String> {
    let raw = match value {
        Some(value) => value.as_str().ok_or_else(|| format!("{label}必须是文本"))?,
        None => default.ok_or_else(|| format!("缺少{label}"))?,
    };
    if raw.trim().is_empty()
        || raw.chars().count() > max
        || raw
            .chars()
            .any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
    {
        return Err(format!("{label}为空、过长或含无效字符"));
    }
    Ok(raw.into())
}

fn optional_progress_id(value: Option<&Value>, label: &str) -> Result<Option<String>, String> {
    value
        .map(|value| progress_text(Some(value), 100, label, None))
        .transpose()
}

fn progress_task(
    source: &Source,
    file: &Path,
    value: &Value,
    child_id: Option<&str>,
    workflow: Option<&Value>,
) -> Result<Task, String> {
    if !value.is_object() {
        return Err("tasks 必须是任务对象数组".into());
    }
    let event_at = progress_timestamp(&value["updatedAt"])?;
    let execution = match value["state"].as_str() {
        Some("running" | "partial" | "rework") => "inProgress",
        Some("complete") => "completed",
        Some("waiting" | "blocked") => "waiting",
        Some("failed") => "failed",
        Some("paused") => "paused",
        Some("pending" | "idle") => "pending",
        _ => return Err("项目进度 state 无效".into()),
    };
    let title = progress_text(
        value.get(if child_id.is_some() {
            "title"
        } else {
            "project"
        }),
        160,
        "任务名称",
        if child_id.is_some() {
            None
        } else {
            Some("项目进度")
        },
    )?;
    let summary = value
        .get(if child_id.is_some() {
            "detail"
        } else {
            "summary"
        })
        .map(|value| value.as_str().ok_or("进展说明必须是文本"))
        .transpose()?
        .unwrap_or("");
    if summary.chars().count() > 6000 {
        return Err("进展说明超过 6000 字".into());
    }
    let acceptance = match value.get("acceptance") {
        None => "unknown",
        Some(value) if value == "accepted" => "accepted",
        Some(value) if value == "unknown" || value == "pending" || value == "rejected" => "unknown",
        Some(value)
            if value.is_object()
                && value.as_object().unwrap().iter().all(|(key, value)| {
                    matches!(key.as_str(), "user" | "visual") && value.is_boolean()
                }) =>
        {
            if value["user"] == true {
                "accepted"
            } else {
                "unknown"
            }
        }
        _ => return Err("成果验收字段无效".into()),
    };
    let status = health(source, "ok", None);
    let messages = if summary.is_empty() {
        vec![]
    } else {
        vec![Message {
            id: "progress".into(),
            phase: "commentary".into(),
            text: summary.into(),
            at: event_at.clone(),
        }]
    };
    Ok(Task {
        id: child_id
            .map(|id| format!("progress:{}", json!([source.id, id])))
            .unwrap_or_else(|| source.id.clone()),
        source_id: source.id.clone(),
        title,
        project_root: source.path.clone(),
        thread_id: None,
        execution: execution.into(),
        source_health: status.clone(),
        acceptance: acceptance.into(),
        messages,
        event_at: Some(event_at),
        observed_at: status.observed_at,
        source_path: file.into(),
        workflow_id: optional_progress_id(value.get("workflowId").or(workflow), "工作流标识")?,
        stage_id: optional_progress_id(
            value.get("stageId").or_else(|| value.get("stage")),
            "阶段标识",
        )?,
        progress: None,
    })
}

fn progress_timestamp(value: &Value) -> Result<String, String> {
    if !value.is_number() {
        return timestamp(value);
    }
    let seconds = value
        .as_f64()
        .filter(|seconds| seconds.is_finite() && seconds.abs() <= 8_640_000_000_000.0)
        .ok_or("来源时间超出可表示范围")?;
    let mut whole = seconds.floor() as i64;
    let mut nanos = ((seconds - seconds.floor()) * 1_000_000_000.0).round() as u32;
    if nanos == 1_000_000_000 {
        whole += 1;
        nanos = 0;
    }
    DateTime::<Utc>::from_timestamp(whole, nanos)
        .map(|date| date.to_rfc3339())
        .ok_or_else(|| "来源时间超出可表示范围".into())
}
