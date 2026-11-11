use serde_json::{json, Value};
use std::io::Write;
use std::{fs, path::PathBuf};
use workflow_monitor::Backend;

const THREAD: &str = "1d401e5b-64c7-47a0-9ddb-6cfe809547d1";

#[test]
fn application_data_override_requires_an_explicit_absolute_directory() {
    let default = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("default-data");
    let selected = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("selected-data");
    assert_eq!(
        workflow_monitor::resolve_data_dir(default.clone(), None).unwrap(),
        default
    );
    assert_eq!(
        workflow_monitor::resolve_data_dir(default.clone(), Some(selected.clone())).unwrap(),
        selected
    );
    assert!(workflow_monitor::resolve_data_dir(default.clone(), Some(PathBuf::new())).is_err());
    assert!(
        workflow_monitor::resolve_data_dir(default, Some(PathBuf::from("relative-data"))).is_err()
    );
}
fn append(root: &PathBuf, record: Value) {
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(root.join("sessions/chat.jsonl"))
        .unwrap();
    writeln!(file, "{}", record).unwrap();
}
fn event(kind: &str) -> Value {
    json!({"type":"event_msg","timestamp":"2026-11-09T10:01:00Z","payload":{"type":kind,"turn_id":"turn-2"}})
}
fn codex_source(root: &PathBuf) -> Value {
    fs::create_dir_all(root.join("sessions")).unwrap();
    fs::write(
        root.join("sessions/chat.jsonl"),
        format!(
            "{}\n",
            json!({"type":"session_meta","payload":{"id":THREAD,"cwd":root.join("project")}})
        ),
    )
    .unwrap();
    json!({"id":"chat","kind":"codex","path":root.join("sessions"),"sessionFile":"chat.jsonl","threadId":THREAD,"projectRoot":root.join("project")})
}

