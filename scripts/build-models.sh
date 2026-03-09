#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# In Docker the Dockerfile sets /modelfiles; on host use project modelfiles/
if [ -d "/modelfiles" ]; then
  MODELFILES_DIR="${MODELFILES_DIR:-/modelfiles}"
else
  MODELFILES_DIR="${MODELFILES_DIR:-$SCRIPT_DIR/../modelfiles}"
fi

# Optional filter: comma-separated names. INCLUDE = whitelist (only these); EXCLUDE = blacklist (skip these).
normalize_list() { echo "$1" | tr ',' '\n' | tr -d '[:space:]' | grep -v '^$'; }
in_include() {
  [ -z "$OLLAMA_MODELFILES_INCLUDE" ] && return 0
  normalize_list "$OLLAMA_MODELFILES_INCLUDE" | grep -qFx "$1"
}
in_exclude() {
  [ -z "$OLLAMA_MODELFILES_EXCLUDE" ] && return 1
  normalize_list "$OLLAMA_MODELFILES_EXCLUDE" | grep -qFx "$1"
}
should_build() {
  in_include "$1" && ! in_exclude "$1"
}

WE_STARTED_SERVER=0
if ! ollama list > /dev/null 2>&1; then
  echo "Starting ollama server for model creation..."
  ollama serve &
  SERVER_PID=$!
  WE_STARTED_SERVER=1
  echo "Waiting for ollama to be ready..."
  until ollama list > /dev/null 2>&1; do
    sleep 1
  done
fi
echo "Ollama ready."

if [ -z "$(ls -A $MODELFILES_DIR 2>/dev/null)" ]; then
  echo "No modelfiles found in $MODELFILES_DIR, skipping."
  [ "$WE_STARTED_SERVER" = 1 ] && kill $SERVER_PID 2>/dev/null || true
  exit 0
fi

[ -n "$OLLAMA_MODELFILES_INCLUDE" ] && echo "Whitelist: $OLLAMA_MODELFILES_INCLUDE"
[ -n "$OLLAMA_MODELFILES_EXCLUDE" ] && echo "Blacklist: $OLLAMA_MODELFILES_EXCLUDE"

for modelfile in "$MODELFILES_DIR"/*; do
  [ -f "$modelfile" ] || continue

  model_name=$(basename "$modelfile")
  should_build "$model_name" || { echo "[$model_name] Skipped (filter)."; continue; }

  base_model=$(grep -i '^FROM' "$modelfile" | awk '{print $2}')

  if [ -z "$base_model" ]; then
    echo "WARNING: No FROM line found in $modelfile, skipping."
    continue
  fi

  if ollama show "$base_model" >/dev/null 2>&1; then
    echo "[$model_name] Base model $base_model already present, skipping pull."
  else
    echo "[$model_name] Pulling base model: $base_model"
    ollama pull "$base_model"
  fi

  echo "[$model_name] Creating custom model..."
  ollama create "$model_name" -f "$modelfile"

  echo "[$model_name] Done."
done

echo "All models created successfully."
[ "$WE_STARTED_SERVER" = 1 ] && { kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null || true; }