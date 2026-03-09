# Local Model

Run [Ollama](https://ollama.com) locally and expose it to [Cursor](https://cursor.com) (and other OpenAI-compatible clients) via a small proxy and a tunnel. Recommended on Mac: run Ollama natively so it can use the GPU (Metal); the proxy and tunnel run in Docker or on the host.

## What’s in this repo

- **Proxy** (`proxy/server.js`) – HTTP server that adapts Cursor’s request format to standard OpenAI Chat Completions and forwards to Ollama. It normalizes `input`→`messages`, strips Responses API–only params, normalizes tools, and fills in missing `tool_calls[].function.name` so Cursor can run tools. Optional: streaming keepalive, verbose logging.
- **Model aliases** – `scripts/model-map.json` plus `scripts/ollama-create-aliases.sh` and `scripts/build-models.sh` create Ollama models with Cursor-friendly names (e.g. `gpt-4o`, `gpt-4o-mini`) that point at your real models.
- **Modelfiles** – Under `modelfiles/`: base models (e.g. `qwen2.5-coder-agent`, `llama3.2-coder`) and alias stubs (e.g. `gpt-4o` with `FROM llama3.2-coder:latest`). Edit these to change system prompts and parameters; then re-run `build-models.sh`.
- **Docker Compose** – Runs the proxy and ngrok. Ollama is expected on the host at `:11434` (not in this Compose file).
- **Docs** – [docs/setup/SETUP.md](docs/setup/SETUP.md) has step-by-step setup and rationales. [docs/notes/NATIVE-OLLAMA-MAC.md](docs/notes/NATIVE-OLLAMA-MAC.md) has native Mac setup, copying model data from Docker, alternative tunnels (e.g. Cloudflare), and troubleshooting. [docs/notes/NOTES.md](docs/notes/NOTES.md) has technical notes and gotchas.

## Architecture

```
Cursor (or other client)
    → HTTPS tunnel (ngrok / Cloudflare / etc.)
    → Proxy (:8080)   [normalize request, fill tool names, stream back]
    → Ollama on host (:11434)
```

Model naming is done in Ollama (alias models built from Modelfiles), not in the proxy.

## Prerequisites

- [Ollama](https://ollama.com) installed and running (e.g. `ollama serve` or the Ollama app).
- [Docker](https://docs.docker.com/get-docker/) (for proxy + ngrok).
- For ngrok: an [account](https://ngrok.com) and [auth token](https://dashboard.ngrok.com/get-started/your-authtoken). Or use another tunnel (see [docs/notes/NATIVE-OLLAMA-MAC.md](docs/notes/NATIVE-OLLAMA-MAC.md)).

## Quick start

1. **Start Ollama** on the host (e.g. `ollama serve` or open the Ollama app). It should listen on `http://0.0.0.0:11434` or `http://127.0.0.1:11434`.

2. **Create Cursor-friendly alias models** from `scripts/model-map.json`:
   ```bash
   ./scripts/ollama-create-aliases.sh   # writes modelfiles/gpt-4o, gpt-4o-mini, etc. (FROM <base>)
   ./scripts/build-models.sh            # pulls base models if needed, then ollama create for each
   ```
   Edit `scripts/model-map.json` to change which names point at which base models; re-run both scripts after changes.

3. **Start the proxy and tunnel**
   ```bash
   echo "NGROK_AUTHTOKEN=your_token" >> .env   # if using ngrok
   docker compose up -d
   ```

4. **Configure Cursor**
   - Get the tunnel URL: `docker logs ngrok` (or use your Cloudflare/local tunnel URL).
   - In Cursor: Settings → Models → override OpenAI Base URL → `https://YOUR_TUNNEL_URL/v1`.
   - Add models using the **keys** from `scripts/model-map.json` (e.g. `gpt-4o`, `gpt-4o-mini`).

## Scripts

| Script | Purpose |
|--------|--------|
| `./scripts/ollama-create-aliases.sh` | Reads `scripts/model-map.json` and writes one Modelfile per entry under `modelfiles/<name>` with `FROM <base>`. |
| `./scripts/build-models.sh` | For each file in `modelfiles/`: pull base model if missing, then `ollama create <name> -f <modelfile>`. Run on the host (uses `./modelfiles`). Optional env: `OLLAMA_MODELFILES_INCLUDE` (whitelist), `OLLAMA_MODELFILES_EXCLUDE` (blacklist). |
| `./scripts/curl-chat.sh <base-url> [body.json]` | Send a test chat request to the proxy (e.g. `http://localhost:8080` or your tunnel URL). With `body.json`, sends that body; otherwise a minimal streaming request. |

## Model map and modelfiles

- **`scripts/model-map.json`** – Keys = model names to create for Cursor (e.g. `gpt-4o`). Values = base model (e.g. `llama3.2-coder:latest` or `qwen2.5-coder-agent:latest`). `ollama-create-aliases.sh` turns each into `modelfiles/<key>` with `FROM <value>`.
- **`modelfiles/`** – Contains both base Modelfiles (e.g. `qwen2.5-coder-agent`, `llama3.2-coder`, `deepseek-r1-agent`, `devstral-agent`) and the alias files generated from `scripts/model-map.json` (e.g. `gpt-4o`, `gpt-4o-mini`). Edit base Modelfiles to change system prompts and parameters; re-run `build-models.sh` to apply.

To see the Modelfile Ollama is using for a model:

```bash
ollama show <model-name>:latest --modelfile
```

## Proxy

- **Port:** 8080 (configurable via `PORT`).
- **Upstream:** `OLLAMA_UPSTREAM` (default `http://host.docker.internal:11434` in Docker).
- **Optional env (e.g. in `.env` or docker-compose):**
  - `PROXY_DISABLE_STREAMING=1` – Buffer full response and send as one SSE stream (can help with flaky tunnels).
  - `STREAM_KEEPALIVE_MS=8000` – Send SSE comment every N ms during streaming to avoid idle timeouts (default 8000).
- **Logging:** The proxy logs each request (path, body size, normalized model/tools), upstream status, first stream chunk, and stream end. Use `docker compose logs -f proxy` to watch.

## Tunnels

- **ngrok** – In the default Compose, the proxy is exposed via ngrok. Put `NGROK_AUTHTOKEN` in `.env`.
- **Cloudflare / others** – See [docs/notes/NATIVE-OLLAMA-MAC.md](docs/notes/NATIVE-OLLAMA-MAC.md) for Cloudflare Tunnel and other options. Point the tunnel at `http://localhost:8080` (proxy), then use the tunnel URL as the Cursor base URL with `/v1`.

## Optional: Ollama in Docker

If you prefer to run Ollama in Docker (no GPU on Mac):

```bash
docker compose -f docker-compose.wOllama.yml up -d
```

Then point the proxy at the Ollama service instead of the host (e.g. set `OLLAMA_UPSTREAM` to the Ollama container URL). The rest of the flow (proxy, tunnel, Cursor) is unchanged.

## More help

- **Step-by-step setup and rationales:** [docs/setup/SETUP.md](docs/setup/SETUP.md)
- **Native Mac, GPU, copying model data, “nothing happens”, “context canceled”:** [docs/notes/NATIVE-OLLAMA-MAC.md](docs/notes/NATIVE-OLLAMA-MAC.md)
- **Technical notes (proxy behavior, Cursor gotchas):** [docs/notes/NOTES.md](docs/notes/NOTES.md)
- **LiteLLM:** There is a sample `litellm_config.yaml`; see [docs/notes/NATIVE-OLLAMA-MAC.md](docs/notes/NATIVE-OLLAMA-MAC.md) for when LiteLLM is useful vs using this proxy alone.
