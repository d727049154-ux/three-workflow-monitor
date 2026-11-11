pub mod artifacts;
pub mod history;
pub mod models;
pub mod observation;
pub mod resources;
pub mod storage;
pub mod windows;
pub mod workspace;
use models::Source;
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

pub fn resolve_data_dir(
    default_dir: PathBuf,
    override_dir: Option<PathBuf>,
) -> Result<PathBuf, String> {
    match override_dir {
        Some(path) if path.is_absolute() => Ok(path),
        Some(_) => Err("WORKFLOW_MONITOR_DATA_DIR 必须是非空绝对目录路径".into()),
        None => Ok(default_dir),
    }
}

pub fn startup_error_message(data_dir: &std::path::Path, error: &str) -> String {
    format!(
        "数据目录：{}\n启动失败：{error}\n\n应用关闭后，请按错误原因修复 JSON、缩减配置（上限 512 KiB）或修复文件权限，再重新打开。原文件保留。",
        data_dir.display()
    )
}

pub struct Backend {
    pub data_dir: PathBuf,
    pub sources: Vec<Source>,
    pub monitor: observation::Monitor,
}
impl Backend {
    pub fn new(data_dir: PathBuf) -> Result<Self, String> {
        let config = data_dir.join("sources.json");
        let sources: Vec<Source> = storage::read(&config)?.unwrap_or_default();
        observation::validate_sources(&sources)?;
        Ok(Self {
            data_dir,
            sources,
            monitor: observation::Monitor::default(),
        })
    }

    pub fn call(&mut self, method: &str, args: Value) -> Result<Value, String> {
        if args.to_string().len() > 2 * 1024 * 1024 {
            return Err("调用参数超过 2 MiB".into());
        }
        match method {
            "artifacts" | "artifactTarget" => {
                let view = if let Some(id) = args["snapshotId"].as_str() {
                    history::snapshot(&self.data_dir, id)?["snapshot"].clone()
                } else {
                    self.current()?
                };
                let task = view["tasks"]
                    .as_array()
                    .and_then(|tasks| tasks.iter().find(|task| task["id"] == args["taskId"]))
                    .ok_or("任务不存在")?;
                if method == "artifacts" {
                    Ok(artifacts::list(task))
                } else {
                    Ok(json!(artifacts::open_target(
                        task,
                        args["id"].as_str().ok_or("缺少文件引用标识")?
                    )?))
                }
            }
            "historyList" => history::list(&self.data_dir, &args),
            "historySnapshot" => {
                history::snapshot(&self.data_dir, args["id"].as_str().ok_or("缺少快照标识")?)
            }
            "historyVerify" => history::verify(&self.data_dir),
            "historyExport" => history::export(&self.data_dir, &args),
            "historyAcknowledge" => {
                history::acknowledge(&self.data_dir, args["id"].as_str().ok_or("缺少快照标识")?)
            }
            "historyCheckpoint" => {
                let view = self.current()?;
                history::record(&self.data_dir, &view, true)
            }
            "current" => self.current(),
            "sources" => {
                self.sync_sources()?;
                Ok(json!(self.sources))
            }
            "workspace" => Ok(json!(workspace::load(&self.data_dir)?)),
            "workflowSave" | "workflowDelete" | "workflowPause" | "resourceSave"
            | "resourceDelete" | "resourcePause" | "resourceFavorite" | "resourceRecent"
            | "resourceConnect" | "resourceDisconnect" => {
                self.sync_sources()?;
                workspace::mutate(&self.data_dir, &self.sources, method, args)
            }
            "workflowPrompt" => {
                let workspace = workspace::load(&self.data_dir)?;
                let flow = workspace
                    .workflows
                    .iter()
                    .find(|flow| Some(flow.id.as_str()) == args["id"].as_str())
                    .ok_or("工作流不存在")?;
                Ok(json!({"prompt":workspace::prompt(flow)}))
            }
            "resourcePrompt" => {
                let workspace = workspace::load(&self.data_dir)?;
                let resource =
                    resources::find(&workspace, args["id"].as_str().ok_or("缺少资源标识")?)?;
                if resource.paused {
                    return Err("资源已暂停".into());
                }
                Ok(json!({"prompt":resource.content}))
            }
            "discoverSources" => observation::discover(std::path::Path::new(
                args["path"].as_str().ok_or("缺少会话目录")?,
            )),
            "refresh" => {
                self.sync_sources()?;
                let workspace = workspace::load(&self.data_dir);
                let active: Vec<_> = self
                    .sources
                    .iter()
                    .filter(|source| {
                        let Ok(workspace) = &workspace else {
                            return true;
                        };
                        let matching: Vec<_> = workspace
                            .workflows
                            .iter()
                            .filter(|flow| {
                                flow.source_ids.contains(&source.id)
                                    || (!flow.root.is_empty()
                                        && source.project_root.as_deref().unwrap_or(&source.path)
                                            == std::path::Path::new(&flow.root))
                            })
                            .collect();
                        matching.is_empty() || matching.iter().any(|flow| !flow.paused)
                    })
                    .cloned()
                    .collect();
                self.monitor.refresh(&active);
                let mut view = self.current()?;
                match history::record(&self.data_dir, &view, false) {
                    Ok(record) => view["historyHead"] = record["id"].clone(),
                    Err(error) => view["historyError"] = json!(error),
                }
                Ok(view)
            }
            "configureSources" => {
                self.sync_sources()?;
                if args["expectedRevision"].as_str() != Some(self.sources_revision().as_str()) {
                    return Err("来源配置已在其他窗口更新，请刷新后重试".into());
                }
                let sources: Vec<Source> = serde_json::from_value(args["sources"].clone())
                    .map_err(|error| format!("来源配置无效：{error}"))?;
                observation::validate_sources(&sources)?;
                storage::write(&self.data_dir.join("sources.json"), &sources)?;
                self.sources = sources;
                self.monitor = observation::Monitor::default();
                self.current()
            }
            _ => Err(format!("未知本机方法：{method}")),
        }
    }

