## Project layout

The Git repository root is this directory (`Matt 工作流插件`). Resolve the workflow configuration, `.scratch/`, `GLOSSARY.md` and `docs/adr/` from this root.

Product source and build scripts live in `three-workflow-monitor/`. Run product commands from that directory, or use `npm --prefix three-workflow-monitor <command>` from the repository root.

## Agent skills

### Issue tracker

Issues and specs are stored as local Markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the default label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context layout. See `docs/agents/domain.md`.
