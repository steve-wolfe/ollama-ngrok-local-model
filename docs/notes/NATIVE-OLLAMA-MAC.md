# Running Ollama Natively on Mac (Use GPU / Metal)

On Apple Silicon, Ollama uses the GPU (Metal) only when run **natively**, not inside Docker. This guide reuses your existing Docker model data so you don’t re-download models, and uses the project proxy + ngrok to expose Ollama to Cursor.

## 1. Copy model data from Docker to the host

Your models live in the Docker volume `ollama_data`. Copy them to a folder on your Mac:

```bash
# Create a directory for Ollama data on the host (e.g. in this project)
mkdir -p ./ollama_data

# Find the exact volume name (Compose names it <project>_ollama_data)
docker volume ls | grep ollama

# Copy from that volume (replace VOLUME_NAME with the name from above, e.g. local_model_ollama_data)
docker run --rm \
  -v local_model_ollama_data:/from \
  -v "$(pwd)/ollama_data:/to" \
  alpine sh -c "cp -a /from/. /to/"
```

Run the copy from your **project root** so `$(pwd)/ollama_data` is correct. The result will be `ollama_data/models/blobs` and `ollama_data/models/manifests`. Ollama expects `OLLAMA_MODELS` to point at the directory that **directly** contains `blobs` and `manifests` (i.e. `ollama_data/models`), not the parent.

## 2. Install and run Ollama natively