    fn sync_sources(&mut self) -> Result<(), String> {
        let sources: Vec<Source> =
            storage::read(&self.data_dir.join("sources.json"))?.unwrap_or_default();
        observation::validate_sources(&sources)?;
        if sources != self.sources {
            self.sources = sources;
            self.monitor = observation::Monitor::default();
        }
        Ok(())
    }

    fn sources_revision(&self) -> String {
        use sha2::{Digest, Sha256};
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&self.sources).unwrap())
        )
    }

    fn current(&mut self) -> Result<Value, String> {
        self.sync_sources()?;
        let mut value = self.monitor.current(&self.sources);
        value["sourcesRevision"] = json!(self.sources_revision());
        match workspace::load(&self.data_dir) {
            Ok(workspace) => {
                value["resourceCatalog"] = resources::catalog(&workspace);
                for task in value["tasks"].as_array_mut().unwrap() {
                    let explicit = task["workflowId"].as_str();
                    let matching: Vec<_> = workspace
                        .workflows
                        .iter()
                        .filter(|flow| {
                            if let Some(id) = explicit {
                                return id == flow.id;
                            }
                            flow.source_ids
                                .iter()
                                .any(|id| Some(id.as_str()) == task["sourceId"].as_str())
                                || (!flow.root.is_empty()
                                    && task["projectRoot"].as_str().is_some_and(|root| {
                                        std::path::Path::new(root)
                                            == std::path::Path::new(&flow.root)
                                    }))
                        })
                        .collect();
                    let flow = if matching.len() == 1 {
                        matching.first().copied()
                    } else {
                        None
                    };
                    if let Some(flow) = flow {
                        task["workflowId"] = json!(flow.id);
                        let stage = flow
                            .stages
                            .iter()
                            .find(|stage| Some(stage.id.as_str()) == task["stageId"].as_str());
                        task["progress"] = json!({"workflowTitle":flow.title,"workflowPaused":flow.paused,"stageLabel":stage.map(|stage| &stage.label),"stageStatus":if task["stageId"].is_null(){"unassigned"}else if stage.is_some(){"known"}else{"removed"}});
                    } else if !task["stageId"].is_null() {
                        task["progress"] = json!({"stageStatus":"removed","stageLabel":null});
                    }
                }
                value["workspace"] = json!(workspace);
            }
            Err(error) => value["workspaceError"] = json!(error),
        }
        Ok(value)
    }
}

