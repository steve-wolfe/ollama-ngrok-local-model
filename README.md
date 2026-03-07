# Local Model

Run [Ollama](https://ollama.com) locally and expose it to the internet via [ngrok](https://ngrok.com), so you can use your self-hosted LLM from anywhere.

## What’s included

- **Ollama** – Local LLM server (Llama, Mistral, etc.) on port `11434`, with 65k context
- **Custom models** – Modelfiles in `modelfiles/` are built into the volume on first container run 
- **ngrok** – Public HTTPS tunnel to your Ollama API

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- An [ngrok](https://ngrok.com) account and [auth token](https://dashboard.ngrok.com/get-started/your-authtoken)

## Quick start

1. **Set your ngrok auth token**

   Create a `.env` file (it’s in `.gitignore` so it won’t be committed):

   ```bash
   echo "NGROK_AUTHTOKEN=your_token_here" > .env
   ```

2. **Build and start the stack**

   ```bash
   docker compose up -d --build
   ```

   The image is small. The first time the container starts with an empty volume, it builds all modelfiles directly into the volume—so you need enough disk space for the volume, not for the image.

3. **Get your public URL**

   Check ngrok’s logs for the public URL:

   ```bash
   docker logs ngrok
   ```

   You’ll see a line like `Forwarding https://xxxx.ngrok-free.app -> http://ollama:11434`. That `https://...` URL is your public Ollama API base.

## Usage

- **Local:** `http://localhost:11434`
- **Public:** Use the `https://....ngrok-free.app` URL from `docker logs ngrok`.

Compatible with anything that talks to the Ollama HTTP API (e.g. OpenAI-compatible clients using the base URL).

## Custom models (modelfiles)

Included modelfiles (customize `FROM` tags for size, e.g. `qwen2.5-coder:7b` for less RAM):

| Modelfile | Base model | Use case |
|-----------|------------|----------|
| `devstral-agent` | devstral-2 | Agentic coding (tool use, multi-file) |
| `qwen2.5-coder-agent` | qwen2.5-coder:32b | Strong code gen, long context |
| `deepseek-r1-agent` | deepseek-r1:32b | Reasoning + tool use |
| `llama3.2-coder` | llama3.2:3b | Lightweight, fast |

**Which models get built:** You can keep all modelfiles in the repo but only instantiate some of them. Set one of these in `docker-compose` or `.env` (comma-separated names, matching the modelfile basename):

- **Whitelist** – `OLLAMA_MODELFILES_INCLUDE=devstral-agent,qwen2.5-coder-agent` → only these are built on first run.
- **Blacklist** – `OLLAMA_MODELFILES_EXCLUDE=deepseek-r1-agent,llama3.2-coder` → build all except these.

If both are set, whitelist applies first, then blacklist. Unset = build all.

Add more files under `modelfiles/` with a `FROM <base>` line and optional `PARAMETER` / `SYSTEM` instructions. Rebuild and restart to pick up new or updated modelfiles (they’ll be built on next start if the volume is empty, or add them at runtime):

```bash
docker compose build --no-cache ollama && docker compose up -d
```

To add a model at runtime without rebuilding, pull and create inside the container:

```bash
docker exec -it ollama ollama pull <base>
docker exec -it ollama ollama create <name> -f -  # paste modelfile, then Ctrl-D
```

## Data

Ollama’s data (models, config) lives only in the Docker volume `ollama_data`. On first run with an empty volume, the entrypoint builds all modelfiles into that volume. No second copy; the image stays small.

## Docker disk space

If you see **no space left on device** during build or when pulling models, give Docker more disk:

- **Docker Desktop (Mac/Windows):** Settings → Resources → Disk image size — increase it (e.g. 100 GB+ for several large models). Apply & Restart.
- **Linux:** Docker uses the host filesystem. Free space on the root (or the partition where `/var/lib/docker` lives), or move Docker’s data root to a larger disk and point `"data-root"` there in `/etc/docker/daemon.json`.

With the current setup, model data is only in the volume, so the image build no longer pulls models and stays light; the first container run does the pulls and needs enough space for the volume (and for Docker’s volume storage on the host).

## Commands

| Command | Description |
|--------|-------------|
| `docker compose up -d --build` | Build image and start Ollama + ngrok (first run builds models into volume) |
| `docker compose down` | Stop both services |
| `docker exec -it ollama ollama list` | List installed models |
| `docker exec -it ollama ollama pull <model>` | Download a base model |
| `docker logs ngrok` | See ngrok status and public URL |