- **Install:** [ollama.com](https://ollama.com) or `brew install ollama`
- **Use the wrapper script** (sources `.env` and sets `OLLAMA_MODELS`, `OLLAMA_HOST`, `OLLAMA_NUM_CTX`):

  ```bash
  ./scripts/run-ollama-native.sh
  ```

  Defaults: `OLLAMA_MODELS=<project>/ollama_data/models` (the dir that directly contains `blobs/` and `manifests/`), `OLLAMA_HOST=0.0.0.0`, `OLLAMA_NUM_CTX=65536. Override in `.env` if needed.

  For other ollama commands (list, pull, etc.) use the same env so they see the same models dir: `./scripts/ollama-env.sh list`, `./scripts/ollama-env.sh pull <model>`.

- Or run manually:

  ```bash
  export OLLAMA_MODELS="$(pwd)/ollama_data"
  export OLLAMA_HOST=0.0.0.0
  export OLLAMA_NUM_CTX=65536
  ollama serve
  ```

- Keep this terminal running (or run Ollama as a service / from the app).

## 3. Create alias models (Cursor-friendly names)

Cursor only accepts certain model names (e.g. `gpt-4o`). Write Modelfiles from `scripts/model-map.json`, then build:

```bash
./scripts/ollama-create-aliases.sh   # writes modelfiles/gpt-4o, etc. (FROM <base>)
./scripts/build-models.sh            # ollama pull + ollama create for each
```

Edit `scripts/model-map.json` (keys = names to create, values = base model); re-run both after pulling new models.

## 4. Start proxy + ngrok

The base `docker-compose.yml` runs proxy + ngrok. ngrok tunnels to the proxy, and the proxy forwards to host Ollama at `host.docker.internal:11434`. With native Ollama running:

```bash
echo "NGROK_AUTHTOKEN=your_token" > .env   # if not already set
docker compose up -d
```

## 5. Verify

- Native Ollama: `curl http://127.0.0.1:11434/api/tags` should list your models (including the aliases).
- Proxy health/check: `curl http://127.0.0.1:8080/v1/models` should return models through the proxy.
- Cursor: use the ngrok URL from `docker logs ngrok` as the OpenAI base URL (e.g. `https://xxxx.ngrok-free.app/v1`); add model names from `scripts/model-map.json` (e.g. `gpt-4o`).

## Using Ollama in Docker instead

To run Ollama in a container (no GPU on Mac):

```bash
docker compose -f docker-compose.wOllama.yml up -d
```

---

## If you see ngrok errors or Cursor doesn't respond

Cursor does not allow localhost as the API base URL, so you need a tunnel (ngrok). To see where the failure is: run `docker compose logs -f proxy` while reproducing. The proxy logs `<<< stream first chunk`, `<<< stream end (Ollama finished)`, and `<<< client closed connection`. If you see "client closed" right after "first chunk" or before "stream end", the client or tunnel is closing the connection. To see if the proxy/ngrok stream works at all, curl a prompt: run `./scripts/curl-chat.sh https://YOUR-NGROK-URL` (use the same base URL as in Cursor). It sends a minimal streaming chat request and prints the stream; if you get tokens and then `[DONE]` (or the stream ends cleanly), the tunnel is delivering the stream. To mimic exactly what Cursor sends: trigger a request in Cursor, then in the proxy logs find the line after `>>> request POST /v1/chat/completions` — the logged `body` is the JSON. Copy that into a file (e.g. `cursor-request.json`) and run `./scripts/curl-chat.sh https://YOUR-NGROK-URL cursor-request.json`.

The tunnel (ngrok, Cloudflare, etc.) or the client may close the connection when no data is sent for a while—e.g. while waiting for the first token from Ollama (which can take 10+ seconds on a long prompt). Cloudflare may log "Incoming request ended abruptly: context canceled"; Ollama still returns 200, but the response never reaches Cursor.

**1. Streaming keepalive (default)**  
The proxy sends an SSE comment every 8 seconds during streaming so the connection isn’t treated as idle. No config needed; to change the interval, set in `.env`:

```bash
STREAM_KEEPALIVE_MS=10000
```

**2. Turn off streaming**  
If the error persists, buffer the full reply and send it once. In `.env`:

```bash
PROXY_DISABLE_STREAMING=1
```

Restart after any change: `docker compose down && docker compose up -d`. With streaming disabled you won’t see tokens stream in and the first token may take longer.

**"No errors, but nothing happens" / "Two 200s in Ollama, nothing in Cursor"** — Cursor shows no error; Ollama logs show 200 for the completions. The tunnel and proxy are delivering the response; Cursor simply isn’t showing or acting on it. That points to a **Cursor client limitation** with custom API endpoints (e.g. it may not run tool calls or update the UI the same as with OpenAI). Streaming and non-streaming (`PROXY_DISABLE_STREAMING=1`) both exhibit this. To confirm the proxy response is valid, call it with curl or use Open WebUI with your tunnel URL; you should see the reply. **Practical options:** use your local model in Open WebUI or another client; use a hosted API in Cursor when you need full agent/tool behavior.

---

## Using LiteLLM instead of the custom proxy

[LiteLLM](https://docs.litellm.ai/docs/proxy/configs) is an OpenAI-compatible proxy that can sit in front of Ollama and may handle tool calling and streaming in a more standard way than our minimal proxy.

**1. Install (host)**

```bash
pip install 'litellm[proxy]'
```

**2. Config**

Create `litellm_config.yaml` (e.g. in the project root) with model aliases that point at your Ollama models. Use the same names you want Cursor to see (e.g. `gpt-4o`) and map them to `ollama/<model>`:

```yaml
model_list:
  - model_name: gpt-4o
    litellm_params:
      model: ollama/llama3.2-coder
      api_base: http://localhost:11434
  - model_name: gpt-4o-mini
    litellm_params:
      model: ollama/qwen2.5-coder-agent
      api_base: http://localhost:11434
  # Add more entries to match your scripts/model-map.json / Cursor model list
```

**3. Run**

With native Ollama already running on port 11434:

```bash
litellm --config litellm_config.yaml
```

LiteLLM listens on **port 4000** by default and exposes OpenAI-style routes (e.g. `/v1/chat/completions`).

**4. Expose to Cursor**

- Run a tunnel to **port 4000** (not 8080), e.g.  
  `cloudflared tunnel --url http://localhost:4000`
- In Cursor, set the OpenAI base URL to the tunnel URL with `/v1`, e.g.  
  `https://xxxx.trycloudflare.com/v1`  
  and use the same model names as in `model_name` in the config (`gpt-4o`, `gpt-4o-mini`, etc.).

**5. Optional — Docker**

You can run LiteLLM in Docker and point it at Ollama on the host:

```bash
docker run -p 4000:4000 -v "$(pwd)/litellm_config.yaml:/app/config.yaml" \
  -e OLLAMA_API_BASE=http://host.docker.internal:11434 \
  ghcr.io/berriai/litellm:main-latest --config /app/config.yaml
```

Adjust the image tag and how you pass `api_base` (e.g. per-model in the config) to match the [LiteLLM proxy docs](https://docs.litellm.ai/docs/proxy/configs).

If tool calling or streaming still misbehaves with Cursor, the cause may be model behavior (see the Reddit thread) or Cursor’s handling of custom endpoints; LiteLLM doesn’t fix those.

### Do you still need LiteLLM?

**No, for “Cursor + Ollama only” you don’t.** This project’s proxy now normalizes Cursor’s Responses API payload to Chat Completions (input→messages, strip Responses-only params, map reasoning/text, normalize tools, fill tool_calls names). That’s enough to talk to Ollama directly.

**LiteLLM is useful if you want:**
- **One base URL for multiple backends** — e.g. route `gpt-4o` to Ollama and `claude-3` to Anthropic from a single config.
- **Load balancing / fallbacks** — multiple deployments per model, automatic fallback if one fails.
- **Usage tracking, rate limits, keys** — built-in logging, spend tracking, and key-based access.
- **No custom proxy code** — you’d still need an adapter in front of LiteLLM to convert Cursor’s request format (same as our proxy), so the “no custom code” benefit only applies if Cursor is fixed to send Chat format.

**Summary:** Use our proxy + Ollama for a minimal path. Add LiteLLM (behind the same proxy, or with its own request adapter) only if you need multi-provider routing or LiteLLM’s ops features.

---

## Alternative tunnels (free) — if ngrok gives ERR_NGROK_3004 on streaming

These are free and may handle long-lived or chunked responses differently:

| Tunnel | How to run | Notes |
|--------|------------|--------|
| **Cloudflare Tunnel** | `brew install cloudflared` then `cloudflared tunnel --url http://localhost:8080` | Free; you get a `*.trycloudflare.com` URL. Often better with streaming than ngrok. |
| **LocalTunnel** | `npx localtunnel --port 8080` | No signup; URL like `https://something.loca.lt`. Can be flaky. |
| **Tailscale Funnel** | Install Tailscale, enable Funnel for a service on your machine | Free for personal; exposes via Tailscale; different stack than ngrok. |
| **bore** | `cargo install bore-cli` then `bore local 8080 --to bore.pub` | Simple; gives a public URL. |

With any of these, run the **proxy** on the host (e.g. `node proxy/server.js` with `PORT=8080` and `OLLAMA_UPSTREAM=http://127.0.0.1:11434`) or keep proxy in Docker and point the tunnel at the proxy. Then in Cursor use the tunnel’s HTTPS URL as the OpenAI base URL (e.g. `https://xxx.trycloudflare.com/v1` if the proxy serves at `/v1`).

---

## What about AWS Lambda as the tunnel?

**Lambda doesn’t work as a “tunnel” to your local Ollama.** Lambda runs in AWS and cannot open a connection to your Mac (you’re behind NAT, no fixed IP). So you can’t do “Cursor → Lambda → your home Ollama” with a simple tunnel.

Where Lambda *does* make sense is when the **model runs in the cloud**: e.g. API Gateway + Lambda that calls Bedrock, SageMaker, or another HTTP API in AWS. Then you have full control over timeouts, response streaming (Lambda supports streaming responses), and retries—but the inference is in AWS, not on your Mac. For “expose my local Ollama to Cursor,” stick to a tunnel (ngrok, Cloudflare, etc.) or run the model in the cloud and call it from Lambda.

---

## Other ways to run models with GPU

Any **OpenAI-compatible** server can be exposed with ngrok. Run it on the host and point ngrok at its port; create alias models or use names Cursor accepts.

| Option | What it is | GPU on Mac |
|--------|------------|------------|
| **Ollama (native)** | This guide; Ollama app or CLI on the host | ✅ Metal |
| **MLX** | Apple’s ML framework; runs models with Metal. You’d run an OpenAI-compatible server that uses MLX (e.g. **mlx-examples** chat/server, or **mlx-lm** with a small API wrapper). | ✅ Metal |
| **LM Studio** | Desktop app; load GGUF/other models, use Metal, expose a local OpenAI-compatible API. Point proxy at `http://host.docker.internal:1234` (or whatever port LM Studio uses). | ✅ Metal |
| **llama.cpp (Metal)** | Build llama.cpp with Metal; use a wrapper that exposes an API (e.g. **llama-cpp-python** with `server`, or **Open WebUI**’s backend). | ✅ Metal |
| **Inference servers (vLLM, etc.)** | Usually target NVIDIA/Linux; on Mac, MLX or Ollama are simpler for Metal. | N/A (Linux/NVIDIA) |

The name you’re thinking of is likely **MLX** (Apple’s machine learning framework), not “mdx.” MLX is what many Mac-native, GPU-accelerated inference options use under the hood.
