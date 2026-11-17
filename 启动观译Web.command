#!/bin/zsh
set -u
PROJECT_DIRECTORY="$(cd -- "$(dirname -- "$0")" && pwd -P)"
cd -- "$PROJECT_DIRECTORY" || exit 1

NODE_CANDIDATE="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_CANDIDATE" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"; do
    if [[ -x "$candidate" ]]; then NODE_CANDIDATE="$candidate"; break; fi
  done
fi
if [[ -n "$NODE_CANDIDATE" ]] && "$NODE_CANDIDATE" -e 'require("node:sqlite")' >/dev/null 2>&1; then
  "$NODE_CANDIDATE" "$PROJECT_DIRECTORY/tools/start-web.mjs"
  RESULT=$?
else
  ELECTRON_CANDIDATE="$PROJECT_DIRECTORY/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  if [[ -x "$ELECTRON_CANDIDATE" ]]; then
    ELECTRON_RUN_AS_NODE=1 "$ELECTRON_CANDIDATE" "$PROJECT_DIRECTORY/tools/start-web.mjs"
    RESULT=$?
  else
    print '需要支持 SQLite 的 Node.js 22.13+，请安装新版 Node.js 后重试。'
    RESULT=1
  fi
fi
if (( RESULT != 0 )); then
  print '启动未完成。按回车关闭此窗口。'
  read -r _
fi
exit "$RESULT"
