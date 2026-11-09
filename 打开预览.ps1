# Compatibility entry. Prefer 打开预览.cmd; no execution-policy change is needed.
& node (Join-Path $PSScriptRoot 'tools\preview-control.cjs') start @args
