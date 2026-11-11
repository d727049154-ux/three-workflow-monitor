use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub id: String,
    pub kind: String,
    pub path: PathBuf,
    #[serde(default)]
    pub session_file: Option<PathBuf>,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub project_root: Option<PathBuf>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub source_id: String,
    pub state: String,
    pub issue: Option<String>,
    pub observed_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Message {
    pub id: String,
    pub phase: String,
    pub text: String,
    pub at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub source_id: String,
    pub title: String,
    pub project_root: PathBuf,
    pub thread_id: Option<String>,
    pub execution: String,
    pub source_health: Health,
    pub acceptance: String,
    pub messages: Vec<Message>,
    pub event_at: Option<String>,
    pub observed_at: String,
    pub source_path: PathBuf,
    pub workflow_id: Option<String>,
    pub stage_id: Option<String>,
    pub progress: Option<serde_json::Value>,
}
