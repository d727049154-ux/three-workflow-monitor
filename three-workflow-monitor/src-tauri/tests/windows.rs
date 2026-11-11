use serde_json::json;
use std::fs;
use workflow_monitor::windows::{Bounds, Preferences, WindowStore};

#[test]
fn window_preferences_reopen_from_selected_data_directory_and_keep_normal_size() {
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch/test-temp")
        .join(format!("window-test-{}", uuid::Uuid::new_v4()));
    let mut store = WindowStore::load(dir.clone());
    let mut preferences = store.preferences.clone();
    preferences.main.compact = true;
    preferences.main.bounds = Bounds {
        x: -1800,
        y: 60,
        width: 640,
        height: 900,
    };
    preferences.dock.visible = true;
    preferences.dock.side = "right".into();
    store.save(preferences.clone()).unwrap();
    assert_eq!(WindowStore::load(dir.clone()).preferences, preferences);
    assert!(dir.join("windows.json").exists());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn unreadable_preferences_warn_and_reject_overwrite_until_explicit_recovery() {
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch/test-temp")
        .join(format!("window-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("windows.json"), "broken").unwrap();
    let mut store = WindowStore::load(dir.clone());
    assert!(store.warning.is_some());
    assert!(store.save(Preferences::default()).is_err());
    assert_eq!(
        fs::read_to_string(dir.join("windows.json")).unwrap(),
        "broken"
    );
    fs::write(
        dir.join("windows.json"),
        json!({"schema":"window/99"}).to_string(),
    )
    .unwrap();
    assert!(WindowStore::load(dir.clone()).warning.is_some());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn missing_monitor_restores_inside_available_work_area_and_snap_respects_negative_coordinates() {
    let saved = Bounds {
        x: 8000,
        y: -4000,
        width: 2000,
        height: 2000,
    };
    let area = Bounds {
        x: -1920,
        y: 0,
        width: 1920,
        height: 1040,
    };
    assert_eq!(
        saved.fit(&[area]),
        Bounds {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1040
        }
    );
    assert_eq!(
        Bounds {
            x: -1400,
            y: 100,
            width: 108,
            height: 650
        }
        .snap(area, "right"),
        Bounds {
            x: -108,
            y: 100,
            width: 108,
            height: 650
        }
    );
}

#[test]
fn normal_quit_waits_for_accepted_writes_and_refuses_new_work() {
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    let writes = Arc::new(workflow_monitor::windows::Writes::default());
    let guard = writes.begin().unwrap();
    let (tx, rx) = mpsc::channel();
    let queue = writes.clone();
    std::thread::spawn(move || {
        queue.drain();
        tx.send(()).unwrap();
    });
    assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());
    drop(guard);
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(writes.begin().is_err());
}
