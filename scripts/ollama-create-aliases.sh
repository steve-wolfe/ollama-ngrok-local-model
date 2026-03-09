#!/usr/bin/env bash
# Write Modelfiles for Cursor-friendly alias models from scripts/model-map.json.
# Keys = model names (e.g. gpt-4o), values = base model (e.g. llama3.2-coder:latest).
# Output: one file per mapping in modelfiles/<name> with "FROM <base>".
# Then run ./scripts/build-models.sh to create the models (or use Docker and let the entrypoint do it).
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MAP_FILE="${SCRIPT_DIR}/model-map.json"
MODELFILES_DIR="${PROJECT_ROOT}/modelfiles"

if [[ ! -f "$MAP_FILE" ]]; then
  echo "Model map not found: $MAP_FILE" >&2
  exit 1
fi

mkdir -p "$MODELFILES_DIR"

count=0
while read -r line; do
  name="${line%% *}"
  from="${line#* }"
  if [[ -z "$name" || "$name" == "$from" ]]; then continue; fi
  echo "FROM $from" > "$MODELFILES_DIR/$name"
  echo "  $MODELFILES_DIR/$name  <- $from"
  ((count++)) || true
done < <(node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  Object.entries(m).forEach(([k, v]) => { if (k && v) console.log(k + ' ' + v); });
" "$MAP_FILE")

if [[ $count -eq 0 ]]; then
  echo "No mappings in $MAP_FILE" >&2
  exit 1
fi

echo ""
echo "Wrote $count Modelfile(s) to $MODELFILES_DIR."
echo "Create the models with: ./scripts/build-models.sh"
echo "(Or in Docker, rebuild/restart and the entrypoint will run build-models.)"
