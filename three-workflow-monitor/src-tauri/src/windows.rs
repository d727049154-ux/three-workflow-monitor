use crate::storage;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

// 退出闸门：tao 事件循环进入 Destroyed 后再做窗口操作会 panic（cannot move state from Destroyed）。
pub static EXITING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}
impl Bounds {
    pub fn fit(self, areas: &[Self]) -> Self {
        let area = areas
            .iter()
            .find(|area| {
                self.x >= area.x
                    && self.x < area.x + area.width as i32
                    && self.y >= area.y
                    && self.y < area.y + area.height as i32
            })
            .or(areas.first());
        let Some(area) = area else {
            return self;
        };
        let width = self.width.max(1).min(area.width.max(1));
        let height = self.height.max(1).min(area.height.max(1));
        Self {
            x: self.x.clamp(area.x, area.x + (area.width - width) as i32),
            y: self.y.clamp(area.y, area.y + (area.height - height) as i32),
            width,
            height,
        }
    }
    pub fn scaled(self, scale: f64) -> Self {
        Self {
            x: (self.x as f64 * scale).round() as i32,
            y: (self.y as f64 * scale).round() as i32,
            width: ((self.width as f64 * scale).round() as u32).max(1),
            height: ((self.height as f64 * scale).round() as u32).max(1),
        }
    }
    pub fn snap(self, area: Self, side: &str) -> Self {
        let mut fitted = self.fit(&[area]);
        fitted.x = if side == "right" {
            area.x + (area.width - fitted.width) as i32
        } else {
            area.x
        };
        fitted
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Presentation {
    pub bounds: Bounds,
    pub visible: bool,
    pub pinned: bool,
    pub compact: bool,
    pub expanded: bool,
    pub side: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Preferences {
    pub schema: String,
    pub main: Presentation,
    pub dock: Presentation,
}
impl Default for Preferences {
    fn default() -> Self {
        let main = Presentation {
            bounds: Bounds {
                x: 80,
                y: 60,
                width: 460,
                height: 780,
            },
            visible: true,
            pinned: false,
            compact: false,
            expanded: false,
            side: "left".into(),
        };
        let dock = Presentation {
            bounds: Bounds {
                x: 0,
                y: 80,
                width: 108,
                height: 680,
            },
            visible: false,
            pinned: true,
            compact: false,
            expanded: false,
            side: "left".into(),
        };
        Self {
            schema: "workflow-windows/1".into(),
            main,
            dock,
        }
    }
}
pub struct WindowStore {
    path: PathBuf,
    pub preferences: Preferences,
    pub warning: Option<String>,
    pub fresh: bool,
}
impl WindowStore {
    pub fn load(data_dir: PathBuf) -> Self {
        let path = data_dir.join("windows.json");
        let existed = path.exists();
        let result = storage::read::<Preferences>(&path).and_then(|value| {
            let value = value.unwrap_or_default();
            if value.schema != "workflow-windows/1"
                || [&value.main, &value.dock].iter().any(|p| {
                    p.bounds.width == 0
                        || p.bounds.height == 0
                        || p.bounds.width > 32768
                        || p.bounds.height > 32768
                        || p.bounds.x.abs_diff(0) > 131072
                        || p.bounds.y.abs_diff(0) > 131072
                        || !matches!(p.side.as_str(), "left" | "right")
                })
            {
                return Err("窗口配置格式无效；请关闭应用后修复 windows.json，原文件保留".into());
            }
            Ok(value)
        });
        match result {
            Ok(preferences) => Self {
                path,
                preferences,
                warning: None,
                fresh: !existed,
            },
            Err(error) => Self {
                path,
                preferences: Preferences::default(),
                warning: Some(error),
                fresh: false,
            },
        }
    }
    pub fn save(&mut self, preferences: Preferences) -> Result<(), String> {
        if let Some(warning) = &self.warning {
            return Err(warning.clone());
        }
        storage::write(&self.path, &preferences)?;
        self.preferences = preferences;
        Ok(())
    }
}
pub type SharedWindows = Arc<Mutex<WindowStore>>;
pub type WindowActions = tauri::async_runtime::Mutex<()>;

// Count accepted writes before scheduling them, so normal quit drains queued work too.
#[derive(Default)]
pub struct Writes {
    state: Mutex<(bool, usize)>,
    done: Condvar,
}
pub struct WriteGuard(Arc<Writes>);
impl Writes {
    pub fn begin(self: &Arc<Self>) -> Result<WriteGuard, String> {
        let mut state = self.state.lock().map_err(|_| "退出队列已中断")?;
        if state.0 {
            return Err("应用正在退出".into());
        }
        state.1 += 1;
        Ok(WriteGuard(self.clone()))
    }
    pub fn drain(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.0 = true;
            // 有界等待：导出等交互可能长期占用写入名额，不能无限阻塞退出。
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                if state.1 == 0 {
                    break;
                }
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                if left.is_zero() {
                    break;
                }
                match self.done.wait_timeout(state, left) {
                    Ok((guard, _)) => state = guard,
                    Err(_) => break,
                }
            }
        }
    }
}
impl Drop for WriteGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.state.lock() {
            state.1 -= 1;
            self.0.done.notify_all();
        }
    }
}