fn fixture() -> (PathBuf, Backend) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch/test-temp")
        .join(format!("workflow-observation-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("project")).unwrap();
    let backend = Backend::new(root.join("data")).unwrap();
    (root, backend)
}

#[test]
fn sequential_large_tool_lines_and_partial_utf8_never_hide_new_turn() {
    let (root, mut backend) = fixture();
    let source = codex_source(&root);
    append(&root, event("task_complete"));
    configure(&mut backend, json!({"sources":[source]})).unwrap();
    assert_eq!(
        backend.call("refresh", json!({})).unwrap()["tasks"][0]["execution"],
        "completed"
    );
    append(&root, event("task_started"));
    append(
        &root,
        json!({"type":"response_item","payload":{"type":"function_call_output","output":"x".repeat(5*1024*1024)}}),
    );
    let message = json!({"type":"response_item","timestamp":"2026-11-09T10:02:00Z","payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"继续处理中文进展"}]}}).to_string();
    let cut = message.find("中文").unwrap() + 1;
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(root.join("sessions/chat.jsonl"))
        .unwrap();
    file.write_all(&message.as_bytes()[..cut]).unwrap();
    let catching = backend.call("refresh", json!({})).unwrap();
    assert_eq!(catching["tasks"][0]["execution"], "inProgress");
    assert_eq!(catching["sourceHealth"][0]["state"], "catchingUp");
    let partial = backend.call("refresh", json!({})).unwrap();
    assert_eq!(partial["tasks"][0]["messages"], json!([]));
    assert_eq!(partial["sourceHealth"][0]["state"], "catchingUp");
    file.write_all(&message.as_bytes()[cut..]).unwrap();
    file.write_all(b"\n").unwrap();
    append(
        &root,
        json!({"type":"response_item","timestamp":"2026-11-09T10:02:00Z","payload":{"type":"message","role":"assistant","phase":"analysis","content":[{"type":"output_text","text":"private reasoning"}]}}),
    );
    let view = backend.call("refresh", json!({})).unwrap();
    assert_eq!(view["tasks"][0]["messages"][0]["text"], "继续处理中文进展");
    assert_eq!(view["tasks"][0]["messages"].as_array().unwrap().len(), 1);
    append(&root, event("task_complete"));
    assert_eq!(
        backend.call("refresh", json!({})).unwrap()["tasks"][0]["execution"],
        "completed"
    );
    fs::remove_dir_all(root).unwrap();
}
fn progress_source(root: &PathBuf) -> Value {
    json!({"id":"project","kind":"progress","path":root.join("project")})
}
#[test]
fn selected_project_is_shared_current_truth_and_clear_removes_it() {
    let (root, mut backend) = fixture();
    assert_eq!(
        backend.call("current", json!({})).unwrap()["tasks"],
        json!([])
    );
    fs::write(root.join("project/workflow-progress.json"), json!({"schema":"workflow-progress/1","project":"演示项目","state":"running","summary":"公开进展","updatedAt":"2026-11-09T10:00:00Z"}).to_string()).unwrap();
    configure(&mut backend, json!({"sources":[progress_source(&root)]})).unwrap();
    let view = backend.call("refresh", json!({})).unwrap();
    assert_eq!(view["tasks"][0]["execution"], "inProgress");
    assert_eq!(view["tasks"][0]["acceptance"], "unknown");
    assert_eq!(
        backend.call("current", json!({})).unwrap()["tasks"],
        view["tasks"]
    );
    configure(&mut backend, json!({"sources":[]})).unwrap();
    assert_eq!(
        backend.call("refresh", json!({})).unwrap()["tasks"],
        json!([])
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn explicit_discovery_lists_verified_candidates_without_enabling_them() {
    let (root, mut backend) = fixture();
    codex_source(&root);
    let candidates = backend
        .call("discoverSources", json!({"path":root.join("sessions")}))
        .unwrap();
    assert_eq!(candidates[0]["threadId"], THREAD);
    assert_eq!(backend.call("sources", json!({})).unwrap(), json!([]));
    assert_eq!(
        backend.call("refresh", json!({})).unwrap()["tasks"],
        json!([])
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn bad_source_is_isolated_last_execution_survives_and_recovers() {
    let (root, mut backend) = fixture();
    let source = codex_source(&root);
    append(&root, event("task_started"));
    fs::write(root.join("project/workflow-progress.json"), json!({"schema":"workflow-progress/1","project":42,"state":"running","updatedAt":"invalid"}).to_string()).unwrap();
    configure(
        &mut backend,
        json!({"sources":[source, progress_source(&root)]}),
    )
    .unwrap();
    let view = backend.call("refresh", json!({})).unwrap();
    assert_eq!(view["tasks"][0]["execution"], "inProgress");
    assert_eq!(view["sourceHealth"][1]["state"], "error");
    fs::rename(
        root.join("sessions/chat.jsonl"),
        root.join("sessions/held.jsonl"),
    )
    .unwrap();
    let unavailable = backend.call("refresh", json!({})).unwrap();
    assert_eq!(unavailable["tasks"][0]["execution"], "inProgress");
    assert_eq!(unavailable["tasks"][0]["sourceHealth"]["state"], "error");
    fs::rename(
        root.join("sessions/held.jsonl"),
        root.join("sessions/chat.jsonl"),
    )
    .unwrap();
    append(&root, event("task_complete"));
    assert_eq!(
        backend.call("refresh", json!({})).unwrap()["tasks"][0]["execution"],
        "completed"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn identity_mismatch_never_exposes_progress_and_empty_switch_removes_cache() {
    let (root, mut backend) = fixture();
    let source = codex_source(&root);
    append(&root, event("task_started"));
    configure(&mut backend, json!({"sources":[source.clone()]})).unwrap();
    assert_eq!(
        backend.call("refresh", json!({})).unwrap()["tasks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut mismatched = source.clone();
    mismatched["threadId"] = json!("d5a5757f-b1bd-40f3-9440-90d4dddb2b64");
    configure(&mut backend, json!({"sources":[mismatched]})).unwrap();
    let rejected = backend.call("refresh", json!({})).unwrap();
    assert_eq!(rejected["tasks"], json!([]));
    assert!(rejected["sourceHealth"][0]["issue"]
        .as_str()
        .unwrap()
        .contains("标识不匹配"));
    configure(&mut backend, json!({"sources":[source]})).unwrap();
    backend.call("refresh", json!({})).unwrap();
    fs::create_dir_all(root.join("empty")).unwrap();
    configure(
        &mut backend,
        json!({"sources":[{"id":"empty","kind":"progress","path":root.join("empty")}]}),
    )
    .unwrap();
    assert_eq!(
        backend.call("refresh", json!({})).unwrap()["tasks"],
        json!([])
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn saved_sources_reopen_without_scanning_and_temporarily_missing_path_does_not_block_boot() {
    let (root, mut backend) = fixture();
    configure(&mut backend, json!({"sources":[progress_source(&root)]})).unwrap();
    fs::remove_dir(root.join("project")).unwrap();
    let mut reopened = Backend::new(root.join("data")).unwrap();
    assert_eq!(
        reopened.call("sources", json!({})).unwrap()[0]["id"],
        "project"
    );
    assert_eq!(
        reopened.call("current", json!({})).unwrap()["tasks"],
        json!([])
    );
    assert_eq!(
        reopened.call("refresh", json!({})).unwrap()["sourceHealth"][0]["state"],
        "error"
    );
    fs::remove_dir_all(root).unwrap();
}

fn configure(backend: &mut Backend, mut args: Value) -> Result<Value, String> {
    args["expectedRevision"] = backend.call("current", json!({}))?["sourcesRevision"].clone();
    backend.call("configureSources", args)
}
