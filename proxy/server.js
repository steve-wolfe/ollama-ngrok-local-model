/**
 * Cursor → Chat Completions proxy. Normalizes OpenAI Responses API payloads (Cursor Agent)
 * to standard Chat Completions format, then forwards to Ollama (or another OpenAI-compatible backend).
 * - input → messages, content normalization
 * - Strip Responses-only params; map reasoning/text → reasoning_effort/response_format
 * - Normalize tools (flat/custom → nested function format)
 * - Fill tool_calls[].function.name in stream (Ollama often omits it)
 */

const http = require("http");
const { Readable } = require("stream");

const OLLAMA_UPSTREAM = process.env.OLLAMA_UPSTREAM || "http://host.docker.internal:11434";
const PORT = Number(process.env.PORT) || 8080;
const DISABLE_STREAMING = process.env.PROXY_DISABLE_STREAMING === "1" || process.env.PROXY_DISABLE_STREAMING === "true";
const KEEPALIVE_MS = Math.max(0, Number(process.env.STREAM_KEEPALIVE_MS) || 8000);

/** Responses API-only keys to remove before forwarding to Chat Completions backends. */
const RESPONSES_ONLY_KEYS = [
  "store", "include", "prompt_cache_retention", "previous_response_id",
  "truncation", "reasoning", "text", "stream_options",
];

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** Infer a Cursor tool name from tool call arguments (fallback when request has no tools). Handles partial JSON from streaming. */
function inferToolNameFromArguments(argsStr) {
  if (typeof argsStr !== "string") return "";
  const raw = argsStr;
  try {
    const k = Object.keys(JSON.parse(argsStr));
    const s = k.join(" ");
    if (s.includes("open_files") && s.includes("workspace_path")) return "get_editor_context";
    if (s.includes("filesystemPath")) return "ListDir";
    if (s.includes("path") && (s.includes("offset") || s.includes("limit"))) return "Read";
    if (s.includes("path") && s.includes("old_string")) return "StrReplace";
    if (s.includes("path") && s.includes("contents")) return "Write";
    if (s.includes("path") && !s.includes("old_string")) return "Read";
    if (s.includes("command")) return "Shell";
    if (s.includes("glob_pattern")) return "Glob";
    if (s.includes("pattern")) return "Grep";
    if (s.includes("target_notebook")) return "EditNotebook";
    if (s.includes("paths")) return "ReadLints";
    if (s.includes("query") && s.includes("target_directories")) return "SemanticSearch";
    if (s.includes("todos")) return "TodoWrite";
    if (s.includes("target_file")) return "Delete";
  } catch (_) {
    if (raw.includes("filesystemPath")) return "ListDir";
    if (raw.includes("open_files") && raw.includes("workspace_path")) return "get_editor_context";
    if (raw.includes("command")) return "Shell";
    if (raw.includes("glob_pattern")) return "Glob";
    if (raw.includes("pattern")) return "Grep";
    if (raw.includes("old_string")) return "StrReplace";
    if (raw.includes("target_notebook")) return "EditNotebook";
    if (raw.includes("target_directories")) return "SemanticSearch";
    if (raw.includes("todos")) return "TodoWrite";
  }
  return "";
}

/** Fill tool_calls[].function.name from request tools[] by index (Ollama often sends empty name). */
function fillToolCallNames(toolCalls, requestTools) {
  if (!Array.isArray(toolCalls)) return;
  for (const tc of toolCalls) {
    if (!tc?.function) continue;
    if (tc.function.name !== "" && tc.function.name != null) continue;
    const idx = tc.index;
    const def = Array.isArray(requestTools) ? requestTools[idx]?.function : null;
    if (def && typeof def.name === "string") {
      tc.function.name = def.name;
    } else {
      const inferred = inferToolNameFromArguments(tc.function.arguments);
      if (inferred) tc.function.name = inferred;
    }
  }
}