fn areas(app: &tauri::AppHandle) -> Result<Vec<Bounds>, String> {
    app.available_monitors()
        .map(|monitors| {
            monitors
                .iter()
                .map(|monitor| {
                    let area = monitor.work_area();
                    Bounds {
                        x: area.position.x,
                        y: area.position.y,
                        width: area.size.width,
                        height: area.size.height,
                    }
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}
fn apply(window: &tauri::WebviewWindow, p: &Presentation, areas: &[Bounds]) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let mut bounds = p.bounds;
    if window.label() == "dock" {
        bounds.width = (if p.expanded { 440.0 } else { 108.0 } * scale) as u32;
    } else if p.compact {
        bounds.height = (270.0 * scale) as u32;
    }
    bounds = bounds.fit(areas);
    if window.label() == "dock" {
        if let Some(area) = areas
            .iter()
            .find(|a| bounds.x >= a.x && bounds.x < a.x + a.width as i32)
        {
            bounds = bounds.snap(*area, &p.side);
        }
    }
    window
        .set_min_size(Some(tauri::LogicalSize::new(
            if window.label() == "dock" {
                108.0
            } else {
                360.0
            },
            if p.compact {
                240.0
            } else if window.label() == "dock" {
                360.0
            } else {
                420.0
            },
        )))
        .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::PhysicalSize::new(bounds.width, bounds.height))
        .map_err(|e| e.to_string())?;
    window
        .set_position(tauri::PhysicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| e.to_string())?;
    window
        .set_always_on_top(p.pinned)
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn state(app: &tauri::AppHandle, label: &str) -> Result<Value, String> {
    let store = app.state::<SharedWindows>();
    let store = store.lock().map_err(|_| "窗口配置已中断")?;
    Ok(
        json!({"presentation":if label=="dock"{&store.preferences.dock}else{&store.preferences.main},"warning":store.warning}),
    )
}
pub fn request_quit(app: tauri::AppHandle) {
    EXITING.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let writes = app.state::<Arc<Writes>>().inner().clone();
        let _ = tauri::async_runtime::spawn_blocking(move || writes.drain()).await;
        let store = app.state::<SharedWindows>();
        if let Ok(mut store) = store.lock() {
            let preferences = store.preferences.clone();
            let _ = store.save(preferences);
        }
        app.exit(0);
    });
}
pub async fn action(app: &tauri::AppHandle, label: &str, action: &str) -> Result<Value, String> {
    if EXITING.load(Ordering::SeqCst) {
        return Err("应用正在退出".into());
    }
    if action == "help" {
        let data_dir = app
            .state::<crate::SharedBackend>()
            .lock()
            .map_err(|_| "工作区调用已中断")?
            .data_dir
            .display()
            .to_string();
        app.dialog()
            .message(format!(
                "{}\n\n当前数据目录：{data_dir}",
                include_str!("../HELP.md")
            ))
            .title("工作流观察 · 帮助与恢复")
            .show(|_| {});
        return Ok(json!({"shown": true}));
    }
    if action == "quit" {
        request_quit(app.clone());
        return Ok(json!({"quitting":true}));
    }
    if action == "state" {
        return state(app, label);
    }
    let _write = app.state::<Arc<Writes>>().inner().begin()?;
    let queue = app.state::<WindowActions>();
    let _action = queue.lock().await;
    let target = if matches!(action, "main" | "reset") {
        "main"
    } else if action == "dock" {
        "dock"
    } else {
        label
    };
    let (mut preferences, warning) = {
        let store = app.state::<SharedWindows>();
        let store = store.lock().map_err(|_| "窗口配置已中断")?;
        (store.preferences.clone(), store.warning.clone())
    };
    let p = if target == "dock" {
        &mut preferences.dock
    } else {
        &mut preferences.main
    };
    match action {
        "main" | "dock" | "show" => p.visible = true,
        "hide" | "close" => p.visible = false,
        "pin" => p.pinned = !p.pinned,
        "compact" if target == "main" => p.compact = !p.compact,
        "expand" if target == "dock" => p.expanded = !p.expanded,
        "left" | "right" if target == "dock" => p.side = action.into(),
        "reset" => {
            preferences.main.bounds = Preferences::default().main.bounds;
            preferences.main.visible = true;
            preferences.main.compact = false;
            preferences.dock.bounds = Preferences::default().dock.bounds;
        }
        "drag" => {
            app.get_webview_window(target)
                .ok_or("窗口不存在")?
                .start_dragging()
                .map_err(|e| e.to_string())?;
            return state(app, target);
        }
        _ => return Err("未知窗口操作".into()),
    }
    let p = if target == "dock" {
        preferences.dock.clone()
    } else {
        preferences.main.clone()
    };
    // No preferences lock is held while Tauri waits for the UI thread.
    let window = if let Some(window) = app.get_webview_window(target) {
        window
    } else if target == "dock" {
        if !p.visible {
            return state(app, target);
        }
        tauri::WebviewWindowBuilder::new(app, "dock", tauri::WebviewUrl::App("dock.html".into()))
            .title("任务条")
            .inner_size(108.0, 680.0)
            .decorations(false)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?
    } else {
        return Err("主窗口不存在".into());
    };
    apply(&window, &p, &areas(app)?)?;
    if action == "reset" {
        if let Some(dock) = app.get_webview_window("dock") {
            apply(&dock, &preferences.dock, &areas(app)?)?;
        }
    }
    if p.visible {
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        window.hide().map_err(|e| e.to_string())?;
    }
    {
        let store = app.state::<SharedWindows>();
        let mut store = store.lock().map_err(|_| "窗口配置已中断")?;
        store.preferences = preferences.clone();
        if warning.is_none() {
            store.save(preferences)?;
        }
    }
    let value = state(app, target)?;
    // Emitter::emit broadcasts even on a window; presentation belongs only to this target.
    window
        .emit_to(target, "window-presentation", &value)
        .map_err(|e| e.to_string())?;
    Ok(value)
}
pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    let (mut main, dock, fresh) = {
        let store = app.state::<SharedWindows>();
        let store = store.lock().map_err(|_| "窗口配置已中断")?;
        (
            store.preferences.main.clone(),
            store.preferences.dock.clone(),
            store.fresh,
        )
    };
    let window = app.get_webview_window("main").ok_or("主窗口不存在")?;
    if fresh {
        // 默认 bounds 按逻辑像素书写；首启动换算为物理像素再应用，避免高缩放下窗口偏小。
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        main.bounds = main.bounds.scaled(scale);
        let store = app.state::<SharedWindows>();
        let mut guard = store.lock().map_err(|_| "窗口配置已中断")?;
        guard.preferences.main = main.clone();
    }
    apply(&window, &main, &areas(app)?)?;
    if !main.visible && dock.visible {
        window.hide().map_err(|e| e.to_string())?;
    } else if !main.visible {
        let store = app.state::<SharedWindows>();
        store
            .lock()
            .map_err(|_| "窗口配置已中断")?
            .preferences
            .main
            .visible = true;
    }
    if dock.visible {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = action(&app, "main", "dock").await;
        });
    }
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };
    let items = [
        ("main", "显示完整面板"),
        ("hide-main", "隐藏完整面板"),
        ("dock", "显示任务条"),
        ("hide-dock", "隐藏任务条"),
        ("reset", "找回窗口"),
        ("help", "帮助与恢复"),
        ("quit", "退出"),
    ]
    .into_iter()
    .map(|(id, text)| MenuItem::with_id(app, id, text, true, None::<&str>))
    .collect::<tauri::Result<Vec<_>>>()
    .map_err(|e| e.to_string())?;
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        items.iter().map(|item| item as _).collect();
    let menu = Menu::with_items(app, &refs).map_err(|e| e.to_string())?;
    let mut tray = TrayIconBuilder::new()
        .tooltip("工作流观察")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let app = app.clone();
            let action = event.id.as_ref().to_string();
            tauri::async_runtime::spawn(async move {
                let (label, action) = if let Some(label) = action.strip_prefix("hide-") {
                    (label, "hide")
                } else {
                    ("main", action.as_str())
                };
                let _ = self::action(&app, label, action).await;
            });
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                let app = tray.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = action(&app, "main", "main").await;
                });
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn observe_while_hidden(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(5));
        let writes = app.state::<Arc<Writes>>().inner().clone();
        let Ok(_guard) = writes.begin() else { break };
        let hidden = {
            let store = app.state::<SharedWindows>();
            let Ok(store) = store.lock() else { break };
            !store.preferences.main.visible && !store.preferences.dock.visible
        };
        if hidden {
            let backend = app.state::<crate::SharedBackend>();
            if let Ok(mut backend) = backend.lock() {
                let _ = backend.call("refresh", json!({}));
            };
        }
    });
}

pub fn event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let app = window.app_handle();
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if EXITING.load(Ordering::SeqCst) {
            // 关机/注销/退出过程中放行真实关闭，绝不再触发窗口操作。
            return;
        }
        api.prevent_close();
        let app = app.clone();
        let label = window.label().to_string();
        tauri::async_runtime::spawn(async move {
            let _ = action(&app, &label, "hide").await;
        });
        return;
    }
    let Some(store) = app.try_state::<SharedWindows>() else {
        return;
    };
    if let Ok(mut store) = store.lock() {
        let p = if window.label() == "dock" {
            &mut store.preferences.dock
        } else {
            &mut store.preferences.main
        };
        match event {
            tauri::WindowEvent::Moved(position) => {
                p.bounds.x = position.x;
                p.bounds.y = position.y;
            }
            tauri::WindowEvent::Resized(size)
                if !p.compact && size.width > 0 && size.height > 0 =>
            {
                p.bounds.width = size.width;
                p.bounds.height = size.height;
            }
            _ => {}
        }
    };
}
