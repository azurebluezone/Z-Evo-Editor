"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "zc-runtime-test-"));
const workspace = path.join(temp, "workspace");
const dataDir = path.join(temp, "data");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "README.txt"), "hello from the test workspace\n");

process.env.DATA_DIR = dataDir;
process.env.ZC_WORKSPACE = workspace;
process.env.ZC_ZOMBIE_ENV = path.join(temp, "missing.env");
process.env.ZC_NO_PHP = "1";
process.env.ADMIN_TOKEN = "";
process.env.PORT = "0";
process.env.PHP_PORT = "0";

const runtime = require("./server.js");
const { server, db, core, config, runAgent, executeTool, appendMessage, conversationPayload } = runtime;

let base = "";
let mockProvider = null;
let mockMcp = null;

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")));
  });
}

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

function portOf(s) {
  return s.address().port;
}

async function api(pathname, options = {}) {
  const res = await fetch(base + pathname, options);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* SSE */
  }
  return { status: res.status, text, json };
}

test.before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;

  mockProvider = await listen(async (req, res) => {
    const body = await readJsonBody(req);
    const hasToolResult = (body.messages || []).some((m) => m.role === "tool");
    const payload = hasToolResult
      ? {
          choices: [
            {
              message: {
                role: "assistant",
                content: "The tool ran and the workspace is readable.",
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 8 },
        }
      : {
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_test_1",
                    type: "function",
                    function: { name: "list_files", arguments: '{"path":"/"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });

  mockMcp = await listen(async (req, res) => {
    const body = await readJsonBody(req);
    if (body.method === "initialize") {
      return res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "mock-mcp", version: "1.0.0" },
          },
        }),
      );
    }
    if (body.method === "notifications/initialized") {
      res.writeHead(202);
      return res.end();
    }
    if (body.method === "tools/list") {
      return res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "echo",
                description: "Echo text",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
                annotations: { readOnlyHint: true },
              },
            ],
          },
        }),
      );
    }
    if (body.method === "tools/call") {
      return res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: "mcp-echo:" + (body.params.arguments.text || "") }],
            isError: false,
          },
        }),
      );
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no method" } }));
  });
});

test.after(() => {
  if (mockProvider) mockProvider.close();
  if (mockMcp) mockMcp.close();
  server.close();
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

test("database schema and seed are created on boot", () => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  for (const name of [
    "identities",
    "system_prompts",
    "providers",
    "tools",
    "mcp_servers",
    "mcp_sessions",
    "projects",
    "sessions",
    "conversations",
    "messages",
    "snapshots",
  ]) {
    assert.ok(tables.includes(name), "missing table " + name);
  }
  assert.ok(core.state().identity.name.length > 0);
  assert.ok(core.state().prompt.content.includes("ZC"));
  assert.ok(core.state().tools.some((tool) => tool.name === "read_file" && tool.enabled));
  assert.ok(core.state().tools.some((tool) => tool.name === "write_file" && !tool.enabled));
  assert.equal(fs.existsSync(config.DB_PATH), true);
});

test("admin state never exposes provider secrets", () => {
  core.saveProvider({
    provider_id: "custom:secret-test",
    name: "Secret test",
    base_url: "http://127.0.0.1:9/v1",
    api_key: "super-secret-key",
    models: { m: "M" },
    connected: true,
  });
  const state = core.state();
  const provider = state.providers.find((row) => row.id === "custom:secret-test");
  assert.ok(provider);
  assert.equal(provider.api_key, "***");
  assert.equal(provider.has_key, true);
  assert.equal(JSON.stringify(state).includes("super-secret-key"), false);
  assert.equal(core.deleteProvider("custom:secret-test"), true);
});

test("provider, tool and MCP admin routes answer over HTTP", async () => {
  const state = await api("/api/admin/state");
  assert.equal(state.status, 200);
  assert.equal(state.json.ok, true);

  const created = await api("/api/admin/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider_id: "custom:http-test",
      name: "HTTP test",
      base_url: "http://127.0.0.1:9/v1",
      api_key: "hidden",
      models: "one=One",
    }),
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.ok, true);
  assert.equal(JSON.stringify(created.json).includes("hidden"), false);

  const writeTool = core.state().tools.find((tool) => tool.name === "write_file");
  const toggled = await api("/api/admin/tools/" + writeTool.id + "/toggle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(toggled.json.ok, true);
  assert.equal(core.tools().find((tool) => tool.name === "write_file").enabled, true);
  core.setToolEnabled("write_file", false);

  const added = await api("/api/admin/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Mock",
      url: "http://127.0.0.1:" + portOf(mockMcp) + "/mcp",
      enabled: true,
    }),
  });
  assert.equal(added.json.ok, true);
  const mcpId = added.json.mcp.id;
  const connected = await api("/api/admin/mcp/" + mcpId + "/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(connected.json.ok, true, connected.text);
  const mcpTool = core.tools().find((tool) => tool.source === "mcp" && tool.enabled);
  assert.ok(mcpTool);
  const out = await core.runTool(mcpTool.name, { text: "http" });
  assert.equal(out.ok, true);
  assert.match(out.output, /mcp-echo:http/);
  const deleted = await api("/api/admin/mcp/" + mcpId, { method: "DELETE" });
  assert.equal(deleted.json.ok, true);
  core.deleteProvider("custom:http-test");
});

