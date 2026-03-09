# Notes

Technical notes, design decisions, and gotchas for this project.

---

## Why the proxy isn’t a “true” proxy

We don’t forward the request body unchanged. Two reasons, both about **API contract** (what the client sends vs what Ollama expects), not about what the underlying model “wants”:

1. **`input` vs `messages`**  
   Ollama’s OpenAI-compatible API expects the conversation in the **`messages`** field. Cursor (in some code paths) sends the same conversation in **`input`**. The structure inside (role/content) is the same; only the top-level key differs. Ollama only looks at `messages`. If we forwarded as-is when Cursor sends `input`, Ollama would see no `messages` and return 400 (“messages too short”). So we **normalize `input` → `messages`** when the client sends `input`.

2. **Responses API vs Chat Completions shape**  
   Cursor can send Responses-style fields (`reasoning`, `text`, tool variants, etc.) that Ollama Chat Completions does not fully accept as-is. The proxy strips/maps those fields and normalizes tools so the upstream request matches Ollama’s OpenAI-compatible chat endpoint.

> **Note:** Model aliasing is now handled by real alias models created from `scripts/model-map.json` → `modelfiles/` via `ollama create`, not by proxy-side `model` rewrite.

A true pass-through proxy would only work if the client already sent the exact shape Ollama expects (same model names and same field names). Since it doesn’t, we adapt the body.

---

## Cursor “Invalid API key” when the proxy returns 400

If the proxy returns 400 (e.g. empty body, invalid JSON, or we used to reject empty `messages`), Cursor can treat the custom endpoint as “broken” and **fall back to the default OpenAI provider**. The UI then shows “Invalid API key” even though the problem was the 400 from our proxy, not key validation. So: returning 400 from the proxy can cause Cursor to stop using the override URL and hit OpenAI, which then complains about the key. Prefer forwarding to Ollama and letting Ollama return 400 when possible, so Cursor keeps talking to our endpoint.

---

## Which logs to tail

- **Proxy (request handling, model mapping):** `docker logs -f ollama-proxy`
- **Ollama (inference, GIN request log):** `docker logs -f ollama`
- **ngrok (tunnel status, public URL):** `docker logs ngrok`

If you don’t see your `server.js` logging, you’re likely tailing `ngrok` or `ollama` instead of `ollama-proxy`.

---

## Proxy logging and verbosity

The proxy uses `process.stdout.write(… + '\n')` for log lines so output isn’t buffered in Docker. It can also log the full request body (`bodyJson`) on each request, which is useful for debugging but can be very noisy for large chat payloads. Tune or disable the body dump in production if needed.

---

## Request flow

Traffic goes **client → ngrok (public HTTPS) → proxy:8080 → ollama:11434**. ngrok tunnels to the **proxy**, not directly to Ollama. So every client request is rewritten (model name, and `input`→`messages` when needed) before hitting Ollama.

---

## Model build: first run only, into volume

Models are **not** baked into the Docker image. The image only has modelfiles and scripts. On **first container run**, the entrypoint checks whether the Ollama data dir (volume) is empty (no blobs). If so, it runs `build-models.sh`, which pulls base models and creates custom models from the modelfiles **into the volume**. Later runs skip that and just start `ollama serve`. So: one copy of model data in the volume, small image, long first run.

---

## Modelfile filters (whitelist / blacklist)

- **`OLLAMA_MODELFILES_INCLUDE`** – Comma-separated whitelist: only these modelfiles are built.
- **`OLLAMA_MODELFILES_EXCLUDE`** – Comma-separated blacklist: build all except these.
- If both are set, whitelist is applied first, then blacklist. Unset = build all.
- Filter names are the **modelfile basename** (e.g. `deepseek-r1-agent` for `modelfiles/deepseek-r1-agent`).

---

## scripts/model-map.json: keys and values

- **Keys** = alias names Cursor (or another client) will call (e.g. `gpt-4o-mini`).
- **Values** = base model names to reference in generated alias modelfiles.
- Apply changes by re-running:
  - `./scripts/ollama-create-aliases.sh`
  - `./scripts/build-models.sh`
  Restart proxy only if needed for other config changes.

---

## Verifying Cursor uses the override URL

1. Set Cursor → Settings → Models → OpenAI Base URL to your ngrok URL with `/v1` (e.g. `https://xxxx.ngrok-free.app/v1`).
2. Tail the proxy: `docker logs -f ollama-proxy`.
3. Send a message in Cursor. You should see a line like `POST /v1/chat/completions` and `>>> normalized model=...` in proxy logs.
4. Optional: `curl -s "https://YOUR_NGROK_URL/v1/models"` and confirm proxy logs show `GET /v1/models`. If curl hits the proxy but Cursor doesn’t, Cursor isn’t using the override.
