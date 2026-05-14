#!/bin/sh
# Apsara Clean — Notion sync hook
# Installed in: Backend/.git/hooks/post-commit
#               Frontend/.git/hooks/post-commit
#               Admin/.git/hooks/post-commit

SCRIPTS_DIR="$(git rev-parse --show-toplevel)/../scripts"
node "$SCRIPTS_DIR/sync-notion.js"
