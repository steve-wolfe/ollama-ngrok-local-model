#!/bin/sh
set -e
# On first run (empty volume), build models directly into the mounted volume — one copy, no duplication
if [ -d /modelfiles ] && { [ ! -d /root/.ollama/blobs ] || [ -z "$(ls -A /root/.ollama/blobs 2>/dev/null)" ]; }; then
  echo "First run: building models into volume (this may take a while)..."
  /scripts/build-models.sh
fi
exec /bin/ollama "$@"