function normalizeMessages(body) {
  if (!body || typeof body !== "object") return body;
  // Cursor sends "input" sometimes; Ollama expects "messages"
  if ((!Array.isArray(body.messages) || body.messages.length === 0) && Array.isArray(body.input) && body.input.length > 0) {
    body.messages = body.input;
  }
  const messages = body.messages;
  if (!Array.isArray(messages)) return body;
  for (const msg of messages) {
    if (!msg) continue;
    if (msg.content == null || msg.content === undefined) {
      msg.content = "";
      continue;
    }
    if (Array.isArray(msg.content)) {
      msg.content = msg.content
        .map((part) => (part && typeof part.text === "string" ? part.text : ""))
        .join("");
      continue;
    }
    if (typeof msg.content !== "string") {
      msg.content = msg.content && typeof msg.content.text === "string" ? msg.content.text : "";
    }
  }
  return body;
}

/** Map Responses API params to Chat Completions params, then strip Responses-only keys. */
function stripResponsesOnlyParams(body) {
  if (!body || typeof body !== "object") return;
  if (body.reasoning && typeof body.reasoning === "object" && body.reasoning.effort != null) {
    body.reasoning_effort = body.reasoning.effort;
  }
  if (body.text && typeof body.text === "object" && body.text.format != null) {
    body.response_format = body.text.format;
  }
  for (const key of RESPONSES_ONLY_KEYS) {
    delete body[key];
  }
}

/** Convert Cursor/Responses API tool shape to Chat Completions nested function format. */
function normalizeTools(body) {
  if (!body || !Array.isArray(body.tools)) return;
  for (const tool of body.tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "function") {
      if (!tool.function && (tool.name != null || tool.description != null || tool.parameters != null)) {
        tool.function = {
          name: tool.name ?? "",
          description: tool.description ?? "",
          parameters: tool.parameters ?? { type: "object", properties: {} },
        };
        delete tool.name;
        delete tool.description;
        delete tool.parameters;
      }
    } else if (tool.type === "custom") {
      tool.type = "function";
      tool.function = {
        name: tool.name ?? "custom",
        description: typeof tool.description === "string" ? tool.description : (tool.format ? "Custom tool" : ""),
        parameters: tool.parameters ?? { type: "object", properties: {} },
      };
      delete tool.name;
      delete tool.description;
      delete tool.parameters;
      delete tool.format;
    }
  }
}

