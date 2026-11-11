use std::{fs, path::PathBuf};
use workflow_monitor::{startup_error_message, storage::MAX_WORKSPACE_BYTES, Backend};

fn assert_startup_recovery(contents: &[u8], expected_error: &str) {
    let data_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch/test-temp")
        .join(format!("startup-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&data_dir).unwrap();
    let config = data_dir.join("sources.json");
    fs::write(&config, contents).unwrap();
    let error = Backend::new(data_dir.clone())
        .err()
        .expect("invalid sources must reject startup");
    assert!(error.contains(expected_error), "{error}");
    let message = startup_error_message(&data_dir, &error);
    assert!(message.contains(&data_dir.display().to_string()));
    assert!(message.contains(&error));
    assert!(message.contains("应用关闭后"));
    assert!(message.contains("修复 JSON"));
    assert!(message.contains("缩减配置"));
    assert!(message.contains("文件权限"));
    assert!(message.contains("重新打开"));
    assert_eq!(fs::read(&config).unwrap(), contents);
    assert_eq!(fs::read_dir(&data_dir).unwrap().count(), 1);
    fs::remove_dir_all(data_dir).unwrap();
}

#[test]
fn corrupt_sources_reject_startup_with_recovery_details_and_preserve_file() {
    assert_startup_recovery(b"{broken", "配置损坏");
}

#[test]
fn oversized_sources_reject_startup_with_recovery_details_and_preserve_file() {
    assert_startup_recovery(&vec![b' '; MAX_WORKSPACE_BYTES + 1], "超过 512 KiB");
}