use std::sync::{Arc, Condvar, Mutex};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
pub type SharedBackend = Arc<Mutex<Backend>>;
type RefreshPending = Arc<(Mutex<bool>, Condvar)>;

struct RefreshGuard(Option<RefreshPending>);
impl Drop for RefreshGuard {
    fn drop(&mut self) {
        if let Some(pending) = &self.0 {
            if let Ok(mut active) = pending.0.lock() {
                *active = false;
                pending.1.notify_all();
            }
        }
    }
}

fn local_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|error| error.to_string())?;
    let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"));
    if !matches!(window.label(), "main" | "dock") || !local {
        return Err("仅允许应用本机窗口调用".into());
    }
    Ok(())
}

#[tauri::command]
async fn backend_call(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SharedBackend>,
    pending: tauri::State<'_, RefreshPending>,
    writes: tauri::State<'_, Arc<windows::Writes>>,
    mut method: String,
    args: Value,
) -> Result<Value, String> {
    local_window(&window)?;
    let write_guard = writes.inner().begin()?;
    let backend = state.inner().clone();
    let mut guard = RefreshGuard(None);
    let mut coalesced = None;
    if method == "refresh" {
        let mut active = pending.0.lock().map_err(|_| "刷新队列已中断")?;
        if *active {
            method = "current".into();
            coalesced = Some(pending.inner().clone());
        } else {
            *active = true;
            guard.0 = Some(pending.inner().clone());
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _write_guard = write_guard;
        let _guard = guard;
        if let Some(pending) = coalesced {
            let active = pending.0.lock().map_err(|_| "刷新队列已中断")?;
            drop(
                pending
                    .1
                    .wait_while(active, |active| *active)
                    .map_err(|_| "刷新队列已中断")?,
            );
        }
        backend
            .lock()
            .map_err(|_| "工作区调用已中断".to_string())?
            .call(&method, args)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn pick_source(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    kind: Option<String>,
) -> Result<Option<String>, String> {
    local_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let picker = app.dialog().file();
        let selected = if kind.as_deref() == Some("catalog") {
            picker
                .set_title("选择资源 JSON 清单")
                .add_filter("JSON", &["json"])
                .blocking_pick_file()
        } else if kind.as_deref() == Some("file") {
            picker.set_title("选择本机资源文件").blocking_pick_file()
        } else {
            picker.set_title("选择本机目录").blocking_pick_folder()
        };
        selected
            .map(|path| {
                path.into_path()
                    .map(|path| path.to_string_lossy().to_string())
                    .map_err(|error| error.to_string())
            })
            .transpose()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn open_task(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SharedBackend>,
    id: String,
) -> Result<(), String> {
    local_window(&window)?;
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let backend = backend.lock().map_err(|_| "工作区调用已中断")?;
        let source = backend
            .sources
            .iter()
            .find(|source| source.id == id)
            .ok_or("当前来源不存在")?;
        observation::source_file(source)?;
        let target = if source.kind == "codex" {
            let thread =
                uuid::Uuid::parse_str(source.thread_id.as_deref().ok_or("聊天标识不存在")?)
                    .map_err(|_| "聊天标识无效")?;
            format!("codex://threads/{thread}")
        } else {
            fs::canonicalize(&source.path)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .to_string()
        };
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer.exe")
                .arg(target)
                .spawn()
                .map_err(|error| format!("打开来源失败：{error}"))?;
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = target;
            Err("本轮仅支持 Windows 原生打开".into())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn open_resource(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SharedBackend>,
    id: String,
) -> Result<(), String> {
    local_window(&window)?;
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let backend = backend.lock().map_err(|_| "工作区调用已中断")?;
        let workspace = workspace::load(&backend.data_dir)?;
        let target = resources::open_target(&workspace, &id)?;
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", target.display()))
                .spawn()
                .map_err(|error| format!("显示资源失败：{error}"))?;
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = target;
            Err("本轮仅支持 Windows 原生打开".into())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn open_artifact(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SharedBackend>,
    task_id: String,
    id: String,
    snapshot_id: Option<String>,
) -> Result<(), String> {
    local_window(&window)?;
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target = backend.lock().map_err(|_| "工作区调用已中断")?.call(
            "artifactTarget",
            json!({"snapshotId":snapshot_id,"taskId":task_id,"id":id}),
        )?;
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer.exe")
                .arg(format!(
                    "/select,{}",
                    target.as_str().ok_or("文件入口无效")?
                ))
                .spawn()
                .map_err(|e| format!("显示文件失败：{e}"))?;
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = target;
            Err("本轮仅支持 Windows 原生打开".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn export_history(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedBackend>,
    writes: tauri::State<'_, Arc<windows::Writes>>,
    ids: Vec<String>,
) -> Result<Value, String> {
    local_window(&window)?;
    let write_guard = writes.inner().begin()?;
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _write_guard = write_guard;
        let value = backend
            .lock()
            .map_err(|_| "工作区调用已中断")?
            .call("historyExport", json!({"ids":ids}))?;
        let Some(path) = app
            .dialog()
            .file()
            .set_title("导出所选公开观察（不含文件内容）")
            .set_file_name("workflow-observations.json")
            .add_filter("JSON", &["json"])
            .blocking_save_file()
        else {
            return Ok(json!({"cancelled":true}));
        };
        let path = path.into_path().map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("导出失败（请选择新文件名）：{e}"))?;
        use std::io::Write;
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(format!("导出未完成：{error}"));
        }
        Ok(json!({"path":path,"count":value["snapshots"].as_array().map(Vec::len)}))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn window_action(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    action: String,
) -> Result<Value, String> {
    local_window(&window)?;
    windows::action(&app, window.label(), &action).await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = windows::action(&app, "main", "main").await;
            });
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let data_dir = resolve_data_dir(
                app.path().app_data_dir()?,
                std::env::var_os("WORKFLOW_MONITOR_DATA_DIR").map(PathBuf::from),
            )
            .map_err(std::io::Error::other)?;
            let window_store = windows::WindowStore::load(data_dir.clone());
            let backend = match Backend::new(data_dir.clone()) {
                Ok(backend) => backend,
                Err(error) => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                    let handle = app.handle().clone();
                    app.dialog()
                        .message(startup_error_message(&data_dir, &error))
                        .title("无法启动工作流观察")
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                        .show(move |_| handle.exit(1));
                    return Ok(());
                }
            };
            app.manage(Arc::new(Mutex::new(backend)));
            app.manage(Arc::new(Mutex::new(window_store)));
            app.manage(Arc::new(windows::Writes::default()));
            app.manage(windows::WindowActions::new(()));
            app.manage(Arc::new((Mutex::new(false), Condvar::new())));
            windows::initialize(app.handle()).map_err(std::io::Error::other)?;
            windows::observe_while_hidden(app.handle().clone());
            Ok(())
        })
        .on_window_event(windows::event)
        .invoke_handler(tauri::generate_handler![
            backend_call,
            pick_source,
            open_task,
            open_resource,
            open_artifact,
            export_history,
            window_action
        ])
        .run(tauri::generate_context!())
        .expect("工作流观察启动失败；请检查应用数据目录与 sources.json");
}
