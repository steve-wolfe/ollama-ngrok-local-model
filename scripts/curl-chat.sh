#!/usr/bin/env bash
# Curl a chat completion against the proxy (ngrok URL or localhost:8080).
# Streams the response so you can see if the connection stays up.
#
# Usage:
#   ./scripts/curl-chat.sh                          # use BASE_URL from env, or
#   ./scripts/curl-chat.sh https://YOUR-NGROK-URL   # or pass base URL
#   ./scripts/curl-chat.sh https://YOUR-NGROK-URL cursor-request.json  # replay body from logs
#   ./scripts/curl-chat.sh https://YOUR-NGROK-URL cursor-request.json no-stream  # same request, no streaming (test if ngrok accepts it)
#
# To mimic Cursor from logs: when you use Cursor, proxy logs ">>> request POST /v1/chat/completions" with
# a "body" field. Copy that JSON into a file (e.g. cursor-request.json) and run:
#   ./scripts/curl-chat.sh https://YOUR-NGROK-URL cursor-request.json

set -e
BASE_URL="${1:-${BASE_URL}}"
BODY_FILE="${2:-}"
NO_STREAM="${3:-}"

if [[ -z "$BASE_URL" ]]; then
  echo "Usage: $0 <base-url> [body.json]" >&2
  echo "  base-url  e.g. https://xxxx.ngrok-free.app or http://localhost:8080" >&2
  echo "  body.json optional; if omitted, sends a minimal Cursor-like streaming request" >&2
  exit 1
fi

# Strip trailing slash
BASE_URL="${BASE_URL%/}"
URL="${BASE_URL}/v1/chat/completions"

if [[ -n "$BODY_FILE" ]]; then
  if [[ ! -f "$BODY_FILE" ]]; then
    echo "File not found: $BODY_FILE" >&2
    exit 1
  fi
  # If file is proxy log format {"body": "<actual JSON string>"}, extract the inner body
  BODY_TMP=$(mktemp)
  trap 'rm -f "$BODY_TMP"' EXIT
  node -e "
    const fs = require('fs');
    const noStream = process.argv[3] === 'no-stream';
    let data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    if (data && typeof data.body === 'string' && Object.keys(data).length === 1) {
      data = data.body;
    } else if (typeof data !== 'string') {
      data = JSON.stringify(data);
    }
    let body = typeof data === 'string' ? JSON.parse(data) : data;
    if (noStream) body = { ...body, stream: false };
    fs.writeFileSync(process.argv[2], JSON.stringify(body));
  " "$BODY_FILE" "$BODY_TMP" "$NO_STREAM"
  echo "Sending body from $BODY_FILE to $URL${NO_STREAM:+ (no-stream)}" >&2
  curl -N -s -X POST "$URL" \
    -H "Content-Type: application/json" \
    -d @"$BODY_TMP"
  rm -f "$BODY_TMP"
  trap - EXIT
else
  # Minimal Cursor-like payload: model name Cursor sends, messages, stream true
  echo "Sending minimal streaming request to $URL" >&2
  curl -N -s -X POST "$URL" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "gpt-4o",
      "messages": [{"role": "user", "content": "Say hello in one sentence."}],
      "stream": true
    }'
fi
