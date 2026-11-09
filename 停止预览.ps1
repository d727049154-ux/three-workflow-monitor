# Compatibility entry. Prefer 停止预览.cmd; preserves all project/history data.
& node (Join-Path $PSScriptRoot 'tools\preview-control.cjs') stop @args
