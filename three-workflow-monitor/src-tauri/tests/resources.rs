use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use workflow_monitor::Backend;

fn fixture() -> (PathBuf, Backend) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch/test-temp")
        .join(format!("resources-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("skills")).unwrap();
    let backend = Backend::new(root.join("data")).unwrap();
    (root, backend)
}
fn change(backend: &mut Backend, method: &str, mut args: Value) -> Result<Value, String> {
    args["expectedRevision"] = backend.call("workspace", json!({})).unwrap()["revision"].clone();
    backend.call(method, args)
}
#[test]
fn optional_connection_clear_refresh_reopen_preserves_manual_resources() {
    let (root, mut backend) = fixture();
    assert_eq!(
        backend.call("current", json!({})).unwrap()["resourceCatalog"]["issues"],
        json!([])
    );
    change(&mut backend,"resourceSave",json!({"resource":{"title":"手工笔记","kind":"prompt","content":"逐项核对","category":"检查"}})).unwrap();
    fs::write(root.join("skills/SKILL.md"), "# 翻译\n保留术语").unwrap();
    let saved = change(
        &mut backend,
        "resourceConnect",
        json!({"connection":{"kind":"directory","path":root.join("skills")}}),
    )
    .unwrap();
    let catalog = backend.call("refresh", json!({})).unwrap();
    assert_eq!(
        catalog["resourceCatalog"]["resources"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    change(
        &mut backend,
        "resourceDisconnect",
        json!({"id":saved["connections"][0]["id"]}),
    )
    .unwrap();
    for _ in 0..2 {
        assert_eq!(
            backend.call("refresh", json!({})).unwrap()["resourceCatalog"]["resources"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    let mut reopened = Backend::new(root.join("data")).unwrap();
    let current = reopened.call("current", json!({})).unwrap();
    assert_eq!(current["workspace"]["connections"], json!([]));
    assert_eq!(
        current["resourceCatalog"]["resources"][0]["title"],
        "手工笔记"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn resource_edits_metadata_and_source_content_reopen_without_stale_overwrites() {
    let (root, mut backend) = fixture();
    let saved = change(
        &mut backend,
        "resourceSave",
        json!({"resource":{"title":"核对","kind":"prompt","content":"对照源文","category":"校对"}}),
    )
    .unwrap();
    let mut item = saved["resources"][0].clone();
    let id = item["id"].clone();
    item["title"] = json!("校对术语");
    let edited = change(&mut backend, "resourceSave", json!({"resource":item})).unwrap();
    assert!(backend
        .call(
            "resourceSave",
            json!({"resource":edited["resources"][0],"expectedRevision":saved["revision"]})
        )
        .unwrap_err()
        .contains("草稿已保留"));
    change(
        &mut backend,
        "resourceFavorite",
        json!({"id":id,"favorite":true}),
    )
    .unwrap();
    change(&mut backend, "resourceRecent", json!({"id":id})).unwrap();
    change(
        &mut backend,
        "resourcePause",
        json!({"id":id,"paused":true}),
    )
    .unwrap();
    assert!(backend
        .call("resourcePrompt", json!({"id":id}))
        .unwrap_err()
        .contains("暂停"));
    let mut reopened = Backend::new(root.join("data")).unwrap();
    let ws = reopened.call("workspace", json!({})).unwrap();
    assert_eq!(ws["resources"][0]["title"], "校对术语");
    assert_eq!(ws["favorites"], json!([id]));
    assert_eq!(ws["recent"], json!([id]));
    fs::write(root.join("skills/SKILL.md"), "# 翻译\n旧术语").unwrap();
    let connected = change(
        &mut reopened,
        "resourceConnect",
        json!({"connection":{"kind":"directory","path":root.join("skills")}}),
    )
    .unwrap();
    let view = reopened.call("current", json!({})).unwrap();
    let mut imported = view["resourceCatalog"]["resources"][1].clone();
    imported["category"] = json!("术语");
    change(&mut reopened, "resourceSave", json!({"resource":imported})).unwrap();
    change(
        &mut reopened,
        "resourceFavorite",
        json!({"id":imported["id"],"favorite":true}),
    )
    .unwrap();
    fs::write(root.join("skills/SKILL.md"), "# 翻译更新\n新增专有名词").unwrap();
    let after = reopened.call("refresh", json!({})).unwrap();
    assert_eq!(
        after["resourceCatalog"]["resources"][1]["title"],
        "翻译更新"
    );
    assert_eq!(after["resourceCatalog"]["resources"][1]["category"], "术语");
    assert!(after["resourceCatalog"]["resources"][1]["content"]
        .as_str()
        .unwrap()
        .contains("新增专有名词"));
    fs::create_dir(root.join("other")).unwrap();
    fs::write(root.join("other/SKILL.md"), "# 切换后的资源").unwrap();
    change(&mut reopened,"resourceConnect",json!({"connection":{"id":connected["connections"][0]["id"],"kind":"directory","path":root.join("other")}})).unwrap();
    let switched = reopened.call("current", json!({})).unwrap();
    assert_eq!(switched["workspace"]["favorites"], json!([id]));
    assert_eq!(switched["workspace"]["resourceSettings"], json!([]));
    assert_eq!(
        switched["resourceCatalog"]["resources"][1]["title"],
        "切换后的资源"
    );
    fs::remove_dir_all(root.join("other")).unwrap();
    let missing = reopened.call("refresh", json!({})).unwrap();
    assert_eq!(
        missing["resourceCatalog"]["issues"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        missing["resourceCatalog"]["resources"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn selected_catalog_requires_bounded_unique_resources_inside_its_directory() {
    let (root, mut backend) = fixture();
    fs::write(root.join("outside.md"), "private").unwrap();
    let file = root.join("skills/catalog.json");
    for invalid in [
        json!([{"id":"escape","title":"逃逸","kind":"file","path":"../outside.md"}]),
        json!([{"id":"x","title":"重复","kind":"prompt","content":"a"},{"id":"x","title":"重复","kind":"prompt","content":"b"}]),
        json!([{"id":"binary","title":"类型","kind":"exe","path":"test.exe"}]),
    ] {
        fs::write(&file, invalid.to_string()).unwrap();
        assert!(change(
            &mut backend,
            "resourceConnect",
            json!({"connection":{"kind":"catalog","path":file}})
        )
        .is_err());
        assert_eq!(
            backend.call("workspace", json!({})).unwrap()["connections"],
            json!([])
        );
    }
    fs::write(&file, " ".repeat(512 * 1024 + 1)).unwrap();
    assert!(change(
        &mut backend,
        "resourceConnect",
        json!({"connection":{"kind":"catalog","path":file}})
    )
    .unwrap_err()
    .contains("512 KiB"));
    fs::write(root.join("skills/guide.md"), "source").unwrap();
    fs::write(&file,json!([{"id":"guide","title":"指南","kind":"file","path":"guide.md"},{"id":"prompt","title":"提示词","kind":"prompt","content":"检查边界"}]).to_string()).unwrap();
    change(
        &mut backend,
        "resourceConnect",
        json!({"connection":{"kind":"catalog","path":file}}),
    )
    .unwrap();
    let current = backend.call("refresh", json!({})).unwrap();
    let prompt_id = &current["resourceCatalog"]["resources"][1]["id"];
    assert_eq!(
        backend
            .call("resourcePrompt", json!({"id":prompt_id}))
            .unwrap()["prompt"],
        "检查边界"
    );
    assert!(backend
        .call("resourcePrompt", json!({"id":"arbitrary"}))
        .is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn resource_capacity_rejects_write_and_last_workspace_reopens() {
    let (root, mut backend) = fixture();
    let mut count = 0;
    loop {
        match change(
            &mut backend,
            "resourceSave",
            json!({"resource":{"title":format!("资料{count}"),"kind":"prompt","content":"字".repeat(16000)}}),
        ) {
            Ok(_) => count += 1,
            Err(error) => {
                assert!(error.contains("512 KiB"));
                break;
            }
        }
    }
    assert!(count > 0);
    let mut reopened = Backend::new(root.join("data")).unwrap();
    assert_eq!(
        reopened.call("workspace", json!({})).unwrap()["resources"]
            .as_array()
            .unwrap()
            .len(),
        count
    );
    assert_eq!(fs::read_dir(root.join("data")).unwrap().count(), 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn directory_scan_has_a_total_entry_bound_even_without_markdown() {
    let (root, mut backend) = fixture();
    for index in 0..5001 {
        fs::write(root.join(format!("skills/{index}.txt")), "").unwrap();
    }
    let error = change(
        &mut backend,
        "resourceConnect",
        json!({"connection":{"kind":"directory","path":root.join("skills")}}),
    )
    .unwrap_err();
    assert!(error.contains("5000"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn windows_markdown_line_endings_are_valid_resource_content() {
    let (root, mut backend) = fixture();
    fs::write(
        root.join("skills/SKILL.md"),
        "# Windows 技能\r\n\r\n保留格式。\r\n",
    )
    .unwrap();
    change(
        &mut backend,
        "resourceConnect",
        json!({"connection":{"kind":"directory","path":root.join("skills")}}),
    )
    .unwrap();
    let view = backend.call("current", json!({})).unwrap();
    assert_eq!(
        view["resourceCatalog"]["resources"][0]["title"],
        "Windows 技能"
    );
    fs::remove_dir_all(root).unwrap();
}
