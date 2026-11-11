use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use workflow_monitor::Backend;

fn fixture() -> (PathBuf, Backend) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch/test-temp")
        .join(format!("workflows-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("project")).unwrap();
    let backend = Backend::new(root.join("data")).unwrap();
    (root, backend)
}
fn save(backend: &mut Backend, workflow: Value) -> Value {
    let revision = backend.call("workspace", json!({})).unwrap()["revision"].clone();
    backend
        .call(
            "workflowSave",
            json!({"expectedRevision":revision,"workflow":workflow}),
        )
        .unwrap()
}

#[test]
fn unrelated_workflows_reopen_with_stable_stage_identities() {
    let (root, mut backend) = fixture();
    let saved = save(
        &mut backend,
        json!({"title":"果园灌溉","root":root.join("project"),"sourceIds":[],"stages":[{"label":"测量"},{"label":"供水"}]}),
    );
    let mut flow = saved["workflows"][0].clone();
    let first = flow["stages"][0].clone();
    let mut second = flow["stages"][1].clone();
    second["label"] = json!("分区供水");
    flow["stages"] = json!([second.clone(), {"label":"检查"}, first]);
    save(&mut backend, flow.clone());
    save(
        &mut backend,
        json!({"title":"译稿出版","root":"","sourceIds":[],"stages":[{"label":"翻译"},{"label":"校对"}]}),
    );
    let mut reopened = Backend::new(root.join("data")).unwrap();
    let workspace = reopened.call("workspace", json!({})).unwrap();
    assert_eq!(workspace["workflows"].as_array().unwrap().len(), 2);
    assert_eq!(workspace["workflows"][0]["stages"][0], second);
    assert_eq!(
        workspace["workflows"][0]["stages"][2]["id"],
        flow["stages"][2]["id"]
    );
    fs::remove_dir_all(root).unwrap();
}

fn configure(backend: &mut Backend, sources: Value) {
    let revision = backend.call("current", json!({})).unwrap()["sourcesRevision"].clone();
    backend
        .call(
            "configureSources",
            json!({"sources":sources,"expectedRevision":revision}),
        )
        .unwrap();
}

#[test]
fn progress_children_are_real_tasks_and_removed_stages_are_not_reassigned() {
    let (root, mut backend) = fixture();
    configure(
        &mut backend,
        json!([{"id":"garden","kind":"progress","path":root.join("project")} ]),
    );
    let saved = save(
        &mut backend,
        json!({"title":"果园灌溉","root":root.join("project"),"sourceIds":["garden"],"stages":[{"label":"测量"},{"label":"供水"}]}),
    );
    let mut flow = saved["workflows"][0].clone();
    let stage = flow["stages"][1]["id"].clone();
    fs::write(root.join("project/workflow-progress.json"),json!({"schema":"workflow-progress/1","workflowId":flow["id"],"state":"running","updatedAt":"2026-11-09T10:00:00Z","tasks":[{"id":"valve","title":"东区供水","stageId":stage,"state":"waiting","updatedAt":"2026-11-09T10:00:00Z","detail":"等待水位读数"}]}).to_string()).unwrap();
    let view = backend.call("refresh", json!({})).unwrap();
    assert_eq!(view["tasks"].as_array().unwrap().len(), 2);
    let child = &view["tasks"][1];
    assert_eq!(child["title"], "东区供水");
    assert_eq!(child["execution"], "waiting");
    assert_eq!(child["progress"]["stageLabel"], "供水");
    flow["stages"].as_array_mut().unwrap().remove(1);
    save(&mut backend, flow);
    let after = backend.call("refresh", json!({})).unwrap();
    assert_eq!(after["tasks"][1]["id"], child["id"]);
    assert_eq!(after["tasks"][1]["stageId"], stage);
    assert_eq!(after["tasks"][1]["progress"]["stageStatus"], "removed");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn paused_workflow_keeps_last_fact_until_resumed_and_can_be_deleted() {
    let (root, mut backend) = fixture();
    configure(
        &mut backend,
        json!([{"id":"project","kind":"progress","path":root.join("project")} ]),
    );
    let saved = save(
        &mut backend,
        json!({"title":"译稿出版","root":"","sourceIds":["project"],"stages":[{"label":"校对"}]}),
    );
    let id = saved["workflows"][0]["id"].clone();
    let file = root.join("project/workflow-progress.json");
    fs::write(&file,json!({"schema":"workflow-progress/1","state":"running","updatedAt":"2026-11-09T10:00:00Z"}).to_string()).unwrap();
    backend.call("refresh", json!({})).unwrap();
    let paused = backend
        .call(
            "workflowPause",
            json!({"id":id,"paused":true,"expectedRevision":saved["revision"]}),
        )
        .unwrap();
    fs::write(&file,json!({"schema":"workflow-progress/1","state":"complete","updatedAt":"2026-11-09T11:00:00Z"}).to_string()).unwrap();
    assert_eq!(
        backend.call("refresh", json!({})).unwrap()["tasks"][0]["execution"],
        "inProgress"
    );
    let resumed = backend
        .call(
            "workflowPause",
            json!({"id":id,"paused":false,"expectedRevision":paused["revision"]}),
        )
        .unwrap();
    assert_eq!(
        backend.call("refresh", json!({})).unwrap()["tasks"][0]["execution"],
        "completed"
    );
    let prompt = backend.call("workflowPrompt", json!({"id":id})).unwrap();
    assert!(prompt["prompt"]
        .as_str()
        .unwrap()
        .contains("workflow-progress/1"));
    let deleted = backend
        .call(
            "workflowDelete",
            json!({"id":id,"expectedRevision":resumed["revision"]}),
        )
        .unwrap();
    assert_eq!(deleted["workflows"], json!([]));
    assert!(file.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn stale_workspace_and_source_revisions_do_not_overwrite_other_window() {
    let (root, mut first) = fixture();
    let mut second = Backend::new(root.join("data")).unwrap();
    let stale_sources = second.call("current", json!({})).unwrap()["sourcesRevision"].clone();
    configure(
        &mut first,
        json!([{"id":"project","kind":"progress","path":root.join("project")} ]),
    );
    assert!(second
        .call(
            "configureSources",
            json!({"expectedRevision":stale_sources,"sources":[]})
        )
        .unwrap_err()
        .contains("其他窗口"));
    assert_eq!(
        second.call("current", json!({})).unwrap()["sources"][0]["id"],
        "project"
    );
    let stale_workspace = second.call("workspace", json!({})).unwrap()["revision"].clone();
    save(
        &mut first,
        json!({"title":"译稿出版","root":"","stages":[{"label":"校对"}]}),
    );
    let draft = json!({"title":"果园灌溉","root":"","stages":[{"label":"测量"}]});
    assert!(second
        .call(
            "workflowSave",
            json!({"expectedRevision":stale_workspace,"workflow":draft})
        )
        .unwrap_err()
        .contains("草稿已保留"));
    assert_eq!(
        second.call("workspace", json!({})).unwrap()["workflows"][0]["title"],
        "译稿出版"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn damaged_oversized_and_specialized_workspace_never_reset_or_replace() {
    let (root, mut backend) = fixture();
    fs::create_dir_all(root.join("data")).unwrap();
    let file = root.join("data/workspace.json");
    for bytes in [
        b"{broken".to_vec(),
        vec![b' '; 512 * 1024 + 1],
        br#"{"revision":0,"workflows":[],"eagleRoot":"private"}"#.to_vec(),
    ] {
        fs::write(&file, &bytes).unwrap();
        let current = backend.call("current", json!({})).unwrap();
        assert!(current["workspaceError"]
            .as_str()
            .unwrap()
            .contains("workspace.json"));
        assert!(backend
            .call(
                "workflowDelete",
                json!({"id":"anything","expectedRevision":0})
            )
            .is_err());
        assert_eq!(fs::read(&file).unwrap(), bytes);
        let mut reopened = Backend::new(root.join("data")).unwrap();
        assert!(reopened.call("workspace", json!({})).is_err());
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn serialization_limit_is_checked_before_any_write_and_last_config_reopens() {
    let (root, mut backend) = fixture();
    fs::create_dir_all(root.join("data")).unwrap();
    // Compact valid JSON fits the reader, pretty serialization exceeds the shared bound.
    let mut flows = Vec::new();
    for index in 0..40 {
        flows.push(json!({"id":format!("flow-{index}"),"title":format!("流程{index}"),"root":"","stages":(0..10).map(|stage|json!({"id":format!("stage-{stage}"),"label":"阶".repeat(30)})).collect::<Vec<_>>(),"sourceIds":(0..40).map(|id|format!("{}-{id}","源".repeat(96))).collect::<Vec<_>>(),"paused":false,"createdAt":"2026-11-09T10:00:00Z","updatedAt":"2026-11-09T10:00:00Z"}));
    }
    let workspace = json!({"revision":4,"workflows":flows});
    let bytes = serde_json::to_vec(&workspace).unwrap();
    assert!(bytes.len() <= 512 * 1024);
    assert!(serde_json::to_vec_pretty(&workspace).unwrap().len() > 512 * 1024);
    let file = root.join("data/workspace.json");
    fs::write(&file, &bytes).unwrap();
    let before: Vec<_> = fs::read_dir(root.join("data"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    let error = backend
        .call(
            "workflowPause",
            json!({"id":"flow-0","paused":true,"expectedRevision":4}),
        )
        .unwrap_err();
    assert!(error.contains("512 KiB"));
    assert_eq!(fs::read(&file).unwrap(), bytes);
    let after: Vec<_> = fs::read_dir(root.join("data"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(before, after);
    assert_eq!(
        Backend::new(root.join("data"))
            .unwrap()
            .call("workspace", json!({}))
            .unwrap()["revision"],
        4
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn malformed_progress_children_or_times_only_fail_their_source() {
    let (root, mut backend) = fixture();
    fs::create_dir_all(root.join("other")).unwrap();
    configure(
        &mut backend,
        json!([{"id":"bad","kind":"progress","path":root.join("project")},{"id":"healthy","kind":"progress","path":root.join("other")} ]),
    );
    fs::write(root.join("other/workflow-progress.json"),json!({"schema":"workflow-progress/1","project":"译稿出版","state":"complete","updatedAt":"2026-11-09T10:00:00Z"}).to_string()).unwrap();
    for invalid in [
        json!({"tasks":[null]}),
        json!({"tasks":[{"id":"a","title":"test","state":"running","updatedAt":1e100}]}),
        json!({"tasks":[{"id":"a","title":"test","state":"running","updatedAt":"2026-11-09T10:00:00Z","stageId":42}]}),
    ] {
        let mut progress = json!({"schema":"workflow-progress/1","state":"running","updatedAt":"2026-11-09T10:00:00Z"});
        progress["tasks"] = invalid["tasks"].clone();
        fs::write(
            root.join("project/workflow-progress.json"),
            progress.to_string(),
        )
        .unwrap();
        let view = backend.call("refresh", json!({})).unwrap();
        assert_eq!(view["sourceHealth"][0]["state"], "error");
        assert_eq!(view["sourceHealth"][1]["state"], "ok");
        assert_eq!(view["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(view["tasks"][0]["execution"], "completed");
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn generic_progress_accepts_finite_unix_seconds_without_guessing_string_timezones() {
    let (root, mut backend) = fixture();
    configure(
        &mut backend,
        json!([{"id":"project","kind":"progress","path":root.join("project")} ]),
    );
    let file = root.join("project/workflow-progress.json");
    fs::write(&file,json!({"schema":"workflow-progress/1","state":"running","updatedAt":0,"tasks":[{"id":"half","title":"公开任务","state":"complete","updatedAt":0.5}]}).to_string()).unwrap();
    let view = backend.call("refresh", json!({})).unwrap();
    assert_eq!(view["tasks"][0]["eventAt"], "1970-01-01T00:00:00+00:00");
    assert_eq!(view["tasks"][1]["eventAt"], "1970-01-01T00:00:00.500+00:00");
    fs::write(
        &file,
        json!({"schema":"workflow-progress/1","state":"running","updatedAt":"2026-11-09T10:00:00"})
            .to_string(),
    )
    .unwrap();
    assert_eq!(
        backend.call("refresh", json!({})).unwrap()["sourceHealth"][0]["state"],
        "error"
    );
    fs::remove_dir_all(root).unwrap();
}
