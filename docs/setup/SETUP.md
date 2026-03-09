# Setup guide

Step-by-step setup with rationales. For a short overview, see the [README](../../README.md). For native Mac/GPU and troubleshooting, see [docs/notes/NATIVE-OLLAMA-MAC.md](../notes/NATIVE-OLLAMA-MAC.md).

---

## Why this stack

- **Ollama** – Runs models locally; exposes an OpenAI-compatible HTTP API. We use it as the single inference backend.
- **Proxy** – Cursor (and some other clients) send requests in a shape that differs from what Ollama expects (e.g. `input` instead of `messages`, or Responses API fields). The proxy normalizes the body and forwards to Ollama so we don’t have to change Ollama or wait for client changes.
- **Tunnel** – Cursor does not accept `localhost` as the API base URL. A tunnel (ngrok, Cloudflare, etc.) gives a public HTTPS URL that forwards to the proxy on your machine.
- **Alias models** – Cursor’s model list is often restricted to known names (e.g. `gpt-4o`, `gpt-4o-mini`). We create Ollama “alias” models with those names that point at the real models (e.g. `llama3.2-coder`), so Cursor can select them without code changes.

So the path is: **Cursor → tunnel (HTTPS) → proxy (normalize) → Ollama (inference)**. Model naming is done in Ollama via Modelfiles, not in the proxy.

---

## Prerequisites

| Requirement | Why |
|-------------|-----|
| **Ollama** installed and running | Inference backend. Must be reachable at `http://127.0.0.1:11434` (or the host from Docker’s perspective: `host.docker.internal:11434`). |
| **Docker** | Used to run the proxy and the tunnel (ngrok) in a consistent way. You can also run the proxy on the host and use a host-installed tunnel. |
| **ngrok account + auth token** (if using ngrok) | ngrok needs an auth token in `.env` as `NGROK_AUTHTOKEN`. Alternatives: Cloudflare Tunnel, LocalTunnel, etc. (see [NATIVE-OLLAMA-MAC.md](../notes/NATIVE-OLLAMA-MAC.md)). |

---

## Step 1: Start Ollama

**What to do**

- Start Ollama on the host so it listens on `http://0.0.0.0:11434` or `http://127.0.0.1:11434`.
- Options: run `ollama serve` in a terminal, or use the Ollama app.

**Why**

- The proxy (in Docker or on host) will send all chat requests to Ollama. If Ollama isn’t running, the proxy will get connection errors and Cursor will see failures.

**Verify**

```bash
curl -s http://127.0.0.1:11434/api/tags
```

You should get JSON listing models (can be empty at first). If you get “connection refused,” start Ollama and try again.

---

## Step 2: Create Cursor-friendly alias models

**What to do**

1. Edit `scripts/model-map.json` if you want different names or base models. Keys are the names Cursor will see (e.g. `gpt-4o`); values are the Ollama base model (e.g. `llama3.2-coder:latest`).
2. From the project root:
   ```bash
   ./scripts/ollama-create-aliases.sh   # writes modelfiles/gpt-4o, gpt-4o-mini, etc. (FROM <base>)
   ./scripts/build-models.sh            # pulls base models if missing, then ollama create for each
   ```

**Why**

- Cursor’s model dropdown often only allows certain IDs (e.g. `gpt-4o`). Ollama models have their own names (e.g. `llama3.2-coder`). The model map defines Cursor name → base model; `ollama-create-aliases.sh` turns each into a Modelfile that just does `FROM <base>`. `build-models.sh` then runs `ollama create` so those names exist in Ollama. The proxy does not rewrite model names; it forwards whatever Cursor sends, so the names in Cursor must match real Ollama model names.

**Verify**

```bash
curl -s http://127.0.0.1:11434/api/tags
```

You should see entries for the alias names (e.g. `gpt-4o`, `gpt-4o-mini`). If a base model is missing, `build-models.sh` will have failed on that step; pull the base model with `ollama pull <base>` and re-run `build-models.sh` if needed.

---

## Step 3: Start the proxy and tunnel

**What to do**

1. If using ngrok: add your token to `.env`:
   ```bash
   echo "NGROK_AUTHTOKEN=your_token" >> .env
   ```
2. From the project root:
   ```bash
   docker compose up -d
   ```

This starts the proxy (port 8080) and ngrok. ngrok tunnels public HTTPS to the proxy; the proxy forwards to `host.docker.internal:11434` (Ollama on the host).

**Why**

- The proxy normalizes Cursor’s request format (e.g. `input` → `messages`) so Ollama accepts it. The tunnel is required because Cursor will not use a localhost base URL.
- See https://forum.cursor.com/t/cursor-agent-sends-responses-api-format-to-chat-completions-endpoint/153019

**Verify**

- Proxy: `curl -s http://127.0.0.1:8080/v1/models` should return JSON (models from Ollama).
- Tunnel URL: `docker logs ngrok` and look for the `https://….ngrok-free.app` (or similar) URL.

---

## Step 4: Configure Cursor

**What to do**

1. In Cursor: **Settings → Models** (or equivalent).
2. Set **OpenAI Base URL** (override) to your tunnel URL with `/v1`, e.g. `https://xxxx.ngrok-free.app/v1`.
3. (Optional) Set OpenAI API Key to something bogus like "ollama". This prevents Cursor from falling back to a real OpenAI API on error and charging credits.
4. Add models using the **keys** from `scripts/model-map.json` (e.g. `gpt-4o`, `gpt-4o-mini`). These must match the alias names you created in Step 2.

**Why**

- Cursor sends requests to the base URL you set. The `/v1` path is the standard OpenAI-style prefix; the proxy serves `/v1/chat/completions`, `/v1/models`, etc. The model IDs you add in Cursor are sent in the request and must exist in Ollama.

**Verify**

- Send a short message in Cursor with one of the configured models.
- In another terminal: `docker compose logs -f proxy`. You should see a line like `POST /v1/chat/completions` and `>>> normalized model= gpt-4o` (or similar). If you don’t see any request, Cursor is not using the override URL (check Settings again). See [docs/notes/NOTES.md](../notes/NOTES.md) for “Invalid API key” and verification tips.

---

## Optional: Ollama in Docker

If you prefer not to run Ollama on the host (e.g. no GPU on Mac, or you want everything in Docker):

```bash
docker compose -f docker-compose.wOllama.yml up -d
```

Then either point the proxy at the Ollama service (e.g. set `OLLAMA_UPSTREAM` to the Ollama container URL) or use the same Compose file’s wiring. Model creation (Step 2) is typically done via the same scripts from the host or from a container that has access to `modelfiles/` and the Ollama socket. See the Compose file and [README](../../README.md) for details.

Ollama in Docker with CPU only is much, much, much slower than using GPU.

---

## Where to go next

- **Native Mac, GPU, copying model data from Docker, “nothing happens,” “context canceled”:** [docs/notes/NATIVE-OLLAMA-MAC.md](../notes/NATIVE-OLLAMA-MAC.md)
- **Why the proxy changes the request body, Cursor “Invalid API key,” logs:** [docs/notes/NOTES.md](../notes/NOTES.md)
- **Scripts and model map reference:** [README#Scripts](../../README.md#scripts), [README#Model map and modelfiles](../../README.md#model-map-and-modelfiles)