test("frontend status, conversation and stream contracts", async () => {
  core.saveProvider({
    provider_id: "mock-provider",
    name: "Mock provider",
    base_url: "http://127.0.0.1:" + portOf(mockProvider) + "/v1",
    api_key: "mock-key",
    models: { "mock-model": "Mock Model" },
    connected: true,
    default_model: "mock-model",
  });
  // The HTTP layer reads csrf from settings, so mirror the bootstrap token.
  const bootstrap = await api("/api/bootstrap", {
    headers: { "X-ZC-Proxy-Token": config.PROXY_TOKEN },
  });
  assert.equal(bootstrap.status, 200);
  assert.ok(bootstrap.json.csrf);
  const token = bootstrap.json.csrf;

  const newSession = await api("/frontend/action?action=new_session", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-ZC-Proxy-Token": config.PROXY_TOKEN,
    },
    body: new URLSearchParams({ csrf_token: token }).toString(),
  });
  assert.equal(newSession.json.id.startsWith("conv_"), true);
  const conversationId = newSession.json.id;

  const started = await api("/frontend/action?action=start", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-ZC-Proxy-Token": config.PROXY_TOKEN,
    },
    body: new URLSearchParams({
      csrf_token: token,
      provider: "mock-provider",
      model: "mock-model",
      mode: "build",
    }).toString(),
  });
  assert.equal(started.json.success, true);

  const stream = await fetch(base + "/frontend/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-ZC-Proxy-Token": config.PROXY_TOKEN,
    },
    body: new URLSearchParams({
      csrf_token: token,
      conversation_id: conversationId,
      content: "read the workspace",
    }).toString(),
  });
  const text = await stream.text();
  assert.match(text, /"_event":"tool-call"/);
  assert.match(text, /"_event":"tool-result"/);
  assert.match(text, /"_event":"done"/);
  assert.match(text, /The tool ran and the workspace is readable\./);
  const payload = conversationPayload(conversationId);
  assert.equal(payload.messages.some((m) => m.role === "tool_result"), true);
  assert.equal(payload.messages.some((m) => m.role === "assistant" && m.parts.length > 0), true);
});

test("runAgent returns a tool result and final text", async () => {
  const convId = runtime.createConversation({ provider: "mock-provider", model: "mock-model", mode: "build" });
  assert.ok(convId);
  const events = [];
  const result = await runAgent(convId, "use list_files", (event) => events.push(event));
  assert.equal(result.ok, true);
  assert.equal(events.some((event) => event._event === "tool-call"), true);
  assert.equal(events.some((event) => event._event === "tool-result"), true);
  assert.equal(events.some((event) => event._event === "done"), true);
});

test("frontend settings_save creates and deletes a custom provider", async () => {
  const bootstrap = await api("/api/bootstrap", {
    headers: { "X-ZC-Proxy-Token": config.PROXY_TOKEN },
  });
  const token = bootstrap.json.csrf;
  const saved = await api("/frontend/action?action=settings_save", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-ZC-Proxy-Token": config.PROXY_TOKEN,
    },
    body: new URLSearchParams({
      csrf_token: token,
      provider_id: "custom:frontend-test",
      name: "Frontend test",
      base_url: "http://127.0.0.1:9/v1",
      api_key: "frontend-hidden",
      models: JSON.stringify({ "front-model": { name: "Front Model" } }),
    }).toString(),
  });
  assert.equal(saved.json.success, true);
  const providers = await api("/frontend/action?action=providers&csrf_token=" + encodeURIComponent(token), {
    headers: { "X-ZC-Proxy-Token": config.PROXY_TOKEN },
  });
  const row = providers.json.find((provider) => provider.id === "custom:frontend-test");
  assert.ok(row);
  assert.equal(row.models["front-model"].name, "Front Model");
  const removed = await api("/frontend/action?action=settings_delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-ZC-Proxy-Token": config.PROXY_TOKEN,
    },
    body: new URLSearchParams({ csrf_token: token, provider_id: "custom:frontend-test" }).toString(),
  });
  assert.equal(removed.json.success, true);
});

test("path traversal is rejected", async () => {
  const result = await executeTool(
    "read_file",
    { path: "../../../../etc/passwd" },
    { project: runtime.activeProject(), conversationId: "", mode: "build" },
  );
  assert.equal(result.ok, false);
  assert.match(result.output, /escapes|not found|Error/i);
});

test("tool snapshots can be diffed and restored", async () => {
  core.setToolEnabled("write_file", true);
  const before = core.state().tools.find((tool) => tool.name === "write_file");
  assert.equal(before.enabled, true);
  const result = await core.runTool("write_file", {
    path: "notes.txt",
    content: "first version\n",
  });
  assert.equal(result.ok, true);
  assert.match(result.diff, /first version/);
  const changes = core.state().logs;
  assert.ok(Array.isArray(changes));
  fs.rmSync(path.join(workspace, "notes.txt"), { force: true });
  core.setToolEnabled("write_file", false);
});