/** Full Cursor Responses API → Chat Completions request normalization. */
function normalizeCursorResponsesPayload(body) {
  if (!body || typeof body !== "object") return body;
  normalizeMessages(body);
  stripResponsesOnlyParams(body);
  normalizeTools(body);
  return body;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  try {
    const body = req.method !== "GET" && req.method !== "HEAD" ? await readBody(req) : undefined;
    log(">>>", req.method, url.pathname, body != null ? `body ${typeof body === "string" ? body.length : JSON.stringify(body).length} chars` : "no body");
    if (body && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/completions")) {
      const raw = typeof body === "string" ? body : JSON.stringify(body);
      const preview = raw.length > 1500 ? raw.slice(0, 1500) + "…[truncated]" : raw;
      log(">>> body preview", preview);
    }
    let out;
    if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/completions") && body) {
      let parsed;
      try {
        parsed = typeof body === "string" ? JSON.parse(body) : body;
      } catch (_) {
        log("xxx", "Invalid JSON body");
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }));
        return;
      }
      normalizeCursorResponsesPayload(parsed);
      if (DISABLE_STREAMING) parsed.stream = false;
      const toolNames = Array.isArray(parsed.tools) ? parsed.tools.map((t) => t?.function?.name ?? t?.name ?? t?.type) : [];
      log(">>> normalized", "model=" + (parsed.model || ""), "stream=" + !!parsed.stream, "messages=" + (Array.isArray(parsed.messages) ? parsed.messages.length : 0), "tools=" + (toolNames.length ? toolNames.join(",") : "none"));
      const forwarded = JSON.stringify(parsed);
      const upstreamUrl = `${OLLAMA_UPSTREAM}${url.pathname}${url.search || ""}`;
      log(">>> forwarding to", upstreamUrl);
      const r = await fetch(upstreamUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: forwarded,
      });
      log("<<< upstream status", r.status, r.statusText);
      if (DISABLE_STREAMING) {
        const outBody = await r.arrayBuffer();
        log("<<< non-streaming response", outBody.byteLength, "bytes");
        const full = JSON.parse(Buffer.from(outBody).toString("utf8"));
        const choice = full.choices?.[0];
        const msg = choice?.message || {};
        const finishReason = choice?.finish_reason || "stop";
        const id = full.id || "chatcmpl-0";
        const created = full.created ?? Math.floor(Date.now() / 1000);
        const model = parsed.model || full.model || "";
        const chunks = [
          JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
          JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: typeof msg.content === "string" ? msg.content : "" }, finish_reason: null }] }),
        ];
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          const withIndex = msg.tool_calls.map((tc, i) => ({ ...tc, index: i }));
          fillToolCallNames(withIndex, parsed.tools);
          chunks.push(JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: withIndex }, finish_reason: null }] }));
        }
        chunks.push(JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }));
        const sse = chunks.map((c) => "data: " + c + "\n\n").join("") + "data: [DONE]\n\n";
        res.writeHead(r.status, { "Content-Type": "text/event-stream", "Transfer-Encoding": "chunked" });
        res.end(sse);
      } else if (parsed.stream && r.body) {
        const headers = Object.fromEntries(r.headers.entries());
        delete headers["content-length"];
        delete headers["transfer-encoding"];
        res.writeHead(r.status, { ...headers, "Transfer-Encoding": "chunked" });
        const tools = parsed.tools;
        let buf = "";
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let keepaliveId = null;
        let sawFirstChunk = false;
        if (KEEPALIVE_MS > 0) {
          keepaliveId = setInterval(() => {
            try {
              if (!res.writableEnded) res.write(": keepalive\n\n");
            } catch (_) {}
          }, KEEPALIVE_MS);
        }
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const events = buf.split("\n\n");
            buf = events.pop() || "";
            for (const ev of events) {
              const line = ev.trim();
              if (!line.startsWith("data: ")) continue;
              const payload = line.slice(6);
              if (payload === "[DONE]") {
                res.write("data: [DONE]\n\n");
                continue;
              }
              try {
                const obj = JSON.parse(payload);
                const delta = obj.choices?.[0]?.delta;
                if (!sawFirstChunk) {
                  sawFirstChunk = true;
                  const deltaStr = JSON.stringify(delta ?? {}).slice(0, 400);
                  log("<<< first stream chunk delta", deltaStr + (deltaStr.length >= 400 ? "…" : ""));
                }
                if (delta?.tool_calls) fillToolCallNames(delta.tool_calls, tools);
                res.write("data: " + JSON.stringify(obj) + "\n\n");
              } catch (_) {
                res.write(line + "\n\n");
              }
            }
          }
          if (buf.trim()) {
            const line = buf.trim();
            if (line.startsWith("data: ")) {
              const payload = line.slice(6);
              if (payload !== "[DONE]") {
                try {
                  const obj = JSON.parse(payload);
                  const delta = obj.choices?.[0]?.delta;
                  if (delta?.tool_calls) fillToolCallNames(delta.tool_calls, tools);
                  res.write("data: " + JSON.stringify(obj) + "\n\n");
                } catch (_) {
                  res.write(line + "\n\n");
                }
              } else {
                res.write("data: [DONE]\n\n");
              }
            }
          }
        } finally {
          if (keepaliveId) clearInterval(keepaliveId);
          reader.releaseLock();
        }
        res.end();
        log("<<< stream end (sent to client)");
      } else {
        const outBody = await r.arrayBuffer();
        log("<<< non-stream response", outBody.byteLength, "bytes");
        res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
        res.end(Buffer.from(outBody));
      }
      return;
    }
    // Pass-through: GET and other POST
    log(">>> passthrough", req.method, url.pathname);
    const upstreamUrl = `${OLLAMA_UPSTREAM}${url.pathname}${url.search || ""}`;
    const opts = { method: req.method, headers: req.headers };
    if (body) opts.body = body;
    const r = await fetch(upstreamUrl, opts);
    const outBody = await r.arrayBuffer();
    log("<<< passthrough status", r.status, "body", outBody.byteLength, "bytes");
    res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
    res.end(Buffer.from(outBody));
  } catch (e) {
    log("xxx proxy error", e?.stack || String(e));
    console.error(e);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(e.message), type: "gateway_error" } }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Normalize proxy listening on ${PORT} -> ${OLLAMA_UPSTREAM}`);
});
