use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use workflow_monitor::Backend;

fn fixture() -> (PathBuf, Backend) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch/test-temp")
        .join(format!("history-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("project")).unwrap();
    let mut backend = Backend::new(root.join("data")).unwrap();
    let revision = backend.call("current", json!({})).unwrap()["sourcesRevision"].clone();
    backend.call("configureSources", json!({"expectedRevision":revision,"sources":[{"id":"project","kind":"progress","path":root.join("project")}]})).unwrap();
    fs::write(root.join("project/workflow-progress.json"), json!({"schema":"workflow-progress/1","project":"译稿出版","state":"complete","summary":"公开答复：`result.txt`","updatedAt":"2026-11-09T10:00:00Z"}).to_string()).unwrap();
    (root, backend)
}
fn list(backend: &mut Backend) -> Value {
    backend.call("historyList", json!({})).unwrap()
}

#[test]
fn unchanged_polls_reopen_and_source_clear_preserve_history_without_restoring_live_tasks() {
    let (root, mut backend) = fixture();
    backend.call("refresh", json!({})).unwrap();
    let before = list(&mut backend);
    let id = before["items"][0]["id"].clone();
    backend.call("refresh", json!({})).unwrap();
    assert_eq!(list(&mut backend)["total"], before["total"]);
    let mut reopened = Backend::new(root.join("data")).unwrap();
    assert_eq!(
        reopened.call("current", json!({})).unwrap()["tasks"],
        json!([])
    );
    let snapshot = reopened.call("historySnapshot", json!({"id":id})).unwrap();
    assert_eq!(snapshot["snapshot"]["tasks"][0]["execution"], "completed");
    assert_eq!(snapshot["snapshot"]["tasks"][0]["acceptance"], "unknown");
    let revision = reopened.call("current", json!({})).unwrap()["sourcesRevision"].clone();
    reopened
        .call(
            "configureSources",
            json!({"expectedRevision":revision,"sources":[]}),
        )
        .unwrap();
    assert_eq!(
        reopened.call("refresh", json!({})).unwrap()["tasks"],
        json!([])
    );
    assert_eq!(
        reopened.call("historySnapshot", json!({"id":id})).unwrap(),
        snapshot
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn checkpoints_are_distinct_acknowledgements_reopen_and_exports_are_selected_public_observations() {
    let (root, mut backend) = fixture();
    let revision = backend.call("workspace", json!({})).unwrap()["revision"].clone();
    backend.call("resourceSave",json!({"expectedRevision":revision,"resource":{"title":"私有资源","kind":"prompt","category":"参考","content":"RESOURCE_SECRET"}})).unwrap();
    backend.call("refresh", json!({})).unwrap();
    let first = backend.call("historyCheckpoint", json!({})).unwrap();
    let second = backend.call("historyCheckpoint", json!({})).unwrap();
    assert_ne!(first["id"], second["id"]);
    backend
        .call("historyAcknowledge", json!({"id":first["id"]}))
        .unwrap();
    let mut reopened = Backend::new(root.join("data")).unwrap();
    let page = reopened
        .call("historyList", json!({"beforeId":second["id"],"limit":1}))
        .unwrap();
    assert_eq!(page["items"][0]["id"], first["id"]);
    assert_eq!(page["items"][0]["acknowledged"], true);
    let exported = reopened
        .call("historyExport", json!({"ids":[first["id"]]}))
        .unwrap();
    assert_eq!(exported["snapshots"].as_array().unwrap().len(), 1);
    assert!(!exported.to_string().contains("RESOURCE_SECRET"));
    assert!(exported["snapshots"][0]["snapshot"]
        .get("workspace")
        .is_none());
    assert_eq!(
        reopened.call("historyVerify", json!({})).unwrap()["valid"],
        true
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn public_file_references_recheck_availability_and_cannot_escape_the_recorded_root() {
    let (root, mut backend) = fixture();
    fs::write(root.join("project/result.txt"), "original").unwrap();
    fs::write(root.join("outside.txt"), "private").unwrap();
    fs::write(root.join("project/workflow-progress.json"),json!({"schema":"workflow-progress/1","project":"译稿出版","state":"complete","summary":"[交稿](result.txt) `../outside.txt`","updatedAt":"2026-11-09T10:00:00Z"}).to_string()).unwrap();
    backend.call("refresh", json!({})).unwrap();
    let id = list(&mut backend)["items"][0]["id"].clone();
    let args = json!({"snapshotId":id,"taskId":"project"});
    let files = backend.call("artifacts", args.clone()).unwrap();
    assert_eq!(files["items"][0]["available"], true);
    assert_eq!(files["items"][1]["available"], false);
    assert!(backend
        .call(
            "artifactTarget",
            json!({"snapshotId":id,"taskId":"project","id":files["items"][1]["id"]})
        )
        .is_err());
    fs::remove_file(root.join("project/result.txt")).unwrap();
    let reopened_files = Backend::new(root.join("data"))
        .unwrap()
        .call("artifacts", args)
        .unwrap();
    assert_eq!(reopened_files["items"][0]["available"], false);
    assert_eq!(
        backend.call("historySnapshot", json!({"id":id})).unwrap()["snapshot"]["tasks"][0]
            ["messages"][0]["text"],
        "[交稿](result.txt) `../outside.txt`"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn damaged_history_blocks_append_and_export_without_replacing_original_records() {
    let (root, mut backend) = fixture();
    backend.call("refresh", json!({})).unwrap();
    let id = list(&mut backend)["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let file = root.join("data/history").join(format!("{id}.json"));
    let mut damaged: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    damaged["snapshot"]["tasks"][0]["execution"] = json!("failed");
    let bytes = serde_json::to_vec(&damaged).unwrap();
    fs::write(&file, &bytes).unwrap();
    let mut reopened = Backend::new(root.join("data")).unwrap();
    assert!(reopened
        .call("historyVerify", json!({}))
        .unwrap_err()
        .contains("校验链损坏"));
    assert!(reopened.call("historyCheckpoint", json!({})).is_err());
    assert!(reopened.call("historyExport", json!({"ids":[id]})).is_err());
    let live = reopened.call("refresh", json!({})).unwrap();
    assert_eq!(live["tasks"][0]["execution"], "completed");
    assert!(live["historyError"]
        .as_str()
        .unwrap()
        .contains("校验链损坏"));
    assert_eq!(fs::read(file).unwrap(), bytes);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn selected_export_rejects_invalid_ids_and_oversize_before_parsing_records() {
    let (root, mut backend) = fixture();
    backend.call("refresh", json!({})).unwrap();
    assert!(backend
        .call("historyExport", json!({"ids":["../workspace"]}))
        .is_err());
    assert!(backend
        .call("historyExport", json!({"ids":["测".repeat(19)]}))
        .is_err());
    let id = list(&mut backend)["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let file = root.join("data/history").join(format!("{id}.json"));
    fs::OpenOptions::new()
        .write(true)
        .open(&file)
        .unwrap()
        .set_len(9 * 1024 * 1024)
        .unwrap();
    assert!(backend
        .call("historyExport", json!({"ids":[id]}))
        .unwrap_err()
        .contains("8 MiB"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn appending_new_observations_does_not_shift_the_next_history_page() {
    let (root, mut backend) = fixture();
    let first = backend.call("historyCheckpoint", json!({})).unwrap();
    let second = backend.call("historyCheckpoint", json!({})).unwrap();
    let page = backend.call("historyList", json!({"limit":1})).unwrap();
    assert_eq!(page["items"][0]["id"], second["id"]);
    backend.call("historyCheckpoint", json!({})).unwrap();
    let next = backend
        .call(
            "historyList",
            json!({"beforeId":page["items"][0]["id"],"limit":1}),
        )
        .unwrap();
    assert_eq!(next["items"][0]["id"], first["id"]);
    assert!(next["nextBefore"].is_null());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn health_evidence_and_explicit_acceptance_change_history_independently_of_event_time() {
    let (root, mut backend) = fixture();
    backend.call("refresh", json!({})).unwrap();
    let old_id = list(&mut backend)["items"][0]["id"].clone();
    let file = root.join("project/workflow-progress.json");
    fs::rename(&file, root.join("project/temporarily-unavailable.json")).unwrap();
    let unhealthy = backend.call("refresh", json!({})).unwrap();
    assert_eq!(unhealthy["tasks"][0]["execution"], "completed");
    assert_eq!(unhealthy["tasks"][0]["sourceHealth"]["state"], "error");
    assert_eq!(list(&mut backend)["total"], 2);
    fs::write(&file, json!({"schema":"workflow-progress/1","project":"译稿出版","state":"complete","summary":"[更新的交稿](revised.txt)","acceptance":"accepted","updatedAt":"2026-11-09T10:00:00Z"}).to_string()).unwrap();
    backend.call("refresh", json!({})).unwrap();
    assert_eq!(list(&mut backend)["total"], 3);
    let id = list(&mut backend)["items"][0]["id"].clone();
    let newest = backend.call("historySnapshot", json!({"id": id})).unwrap();
    assert_eq!(newest["snapshot"]["tasks"][0]["acceptance"], "accepted");
    assert_eq!(
        newest["snapshot"]["tasks"][0]["eventAt"],
        "2026-11-09T10:00:00+00:00"
    );
    assert!(newest["changes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|change| change["field"] == "messages"));
    assert_eq!(
        backend
            .call("historySnapshot", json!({"id": old_id}))
            .unwrap()["snapshot"]["tasks"][0]["acceptance"],
        "unknown"
    );
    fs::remove_dir_all(root).unwrap();
}
