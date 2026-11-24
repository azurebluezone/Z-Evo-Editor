#!/usr/bin/env node
"use strict";

// =============================================================================
// ZC Runtime Server
// -----------------------------------------------------------------------------
// One Node process owns the SQLite database, provider credentials, MCP
// connections, conversations and the agent tool loop. The PHP front controller
// is started as a child process and proxies the existing UI contract here.
//
// No npm dependencies. Node >= 24 (node:sqlite, fetch, AbortSignal.any).
// =============================================================================

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

try {
  process.umask(0o077);
} catch {
  /* best effort */
}

const ROOT = __dirname;

// Environment is loaded before any path or credential is read. A real process
// environment always wins; the files only fill variables that are still empty.
function loadEnvFiles() {
  const explicit = String(process.env.ZC_ENV_FILE || "").trim();
  const files = [];
  if (explicit) files.push(path.resolve(explicit));
  files.push(path.join(ROOT, ".env"), path.resolve(ROOT, "..", ".env"));
  const loaded = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const values = readEnvFile(file);
    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
    }
    loaded.push(file);
  }
  return [...new Set(loaded)];
}
const ENV_FILES = loadEnvFiles();
const APP_DIR = path.resolve(ROOT, "..", "app");
const WORKSPACE = path.resolve(process.env.ZC_WORKSPACE || path.resolve(ROOT, "..", ".."));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.resolve(ROOT, "..", "data"));
const DB_PATH = path.join(DATA_DIR, "zc.sqlite");
const PROJECTS_DIR = path.resolve(process.env.ZC_PROJECTS_DIR || path.join(WORKSPACE, "php", "workspaces"));
const VERSION = "2.0.0";
const STARTED = Date.now();

const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "127.0.0.1";
const PHP_PORT = parseInt(process.env.PHP_PORT || "8788", 10);
const PHP_HOST = process.env.PHP_HOST || "127.0.0.1";
const MAX_BODY = parseInt(process.env.MAX_BODY || "2097152", 10);
const EXEC_TIMEOUT = parseInt(process.env.EXEC_TIMEOUT || "30000", 10);
const EXEC_MAX_BUFFER = parseInt(process.env.EXEC_MAX_BUFFER || "262144", 10);
const MAX_ITER = Math.min(16, Math.max(1, parseInt(process.env.MAX_ITER || "8", 10)));
const ADMIN_AUTH_ENABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.ADMIN_TOKEN_ENABLED || process.env.ZC_ADMIN_TOKEN_ENABLED || "false"),
);
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();
const ALLOW_OUTSIDE = process.env.ZC_ALLOW_OUTSIDE === "1";
const NO_PHP = process.env.ZC_NO_PHP === "1";
const PROXY_TOKEN =
  String(process.env.ZC_PROXY_TOKEN || "").trim() || crypto.randomBytes(24).toString("hex");
const ZOMBIE_ENV = path.resolve(
  process.env.ZC_ZOMBIE_ENV || path.join(os.homedir(), "zombiebd", ".env"),
);

const SYSTEM_IDENTITY = {
  name: process.env.ZC_IDENTITY_NAME || "ZombieCoder",
  version: process.env.ZC_IDENTITY_VERSION || "1.0.0",
  tagline: process.env.ZC_IDENTITY_TAGLINE || "যেখানে কোড ও কথা বলে",
  powered_by_header: process.env.ZC_IDENTITY_POWERED_BY || "ZombieCoder-by-SahonSrabon",
  branding: {
    owner: process.env.ZC_IDENTITY_OWNER || "Sahon Srabon",
    organization: process.env.ZC_IDENTITY_ORG || "Developer Zone",
    address: process.env.ZC_IDENTITY_ADDRESS || "235 South Pirarbag, Amtala Bazar, Mirpur - 60 feet",
    location: process.env.ZC_IDENTITY_LOCATION || "Dhaka, Bangladesh",
  },
  contact: {
    phone: process.env.ZC_IDENTITY_PHONE || "+880 1323-626282",
    email: process.env.ZC_IDENTITY_EMAIL || "infi@zombiecoder.my.id",
    website: process.env.ZC_IDENTITY_WEBSITE || "https://zombiecoder.my.id/",
  },
};

// ── small utilities ───────────────────────────────────────────
function now() {
  return Date.now();
}
function randomId(prefix) {
  return prefix + crypto.randomBytes(9).toString("base64url");
}
function clampText(value, max) {
  const text = String(value == null ? "" : value);
  return text.length > max ? text.slice(0, max) : text;
}
function asInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function isInside(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}
function realInside(root, target) {
  const rootReal = fs.realpathSync(root);
  const check = (candidate) => {
    const real = fs.realpathSync(candidate);
    if (!isInside(rootReal, real)) {
      const err = new Error("path escapes the project root through a link");
      err.code = "outside_project";
      throw err;
    }
  };
  if (fs.existsSync(target)) {
    check(target);
  } else {
    let parent = path.dirname(target);
    while (!fs.existsSync(parent) && parent !== path.dirname(parent)) parent = path.dirname(parent);
    if (fs.existsSync(parent)) check(parent);
  }
}
function safeResolve(root, requested) {
  let raw = String(requested == null ? "" : requested).trim();
  if (!raw || raw === "/" || raw === ".") return path.resolve(root);
  if (path.isAbsolute(raw)) {
    const abs = path.resolve(raw);
    if (isInside(root, abs)) {
      realInside(root, abs);
      return abs;
    }
    raw = raw.replace(/^\/+/, "");
  }
  const abs = path.resolve(root, raw);
  if (!isInside(root, abs)) {
    const err = new Error("path escapes the project root");
    err.code = "outside_project";
    throw err;
  }
  realInside(root, abs);
  return abs;
}
function relativeDisplay(root, abs) {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  return rel ? "/" + rel : "/";
}
function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    const eq = raw.indexOf("=");
    if (eq < 1) continue;
    const key = raw.slice(0, eq).trim();
    let value = raw.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
function modelsFromList(value, contextWindow = 32768) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  const out = {};
  const list = Array.isArray(value) ? value : String(value).split(/[,\n]/);
  for (const item of list) {
    const raw = String(item).trim();
    if (!raw) continue;
    const [idPart, namePart] = raw.split("=");
    const id = idPart.trim();
    if (!id) continue;
    out[id] = { name: (namePart || id).trim(), context_window: contextWindow };
  }
  return out;
}
function readPhpJson(file) {
  if (!fs.existsSync(file)) return null;
  let text = fs.readFileSync(file, "utf8");
  text = text.replace(/^\s*<\?php[\s\S]*?\?>\s*/, "");
  return parseJson(text, null);
}
function joinUrl(base, suffix) {
  if (!base) return "";
  return String(base).replace(/\/+$/, "") + "/" + String(suffix).replace(/^\/+/, "");
}
function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    chars += String(m.content || "").length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.max(1, Math.round(chars / 4));
}
function compactError(error) {
  return clampText(error && error.message ? error.message : String(error), 1200);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── file logging + SQLite runtime log ────────────────────────
function appendLog(level, event, fields = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }) + "\n";
  try {
    fs.appendFileSync(path.join(DATA_DIR, "zc.log"), line);
  } catch {
    /* logging must never stop the server */
  }
  process.stdout.write(line);
}

// ═════════════════════════════════════════════════════════════
// Database
// ═════════════════════════════════════════════════════════════
function requireSqlite() {
  try {
    return require("node:sqlite").DatabaseSync;
  } catch {
    throw new Error("node:sqlite is unavailable; use Node 24 or newer");
  }
}

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS identities (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  owner    TEXT NOT NULL DEFAULT '',
  source   TEXT NOT NULL DEFAULT 'local',
  metadata TEXT NOT NULL DEFAULT '{}',
  created  INTEGER NOT NULL,
  updated  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS system_prompts (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  content TEXT NOT NULL,
  active  INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS providers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'openai',
  base_url      TEXT NOT NULL DEFAULT '',
  api_key       TEXT NOT NULL DEFAULT '',
  models_json   TEXT NOT NULL DEFAULT '{}',
  connected     INTEGER NOT NULL DEFAULT 0,
  default_model TEXT NOT NULL DEFAULT '',
  no_key        INTEGER NOT NULL DEFAULT 0,
  supports_tools INTEGER NOT NULL DEFAULT 1,
  is_custom_type INTEGER NOT NULL DEFAULT 0,
  last_test_ok  INTEGER,
  last_test_at  INTEGER,
  last_error    TEXT NOT NULL DEFAULT '',
  created       INTEGER NOT NULL,
  updated       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tools (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  external_name  TEXT NOT NULL DEFAULT '',
  description    TEXT NOT NULL DEFAULT '',
  schema_json    TEXT NOT NULL DEFAULT '{}',
  source         TEXT NOT NULL DEFAULT 'builtin',
  mcp_server_id  TEXT,
  enabled        INTEGER NOT NULL DEFAULT 0,
  read_only      INTEGER NOT NULL DEFAULT 0,
  created        INTEGER NOT NULL,
  updated        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tools_source ON tools (source, enabled);
CREATE TABLE IF NOT EXISTS mcp_servers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  transport     TEXT NOT NULL DEFAULT 'http',
  auth_type     TEXT NOT NULL DEFAULT 'none',
  auth_header   TEXT NOT NULL DEFAULT 'Authorization',
  auth_value    TEXT NOT NULL DEFAULT '',
  headers_json  TEXT NOT NULL DEFAULT '{}',
  enabled       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'new',
  last_error    TEXT NOT NULL DEFAULT '',
  tools_json    TEXT NOT NULL DEFAULT '[]',
  protocol_version TEXT NOT NULL DEFAULT '',
  session_id    TEXT NOT NULL DEFAULT '',
  created       INTEGER NOT NULL,
  updated       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_sessions (
  id               TEXT PRIMARY KEY,
  server_id        TEXT NOT NULL,
  conversation_id  TEXT NOT NULL DEFAULT '',
  session_id       TEXT NOT NULL,
  protocol_version TEXT NOT NULL DEFAULT '',
  created          INTEGER NOT NULL,
  updated          INTEGER NOT NULL,
  UNIQUE(server_id, conversation_id)
);
CREATE TABLE IF NOT EXISTS projects (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  path    TEXT NOT NULL,
  type    TEXT NOT NULL DEFAULT 'custom',
  insid   TEXT NOT NULL DEFAULT '',
  closed  INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  provider        TEXT NOT NULL DEFAULT '',
  model           TEXT NOT NULL DEFAULT '',
  mode            TEXT NOT NULL DEFAULT 'build',
  title           TEXT NOT NULL DEFAULT 'New Session',
  running         INTEGER NOT NULL DEFAULT 0,
  last_status     TEXT NOT NULL DEFAULT 'idle',
  created         INTEGER NOT NULL,
  updated         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_project_updated ON sessions (project_id, updated DESC);
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT 'New Session',
  provider   TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  mode       TEXT NOT NULL DEFAULT 'build',
  created    INTEGER NOT NULL,
  updated    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL,
  role             TEXT NOT NULL,
  content          TEXT NOT NULL DEFAULT '',
  parts_json       TEXT NOT NULL DEFAULT '[]',
  tool_calls_json  TEXT NOT NULL DEFAULT '[]',
  tool_call_id     TEXT NOT NULL DEFAULT '',
  name             TEXT NOT NULL DEFAULT '',
  model            TEXT NOT NULL DEFAULT '',
  provider         TEXT NOT NULL DEFAULT '',
  usage_json       TEXT NOT NULL DEFAULT '{}',
  diff             TEXT NOT NULL DEFAULT '',
  is_error         INTEGER NOT NULL DEFAULT 0,
  seq              INTEGER NOT NULL,
  created          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conv_seq ON messages (conversation_id, seq);
CREATE TABLE IF NOT EXISTS snapshots (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  label           TEXT NOT NULL DEFAULT 'Snapshot',
  files_json      TEXT NOT NULL DEFAULT '{}',
  diff_text       TEXT NOT NULL DEFAULT '',
  created         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS undo_stack (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  messages_json   TEXT NOT NULL,
  created         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
  model_id TEXT PRIMARY KEY,
  created  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS permissions (
  key     TEXT PRIMARY KEY,
  value   TEXT NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_contexts (
  project_id TEXT NOT NULL,
  kind       TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  updated    INTEGER NOT NULL,
  PRIMARY KEY (project_id, kind)
);
CREATE TABLE IF NOT EXISTS runtime_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  level   TEXT NOT NULL,
  event   TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS request_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id      TEXT NOT NULL,
  method          TEXT NOT NULL,
  route           TEXT NOT NULL,
  action          TEXT NOT NULL DEFAULT '',
  status          INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  ip              TEXT NOT NULL DEFAULT '',
  user_agent      TEXT NOT NULL DEFAULT '',
  query           TEXT NOT NULL DEFAULT '',
  project_id      TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  provider        TEXT NOT NULL DEFAULT '',
  model           TEXT NOT NULL DEFAULT '',
  bytes           INTEGER NOT NULL DEFAULT 0,
  is_admin        INTEGER NOT NULL DEFAULT 0,
  created         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS request_log_created ON request_log (created DESC);
CREATE TABLE IF NOT EXISTS session_metrics (
  conversation_id  TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL DEFAULT '',
  provider         TEXT NOT NULL DEFAULT '',
  model            TEXT NOT NULL DEFAULT '',
  mode             TEXT NOT NULL DEFAULT 'build',
  iterations       INTEGER NOT NULL DEFAULT 0,
  tool_calls       INTEGER NOT NULL DEFAULT 0,
  tool_errors      INTEGER NOT NULL DEFAULT 0,
  message_count    INTEGER NOT NULL DEFAULT 0,
  prompt_tokens    INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens    INTEGER NOT NULL DEFAULT 0,
  total_tokens     INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'idle',
  error            TEXT NOT NULL DEFAULT '',
  started          INTEGER NOT NULL DEFAULT 0,
  updated          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_metrics_updated ON session_metrics (updated DESC);
CREATE TABLE IF NOT EXISTS env_import (
  key     TEXT PRIMARY KEY,
  value   TEXT NOT NULL DEFAULT '',
  secret  INTEGER NOT NULL DEFAULT 0,
  source  TEXT NOT NULL DEFAULT '',
  updated INTEGER NOT NULL
);
`;

fs.mkdirSync(DATA_DIR, { recursive: true });
try {
  fs.chmodSync(DATA_DIR, 0o700);
} catch {
  /* best effort */
}
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

const DatabaseSync = requireSqlite();
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
const db = new DatabaseSync(DB_PATH);
db.exec(SCHEMA);
ensureColumn("providers", "supports_tools", "INTEGER NOT NULL DEFAULT 1");
for (const file of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* the WAL files may not exist yet */
  }
}

function sqlRun(sql, ...params) {
  return db.prepare(sql).run(...params);
}
function sqlGet(sql, ...params) {
  return db.prepare(sql).get(...params);
}
function sqlAll(sql, ...params) {
  return db.prepare(sql).all(...params);
}
function getSetting(key, fallback = null) {
  const row = sqlGet("SELECT value FROM settings WHERE key = ?", key);
  if (!row) return fallback;
  return parseJson(row.value, row.value);
}
function setSetting(key, value) {
  sqlRun(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    JSON.stringify(value),
  );
}
function logDb(level, event, fields = {}) {
  try {
    sqlRun(
      "INSERT INTO runtime_log (level, event, detail, created) VALUES (?, ?, ?, ?)",
      level,
      event,
      JSON.stringify(fields),
      now(),
    );
    sqlRun(
      "DELETE FROM runtime_log WHERE id NOT IN (SELECT id FROM runtime_log ORDER BY id DESC LIMIT 1000)",
    );
  } catch {
    /* never fail a request because logging failed */
  }
}
function logEvent(level, event, fields = {}) {
  appendLog(level, event, fields);
  logDb(level, event, fields);
}
function brandingHeaders(extra = {}) {
  return {
    "X-Powered-By": SYSTEM_IDENTITY.powered_by_header,
    "X-System-Identity": SYSTEM_IDENTITY.name,
    "X-System-Version": SYSTEM_IDENTITY.version,
    "X-System-Owner": SYSTEM_IDENTITY.branding.owner,
    "X-System-Website": SYSTEM_IDENTITY.contact.website,
    ...extra,
  };
}
function requestLog(fields) {
  const detail = {
    request_id: fields.request_id,
    method: fields.method,
    route: fields.route,
    action: fields.action || "",
    status: fields.status,
    ms: fields.duration_ms,
    ip: fields.ip || "",
    user_agent: clampText(fields.user_agent || "", 240),
    query: fields.query || "",
    project_id: fields.project_id || "",
    conversation_id: fields.conversation_id || "",
    provider: fields.provider || "",
    model: fields.model || "",
    bytes: fields.bytes || 0,
    admin: !!fields.is_admin,
  };
  appendLog(fields.status >= 500 ? "ERROR" : fields.status >= 400 ? "WARN" : "INFO", "request", detail);
  try {
    sqlRun(
      `INSERT INTO request_log
        (request_id, method, route, action, status, duration_ms, ip, user_agent, query,
         project_id, conversation_id, provider, model, bytes, is_admin, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      detail.request_id,
      detail.method,
      detail.route,
      detail.action,
      detail.status,
      detail.ms || 0,
      detail.ip,
      detail.user_agent,
      detail.query,
      detail.project_id,
      detail.conversation_id,
      detail.provider,
      detail.model,
      detail.bytes,
      detail.admin ? 1 : 0,
      now(),
    );
    sqlRun("DELETE FROM request_log WHERE id NOT IN (SELECT id FROM request_log ORDER BY id DESC LIMIT 20000)");
  } catch {
    /* request logging must never break a response */
  }
}
function recordSessionMetric(conversationId, fields = {}) {
  if (!conversationId) return;
  const current = sqlGet("SELECT * FROM session_metrics WHERE conversation_id = ?", conversationId) || {};
  const pick = (key, fallback = 0) => (fields[key] == null ? current[key] ?? fallback : fields[key]);
  const messageCount = sqlGet("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?", conversationId).n;
  sqlRun(
    `INSERT INTO session_metrics
      (conversation_id, project_id, provider, model, mode, iterations, tool_calls, tool_errors,
       message_count, prompt_tokens, completion_tokens, cached_tokens, total_tokens, duration_ms,
       status, error, started, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       project_id = excluded.project_id, provider = excluded.provider, model = excluded.model,
       mode = excluded.mode, iterations = excluded.iterations, tool_calls = excluded.tool_calls,
       tool_errors = excluded.tool_errors, message_count = excluded.message_count,
       prompt_tokens = excluded.prompt_tokens, completion_tokens = excluded.completion_tokens,
       cached_tokens = excluded.cached_tokens, total_tokens = excluded.total_tokens,
       duration_ms = excluded.duration_ms, status = excluded.status, error = excluded.error,
       started = excluded.started, updated = excluded.updated`,
    conversationId,
    String(pick("project_id", "")),
    String(pick("provider", "")),
    String(pick("model", "")),
    String(pick("mode", "build")),
    asInt(pick("iterations")),
    asInt(pick("tool_calls")),
    asInt(pick("tool_errors")),
    messageCount,
    asInt(pick("prompt_tokens")),
    asInt(pick("completion_tokens")),
    asInt(pick("cached_tokens")),
    asInt(pick("total_tokens")),
    asInt(pick("duration_ms")),
    String(pick("status", "idle")),
    String(pick("error", "")),
    asInt(pick("started")),
    now(),
  );
}
function syncEnvAudit() {
  const keys = [
    "ZC_WORKSPACE",
    "DATA_DIR",
    "ZC_PROJECTS_DIR",
    "IEZ_BASE_URL",
    "IEZ_API_KEY",
    "IEZ_MODELS",
    "IEZ_MCP_URL",
    "IEZ_MCP_ENABLED",
    "NVIDIA_BASE_URL",
    "NVIDIA_API_KEY",
    "NVIDIA_MODELS",
    "ADMIN_TOKEN_ENABLED",
    "ADMIN_TOKEN",
  ];
  const source = ENV_FILES.join(",") || "process-environment";
  for (const key of keys) {
    const raw = process.env[key];
    if (raw === undefined) continue;
    const secret = /(API_KEY|_KEY|_TOKEN|_SECRET|_PASSWORD)$/i.test(key) && !/_ENABLED$/i.test(key);
    const value = secret ? (raw ? "set" : "") : String(raw);
    sqlRun(
      `INSERT INTO env_import (key, value, secret, source, updated) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret,
         source = excluded.source, updated = excluded.updated`,
      key,
      value,
      secret ? 1 : 0,
      source,
      now(),
    );
  }
  logEvent("INFO", "env_synced", {
    files: ENV_FILES,
    entries: sqlGet("SELECT COUNT(*) AS n FROM env_import").n,
  });
}
syncEnvAudit();
function reconcileSessionMetrics() {
  sqlRun(
    `UPDATE sessions SET
       provider = COALESCE((SELECT sm.provider FROM session_metrics sm
         WHERE sm.conversation_id = sessions.id AND sm.status = 'completed'), provider),
       model = COALESCE((SELECT sm.model FROM session_metrics sm
         WHERE sm.conversation_id = sessions.id AND sm.status = 'completed'), model)
     WHERE EXISTS (SELECT 1 FROM session_metrics sm
       WHERE sm.conversation_id = sessions.id AND sm.status = 'completed')`,
  );
}
reconcileSessionMetrics();

// ═════════════════════════════════════════════════════════════
// Seed
// ═════════════════════════════════════════════════════════════
const DEFAULT_SYSTEM_PROMPT = `You are ${SYSTEM_IDENTITY.name} ${SYSTEM_IDENTITY.version}, ${SYSTEM_IDENTITY.tagline}.
You are a coding agent owned by ${SYSTEM_IDENTITY.branding.owner} (${SYSTEM_IDENTITY.branding.organization}).
Work inside the active project only. Inspect before changing. Prefer the smallest correct change.
Use the provided tools instead of guessing about files, commands or network state.
When a tool fails, read the error and adapt; never claim success without evidence.
In plan mode, only use read-only tools. In build mode, write only when the user asked for a change.
Keep replies concise and factual. Never fabricate a command output, file content or provider result.
If asked who you are, identify yourself as ${SYSTEM_IDENTITY.name} ${SYSTEM_IDENTITY.version}.`;

const TOOL_SEED = [
  {
    name: "server_info",
    description: "Runtime identity, project root, storage backend and enabled tools.",
    readOnly: true,
    params: {},
    required: [],
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file inside the project.",
    readOnly: true,
    params: {
      path: { type: "string", description: "file path" },
      start: { type: "number", description: "optional first line, 1-based" },
      end: { type: "number", description: "optional last line" },
    },
    required: ["path"],
  },
  {
    name: "list_files",
    description: "List one directory inside the project.",
    readOnly: true,
    params: { path: { type: "string", description: "directory path, default /" } },
    required: [],
  },
  {
    name: "grep",
    description: "Search file contents inside the project.",
    readOnly: true,
    params: {
      pattern: { type: "string", description: "literal text or regular expression" },
      path: { type: "string", description: "optional directory" },
    },
    required: ["pattern"],
  },
  {
    name: "glob",
    description: "Find paths by glob pattern relative to the project root.",
    readOnly: true,
    params: { pattern: { type: "string", description: "example: **/*.js" } },
    required: ["pattern"],
  },
  {
    name: "write_file",
    description: "Create or replace a file inside the project. Records a snapshot.",
    readOnly: false,
    params: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  {
    name: "edit_file",
    description: "Replace one unique old_string with new_string in a file.",
    readOnly: false,
    params: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
    },
    required: ["path", "old_string", "new_string"],
  },
  {
    name: "replace_in_file",
    description: "Replace every exact occurrence of old_string in a file.",
    readOnly: false,
    params: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
    },
    required: ["path", "old_string", "new_string"],
  },
  {
    name: "bash",
    description: "Run a shell command with the project root as working directory.",
    readOnly: false,
    params: { command: { type: "string" } },
    required: ["command"],
  },
];

function ensureTool(def) {
  const id = "tool_" + def.name;
  const existing = sqlGet("SELECT id FROM tools WHERE name = ?", def.name);
  if (existing) return;
  const schema = {
    type: "object",
    properties: def.params || {},
    required: def.required || [],
  };
  sqlRun(
    `INSERT INTO tools
      (id, name, external_name, description, schema_json, source, mcp_server_id, enabled, read_only, created, updated)
     VALUES (?, ?, '', ?, ?, 'builtin', NULL, ?, ?, ?, ?)`,
    id,
    def.name,
    def.description,
    JSON.stringify(schema),
    def.readOnly ? 1 : 0,
    def.readOnly ? 1 : 0,
    now(),
    now(),
  );
}

for (const def of TOOL_SEED) ensureTool(def);

function ensureProject(project) {
  const existing = sqlGet("SELECT id FROM projects WHERE id = ?", project.id);
  if (existing) return;
  sqlRun(
    "INSERT INTO projects (id, name, path, type, insid, closed, created, updated) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
    project.id,
    project.name,
    project.path,
    project.type || "custom",
    project.insid || "",
    now(),
    now(),
  );
}

ensureProject({
  id: "proj_workspace",
  name: path.basename(WORKSPACE) || "Workspace",
  path: WORKSPACE,
  type: "custom",
});
if (!getSetting("active_project", null)) setSetting("active_project", "proj_workspace");

function ensurePrompt() {
  const active = sqlGet("SELECT id FROM system_prompts WHERE active = 1 LIMIT 1");
  if (active) return;
  const existing = sqlGet("SELECT id FROM system_prompts ORDER BY updated DESC LIMIT 1");
  if (existing) {
    sqlRun("UPDATE system_prompts SET active = 1 WHERE id = ?", existing.id);
    return;
  }
  const id = randomId("prompt_");
  sqlRun(
    "INSERT INTO system_prompts (id, name, content, active, created, updated) VALUES (?, ?, ?, 1, ?, ?)",
    id,
    "Default runtime prompt",
    DEFAULT_SYSTEM_PROMPT,
    now(),
    now(),
  );
  setSetting("active_prompt_id", id);
}
ensurePrompt();

function identityMetadata() {
  const env = readEnvFile(ZOMBIE_ENV);
  return {
    ...SYSTEM_IDENTITY,
    source: "runtime-env",
    app_url: env.APP_URL || "",
    main_host: env.MAIN_HOST || "",
    server_type: env.SERVER_TYPE || "",
    imported_at: new Date().toISOString(),
  };
}
function ensureIdentity() {
  const metadata = identityMetadata();
  const existing = sqlGet("SELECT id FROM identities ORDER BY updated DESC LIMIT 1");
  if (existing) {
    const row = sqlGet("SELECT metadata FROM identities WHERE id = ?", existing.id);
    const current = parseJson(row ? row.metadata : "{}", {});
    if (!current.branding || !current.contact || !current.version) {
      sqlRun(
        "UPDATE identities SET metadata = ?, updated = ? WHERE id = ?",
        JSON.stringify({ ...metadata, ...current, branding: current.branding || metadata.branding,
          contact: current.contact || metadata.contact, version: current.version || metadata.version }),
        now(),
        existing.id,
      );
    }
    return;
  }
  sqlRun(
    "INSERT INTO identities (id, name, owner, source, metadata, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
    "identity_default",
    SYSTEM_IDENTITY.name,
    SYSTEM_IDENTITY.branding.owner,
    metadata.source,
    JSON.stringify(metadata),
    now(),
    now(),
  );
}
ensureIdentity();
function identityPayload() {
  const row = activeIdentity();
  if (!row) {
    return {
      id: "identity_default",
      ...SYSTEM_IDENTITY,
      owner: SYSTEM_IDENTITY.branding.owner,
      source: "local-default",
      metadata: SYSTEM_IDENTITY,
    };
  }
  const metadata = parseJson(row.metadata, {});
  return {
    id: row.id,
    name: row.name || SYSTEM_IDENTITY.name,
    owner: row.owner || SYSTEM_IDENTITY.branding.owner,
    source: row.source,
    metadata,
    version: metadata.version || SYSTEM_IDENTITY.version,
    tagline: metadata.tagline || SYSTEM_IDENTITY.tagline,
    powered_by_header: metadata.powered_by_header || SYSTEM_IDENTITY.powered_by_header,
    branding: { ...SYSTEM_IDENTITY.branding, ...(metadata.branding || {}) },
    contact: { ...SYSTEM_IDENTITY.contact, ...(metadata.contact || {}) },
  };
}

function ensureProvider(provider) {
  if (sqlGet("SELECT id FROM providers WHERE id = ?", provider.id)) return;
  sqlRun(
    `INSERT INTO providers
      (id, name, kind, base_url, api_key, models_json, connected, default_model, no_key,
       supports_tools, is_custom_type, last_test_ok, last_test_at, last_error, created, updated)
     VALUES (?, ?, 'openai', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '', ?, ?)`,
    provider.id,
    provider.name,
    provider.base_url || "",
    provider.api_key || "",
    JSON.stringify(provider.models || {}),
    provider.connected ? 1 : 0,
    provider.default_model || "",
    provider.no_key ? 1 : 0,
    provider.supports_tools === false ? 0 : 1,
    String(provider.id).startsWith("custom:") ? 1 : 0,
    now(),
    now(),
  );
}

function syncProviderFromEnv(spec) {
  const existing = providerRow(spec.id);
  if (!existing) {
    ensureProvider(spec);
    return;
  }
  const currentModels = parseJson(existing.models_json, {});
  const models = { ...currentModels, ...(spec.models || {}) };
  const apiKey = spec.api_key ? String(spec.api_key) : existing.api_key;
  const defaultModel = spec.default_model || existing.default_model || Object.keys(models)[0] || "";
  sqlRun(
    `UPDATE providers SET name = ?, base_url = ?, api_key = ?, models_json = ?, connected = ?,
       default_model = ?, no_key = ?, supports_tools = ?, is_custom_type = ?, updated = ? WHERE id = ?`,
    spec.name || existing.name,
    spec.base_url || existing.base_url,
    apiKey,
    JSON.stringify(models),
    spec.connected === false ? 0 : spec.connected || existing.connected ? 1 : 0,
    defaultModel,
    spec.no_key == null ? existing.no_key : spec.no_key ? 1 : 0,
    spec.supports_tools == null ? existing.supports_tools : spec.supports_tools ? 1 : 0,
    String(spec.id).startsWith("custom:") ? 1 : 0,
    now(),
    spec.id,
  );
}

function seedProviders() {
  const env = { ...readEnvFile(ZOMBIE_ENV), ...process.env };
  const cacheDir = path.join(WORKSPACE, ".softaculous", "ai", "provider");
  const opencodeCache = readPhpJson(path.join(cacheDir, "opencode_zen.json.php"));
  const opencodePremiumCache = readPhpJson(path.join(cacheDir, "opencode_zen_premium.json.php"));
  const ollamaModels = modelsFromList(env.OLLAMA_MODELS || "lfm3:1.7b,deepseek-r1:1.5b,qwen2.5:1.5b");
  for (const id of Object.keys(ollamaModels)) {
    if (!ollamaModels[id].context_window) ollamaModels[id].context_window = 32768;
  }

  ensureProvider({
    id: "ollama",
    name: "Ollama (local)",
    base_url: env.OLLAMA_BASE || "http://127.0.0.1:11434/v1",
    api_key: env.OLLAMA_API_KEY || "",
    models: ollamaModels,
    connected: true,
    default_model: (env.OLLAMA_MODELS || "qwen2.5:1.5b").split(",")[0].trim(),
    no_key: true,
  });

  if (env.OPENCODE_BASE || env.OPENCODE_API_KEY || opencodeCache) {
    const models =
      (opencodeCache && opencodeCache.models) ||
      modelsFromList(env.OPENCODE_MODELS || "", 128000);
    ensureProvider({
      id: "opencode_zen",
      name: "OpenCode Zen",
      base_url: env.OPENCODE_BASE || "https://opencode.ai/inference/openai/v1",
      api_key: env.OPENCODE_API_KEY || "",
      models,
      connected: !!(env.OPENCODE_API_KEY || opencodeCache),
      default_model: Object.keys(models)[0] || "",
      no_key: false,
    });
  }
  if (env.OPENCODE_API_KEY && opencodePremiumCache) {
    ensureProvider({
      id: "opencode_zen_premium",
      name: "OpenCode Zen Premium",
      base_url: env.OPENCODE_BASE || "https://opencode.ai/inference/openai/v1",
      api_key: env.OPENCODE_API_KEY,
      models: opencodePremiumCache.models || {},
      connected: true,
      default_model: Object.keys(opencodePremiumCache.models || {})[0] || "",
      no_key: false,
    });
  }
  if (env.GROQ_BASE || env.GROQ_API_KEY) {
    const models = modelsFromList(env.GROQ_MODELS || "openai/gpt-oss-20b,openai/gpt-oss-120b", 131072);
    ensureProvider({
      id: "groq",
      name: "Groq",
      base_url: env.GROQ_BASE || "https://api.groq.com/openai/v1",
      api_key: env.GROQ_API_KEY || "",
      models,
      connected: !!env.GROQ_API_KEY,
      default_model: Object.keys(models)[0] || "",
      no_key: false,
    });
  }
  if (env.GEMINI_API_KEY) {
    const models = modelsFromList(env.GEMINI_MODELS || "gemini-3.5-flash", 1048576);
    ensureProvider({
      id: "gemini",
      name: "Google Gemini",
      base_url: String(env.GEMINI_BASE || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "") + "/openai",
      api_key: env.GEMINI_API_KEY,
      models,
      connected: true,
      default_model: Object.keys(models)[0] || "",
      no_key: false,
    });
  }
  for (let i = 1; i <= 4; i++) {
    const prefix = `CUSTOM_PROVIDER_${i}`;
    if (!env[prefix + "_URL"]) continue;
    const id = "custom:" + String(env[prefix + "_NAME"] || "provider-" + i)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const models = modelsFromList(env[prefix + "_MODELS"] || "", 32768);
    syncProviderFromEnv({
      id,
      name: env[prefix + "_NAME"] || "Custom Provider " + i,
      base_url: env[prefix + "_URL"],
      api_key: env[prefix + "_KEY"] || "",
      models,
      connected: env[prefix + "_ENABLED"] === "true" && !!env[prefix + "_KEY"],
      default_model: Object.keys(models)[0] || "",
      no_key: false,
    });
  }

  const iezBase = env.IEZ_BASE_URL || env.INFINITE_EARNING_BASE || "https://api.infiniteearningzone.com/v1";
  const iezKey = env.IEZ_API_KEY || "";
  const iezModels = modelsFromList(
    env.IEZ_MODELS ||
      "mission,code-guru,bug-hunter,security-hero,perf-wizard,doc-king,qa-tyrant,team-heart,customer-experience-specialist,ecommerce-operations-analyst",
    32768,
  );
  syncProviderFromEnv({
    id: "infinite",
    name: "InfiniteEarningZone",
    base_url: iezBase,
    api_key: iezKey,
    models: iezModels,
    connected: true,
    default_model: env.IEZ_DEFAULT_MODEL || "mission",
    no_key: !iezKey,
    supports_tools: false,
  });

  if (env.NVIDIA_API_KEY) {
    const nvidiaModels = modelsFromList(
      env.NVIDIA_MODELS ||
        "meta/muse-glimmer-30b,minimaxai/minimax-m3.1-flash,z-ai/glm-5.3-flash,nvidia/nemotron-3.5-bolt-e4b,nvidia/nemotron-3.5-lightning-30b-a3b",
      131072,
    );
    syncProviderFromEnv({
      id: "custom:nvidia",
      name: "NVIDIA API Catalog",
      base_url: env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
      api_key: env.NVIDIA_API_KEY,
      models: nvidiaModels,
      connected: true,
      default_model: env.NVIDIA_DEFAULT_MODEL || "meta/muse-glimmer-30b",
      no_key: false,
    });
  }

  const placeholders = [
    ["openai", "OpenAI", "https://api.openai.com/v1"],
    ["deepseek", "DeepSeek", "https://api.deepseek.com/v1"],
    ["openrouter", "OpenRouter", "https://openrouter.ai/api/v1"],
    ["together", "Together AI", "https://api.together.xyz/v1"],
    ["minimax", "MiniMax", "https://api.minimax.io/v1"],
    ["mistral", "Mistral", "https://api.mistral.ai/v1"],
  ];
  for (const [id, name, base] of placeholders) {
    ensureProvider({ id, name, base_url: base, models: {}, connected: false, no_key: false });
  }
}
seedProviders();

function syncMcpFromEnv() {
  const url = String(process.env.IEZ_MCP_URL || "").trim();
  if (!url) return null;
  const existing = sqlGet("SELECT * FROM mcp_servers WHERE url = ? LIMIT 1", url);
  if (existing) return existing.id;
  const row = addMcp({
    name: process.env.IEZ_MCP_NAME || "InfiniteEarningZone MCP",
    url,
    transport: "http",
    auth_type: process.env.IEZ_MCP_AUTH_TYPE || "none",
    auth_header: process.env.IEZ_MCP_AUTH_HEADER || "Authorization",
    auth_value: process.env.IEZ_MCP_TOKEN || "",
    enabled: /^(1|true|yes|on)$/i.test(String(process.env.IEZ_MCP_ENABLED || "false")),
  });
  return row.id;
}
const ENV_MCP_ID = syncMcpFromEnv();

function activeIdentity() {
  return sqlGet("SELECT * FROM identities ORDER BY updated DESC LIMIT 1") || null;
}
function activePrompt() {
  return (
    sqlGet("SELECT * FROM system_prompts WHERE active = 1 ORDER BY updated DESC LIMIT 1") ||
    sqlGet("SELECT * FROM system_prompts ORDER BY updated DESC LIMIT 1") ||
    { name: "Default", content: DEFAULT_SYSTEM_PROMPT }
  );
}
function activeProject() {
  const id = getSetting("active_project", null);
  let row = id ? sqlGet("SELECT * FROM projects WHERE id = ? AND closed = 0", id) : null;
  if (!row) row = sqlGet("SELECT * FROM projects WHERE closed = 0 ORDER BY created ASC LIMIT 1");
  return row || null;
}
function projectRoot() {
  const p = activeProject();
  return p ? p.path : WORKSPACE;
}
function projectContexts(projectId) {
  const out = { bootstrap: "", state: "", memory: "" };
  if (!projectId) return out;
  for (const row of sqlAll("SELECT kind, content FROM project_contexts WHERE project_id = ?", projectId)) {
    if (row.kind in out) out[row.kind] = row.content;
  }
  return out;
}

function requestProjectId(url, body) {
  const fromQuery = url.searchParams.get("project_id");
  const fromBody = body && body.project_id;
  const id = String(fromQuery || fromBody || "").trim();
  if (!id) return null;
  const row = sqlGet("SELECT id FROM projects WHERE id = ? AND closed = 0", id);
  if (row) {
    setSetting("active_project", id);
    const current = getSetting("active_conversation", null);
    if (current) {
      const session = sqlGet("SELECT project_id FROM sessions WHERE id = ?", current);
      if (!session || session.project_id !== id) setSetting("active_conversation", null);
    }
    return id;
  }
  return null;
}

// ═════════════════════════════════════════════════════════════
// Providers
// ═════════════════════════════════════════════════════════════
function providerRow(id) {
  return sqlGet("SELECT * FROM providers WHERE id = ?", id) || null;
}
function providerApi(row) {
  const models = parseJson(row.models_json, {});
  return {
    id: row.id,
    name: row.name,
    connected: !!row.connected,
    models,
    base_url: row.base_url,
    default_model: row.default_model || "",
    no_key: !!row.no_key,
    supports_tools: row.supports_tools !== 0,
    is_custom_type: !!row.is_custom_type,
    last_test_ok: row.last_test_ok == null ? null : !!row.last_test_ok,
    last_test_at: row.last_test_at,
    last_error: row.last_error || "",
  };
}
function providerMasked(row) {
  const api = providerApi(row);
  return {
    ...api,
    api_key: row.api_key ? "***" : "",
    has_key: !!row.api_key,
  };
}
function providerList() {
  return sqlAll("SELECT * FROM providers ORDER BY CASE WHEN id = 'ollama' THEN 0 ELSE 1 END, is_custom_type ASC, name ASC").map(providerApi);
}
function providerHeaders(row, extra = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "zc-runtime/" + VERSION,
    ...brandingHeaders(),
    ...extra,
  };
  if (row.api_key) headers.Authorization = "Bearer " + row.api_key;
  if (row.id === "openrouter") {
    headers["HTTP-Referer"] = "http://127.0.0.1:" + PORT + "/admin";
    headers["X-Title"] = "ZC Runtime";
  }
  return headers;
}
function identityHeaders(session, conversationId) {
  const identity = identityPayload();
  const project = activeProject();
  const encoded = Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
  return {
    ...brandingHeaders(),
    "X-ZC-Identity": encoded,
    "X-ZC-Identity-Format": "base64url-json",
    "X-ZC-Project": project ? project.id : "",
    "X-ZC-Session": session ? session.id : "",
    "X-ZC-Conversation": conversationId || "",
  };
}

async function fetchProviderModels(row, timeoutMs = 8000) {
  if (!row.base_url) throw new Error("provider base URL is empty");
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = providerHeaders(row);
  const url = joinUrl(row.base_url, "models");
  let res;
  try {
    res = await fetch(url, { method: "GET", headers, signal });
  } catch (error) {
    if (String(row.base_url).includes("11434")) {
      const tags = await fetch(
        joinUrl(String(row.base_url).replace(/\/v1\/?$/, ""), "api/tags"),
        { headers: { Accept: "application/json" }, signal },
      );
      if (!tags.ok) throw error;
      const json = await tags.json();
      const out = {};
      for (const item of json.models || []) {
        out[item.name] = { name: item.name, context_window: 32768 };
      }
      return out;
    }
    throw error;
  }
  if (!res.ok) {
    const body = clampText(await res.text(), 500);
    throw new Error("models endpoint returned " + res.status + ": " + body);
  }
  const json = await res.json();
  const out = {};
  const data = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
  for (const item of data) {
    if (!item) continue;
    const id = item.id || item.name || item.model;
    if (!id) continue;
    out[id] = {
      name: item.name || item.display_name || id,
      context_window: item.context_window || item.context_length || 32768,
    };
  }
  return out;
}

async function providerChat(row, body, signal) {
  if (!row.base_url) throw new Error("provider base URL is empty");
  const url = joinUrl(row.base_url, "chat/completions");
  const messages = body.messages || [];
  const session = body.session || null;
  const headers = providerHeaders(row, identityHeaders(session, body.conversation_id));
  const payload = {
    model: body.model,
    messages,
    temperature: body.temperature == null ? 0.2 : body.temperature,
    stream: false,
  };
  if (body.tools && body.tools.length) {
    payload.tools = body.tools;
    payload.tool_choice = "auto";
  }
  if (body.max_tokens) payload.max_tokens = body.max_tokens;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error("provider returned " + res.status + ": " + clampText(text, 1200));
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("provider returned non-JSON: " + clampText(text, 500));
  }
  let message = json.choices && json.choices[0] && json.choices[0].message;
  if (!message && json.message) {
    message = { role: "assistant", content: json.message.content, tool_calls: json.message.tool_calls };
  }
  if (!message) {
    throw new Error("provider returned no assistant message");
  }
  if (Array.isArray(message.content)) {
    message.content = message.content
      .map((part) => (typeof part === "string" ? part : part.text || ""))
      .join("");
  }
  return { message, usage: json.usage || {}, raw: json };
}

async function testProvider(row, modelHint) {
  let models = {};
  let error = "";
  try {
    models = await fetchProviderModels(row);
  } catch (e) {
    error = compactError(e);
  }
  const existingModels = parseJson(row.models_json, {});
  const merged = Object.keys(models).length ? models : existingModels;
  let ok = Object.keys(models).length > 0;
  const model = modelHint || row.default_model || Object.keys(merged)[0] || "";
  if (!ok && model) {
    try {
      await providerChat(
        { ...row, models_json: JSON.stringify(merged) },
        {
          model,
          messages: [{ role: "user", content: "Reply with the single word: ok" }],
          max_tokens: 4,
        },
        AbortSignal.timeout(15000),
      );
      ok = true;
      error = "";
    } catch (e) {
      error = compactError(e);
    }
  }
  const connected = ok || !!row.connected;
  sqlRun(
    "UPDATE providers SET models_json = ?, connected = ?, last_test_ok = ?, last_test_at = ?, last_error = ?, updated = ? WHERE id = ?",
    JSON.stringify(merged),
    connected ? 1 : 0,
    ok ? 1 : 0,
    now(),
    ok ? "" : error,
    now(),
    row.id,
  );
  logEvent("INFO", "provider_test", { provider: row.id, ok, models: Object.keys(merged).length });
  return { ok, models: merged, error, default_model: model };
}

function saveProvider(input) {
  const id = String(input.provider_id || input.id || "").trim();
  if (!id) {
    const err = new Error("provider_id is required");
    err.status = 400;
    throw err;
  }
  const existing = providerRow(id);
  const custom = id.startsWith("custom:") || id === "custom";
  const name = clampText(input.name || (existing && existing.name) || id, 120);
  const baseUrl = clampText(input.base_url || (existing && existing.base_url) || "", 500);
  if (custom && !baseUrl) {
    const err = new Error("custom providers require a base_url");
    err.status = 400;
    throw err;
  }
  let apiKey = input.api_key == null ? (existing ? existing.api_key : "") : String(input.api_key);
  if (input.clear_key) apiKey = "";
  let models = input.models == null ? (existing ? existing.models_json : "{}") : input.models;
  if (typeof models === "string") {
    const parsed = parseJson(models, null);
    models = parsed && typeof parsed === "object" ? parsed : modelsFromList(models);
  }
  if (Array.isArray(models)) models = modelsFromList(models);
  const modelJson = JSON.stringify(models || {});
  const defaultModel = clampText(
    input.default_model || (existing && existing.default_model) || Object.keys(parseJson(modelJson, {}))[0] || "",
    200,
  );
  const connected =
    input.connected == null
      ? (existing ? !!existing.connected : false) || !!apiKey || !!input.no_key
      : !!input.connected;
  const supportsTools =
    input.supports_tools == null
      ? (existing ? existing.supports_tools : 1)
      : /^(0|false|no|off)$/i.test(String(input.supports_tools))
        ? 0
        : 1;
  if (existing) {
    sqlRun(
      `UPDATE providers SET name = ?, base_url = ?, api_key = ?, models_json = ?, connected = ?,
        default_model = ?, no_key = ?, supports_tools = ?, is_custom_type = ?, updated = ? WHERE id = ?`,
      name,
      baseUrl,
      apiKey,
      modelJson,
      connected ? 1 : 0,
      defaultModel,
      input.no_key == null ? existing.no_key : input.no_key ? 1 : 0,
      supportsTools,
      custom ? 1 : 0,
      now(),
      id,
    );
  } else {
    sqlRun(
      `INSERT INTO providers
        (id, name, kind, base_url, api_key, models_json, connected, default_model, no_key,
         supports_tools, is_custom_type, last_test_ok, last_test_at, last_error, created, updated)
       VALUES (?, ?, 'openai', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '', ?, ?)`,
      id,
      name,
      baseUrl,
      apiKey,
      modelJson,
      connected ? 1 : 0,
      defaultModel,
      input.no_key ? 1 : 0,
      supportsTools,
      custom ? 1 : 0,
      now(),
      now(),
    );
  }
  logEvent("INFO", "provider_saved", { provider: id });
  return providerApi(providerRow(id));
}

function deleteProvider(id) {
  const row = providerRow(id);
  if (!row) return false;
  sqlRun("DELETE FROM providers WHERE id = ?", id);
  logEvent("INFO", "provider_deleted", { provider: id });
  return true;
}

// ═════════════════════════════════════════════════════════════
// MCP
// ═════════════════════════════════════════════════════════════
function mcpRow(id) {
  return sqlGet("SELECT * FROM mcp_servers WHERE id = ?", id) || null;
}
function mcpMasked(row) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    transport: row.transport,
    auth_type: row.auth_type,
    auth_header: row.auth_header,
    auth_value: row.auth_value ? "***" : "",
    has_auth: !!row.auth_value,
    headers: parseJson(row.headers_json, {}),
    enabled: !!row.enabled,
    status: row.status,
    last_error: row.last_error,
    tools: parseJson(row.tools_json, []),
    protocol_version: row.protocol_version,
    session_id: row.session_id,
    created: row.created,
    updated: row.updated,
  };
}
function mcpList() {
  return sqlAll("SELECT * FROM mcp_servers ORDER BY name ASC").map(mcpMasked);
}
function mcpHeaders(row, extra = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...parseJson(row.headers_json, {}),
    ...extra,
  };
  if (row.auth_type === "bearer" && row.auth_value) {
    headers.Authorization = "Bearer " + row.auth_value;
  } else if (row.auth_type === "header" && row.auth_value) {
    headers[row.auth_header || "Authorization"] = row.auth_value;
  }
  return headers;
}
function mcpSession(serverId, conversationId) {
  const row = sqlGet(
    "SELECT * FROM mcp_sessions WHERE server_id = ? AND conversation_id = ?",
    serverId,
    conversationId || "",
  );
  return row ? row.session_id : "";
}
function saveMcpSession(serverId, conversationId, sessionId, protocolVersion) {
  if (!sessionId) return;
  sqlRun(
    `INSERT INTO mcp_sessions (id, server_id, conversation_id, session_id, protocol_version, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id, conversation_id) DO UPDATE SET
       session_id = excluded.session_id,
       protocol_version = excluded.protocol_version,
       updated = excluded.updated`,
    randomId("mcps_"),
    serverId,
    conversationId || "",
    sessionId,
    protocolVersion || "",
    now(),
    now(),
  );
  sqlRun("UPDATE mcp_servers SET session_id = ? WHERE id = ?", sessionId, serverId);
}
function parseMcpResponse(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const candidates = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      if (data && data !== "[DONE]") candidates.push(data);
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(candidates[i]);
    } catch {
      /* try an earlier event */
    }
  }
  throw new Error("MCP response was not JSON or SSE JSON: " + clampText(trimmed, 300));
}
async function mcpRpc(row, method, params, options = {}) {
  const conversationId = options.conversationId || "";
  const headers = mcpHeaders(row);
  const sessionId = mcpSession(row.id, conversationId);
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (options.protocolVersion) headers["MCP-Protocol-Version"] = options.protocolVersion;
  const rpc = { jsonrpc: "2.0", method, params };
  if (options.id !== null && options.id !== undefined) rpc.id = options.id;
  const res = await fetch(row.url, {
    method: "POST",
    headers,
    body: JSON.stringify(rpc),
    signal: AbortSignal.timeout(options.timeoutMs || 15000),
  });
  const newSession = res.headers.get("mcp-session-id");
  if (newSession) saveMcpSession(row.id, conversationId, newSession, options.protocolVersion || "");
  const text = await res.text();
  if (!res.ok) throw new Error("MCP returned " + res.status + ": " + clampText(text, 500));
  const json = parseMcpResponse(text);
  if (json && json.error) throw new Error("MCP error " + json.error.code + ": " + json.error.message);
  return (json && json.result) || json;
}
async function mcpInitialize(row, conversationId) {
  const result = await mcpRpc(
    row,
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "zc-runtime", version: VERSION },
    },
    { conversationId, id: 1 },
  );
  const version = (result && result.protocolVersion) || "2025-06-18";
  try {
    await mcpRpc(row, "notifications/initialized", {}, { conversationId, id: null, protocolVersion: version });
  } catch {
    /* some servers do not answer notifications; initialize already proved the endpoint */
  }
  return { result, version };
}
function mcpToolPublicName(serverId, toolName) {
  const server = serverId.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 24);
  const tool = String(toolName).replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 48);
  return `mcp__${server}__${tool}`;
}
function syncMcpTools(server, tools) {
  const keep = new Set();
  for (const tool of tools || []) {
    const external = String(tool.name || "").trim();
    if (!external) continue;
    const publicName = mcpToolPublicName(server.id, external);
    keep.add(publicName);
    const schema = tool.inputSchema || { type: "object", properties: {} };
    const existing = sqlGet("SELECT * FROM tools WHERE name = ?", publicName);
    const readOnly = !!(tool.annotations && tool.annotations.readOnlyHint);
    if (existing) {
      sqlRun(
        "UPDATE tools SET external_name = ?, description = ?, schema_json = ?, read_only = ?, updated = ? WHERE id = ?",
        external,
        clampText(tool.description || "", 500),
        JSON.stringify(schema),
        readOnly ? 1 : 0,
        now(),
        existing.id,
      );
    } else {
      sqlRun(
        `INSERT INTO tools
          (id, name, external_name, description, schema_json, source, mcp_server_id, enabled, read_only, created, updated)
         VALUES (?, ?, ?, ?, ?, 'mcp', ?, ?, ?, ?, ?)`,
        randomId("tool_"),
        publicName,
        external,
        clampText(tool.description || "", 500),
        JSON.stringify(schema),
        server.id,
        server.enabled ? 1 : 0,
        readOnly ? 1 : 0,
        now(),
        now(),
      );
    }
  }
  for (const row of sqlAll("SELECT id, name FROM tools WHERE source = 'mcp' AND mcp_server_id = ?", server.id)) {
    if (!keep.has(row.name)) sqlRun("DELETE FROM tools WHERE id = ?", row.id);
  }
}
async function connectMcp(row, conversationId = "") {
  try {
    const init = await mcpInitialize(row, conversationId);
    const listed = await mcpRpc(row, "tools/list", {}, {
      conversationId,
      id: 2,
      protocolVersion: init.version,
    });
    const tools = (listed && listed.tools) || [];
    sqlRun(
      "UPDATE mcp_servers SET status = 'connected', last_error = '', tools_json = ?, protocol_version = ?, updated = ? WHERE id = ?",
      JSON.stringify(tools),
      init.version,
      now(),
      row.id,
    );
    syncMcpTools(row, tools);
    logEvent("INFO", "mcp_connected", { mcp: row.id, tools: tools.length, protocol: init.version });
    return { ok: true, tools, protocol: init.version };
  } catch (error) {
    const message = compactError(error);
    sqlRun(
      "UPDATE mcp_servers SET status = 'error', last_error = ?, updated = ? WHERE id = ?",
      message,
      now(),
      row.id,
    );
    logEvent("ERROR", "mcp_connect_failed", { mcp: row.id, error: message });
    return { ok: false, error: message, tools: [] };
  }
}
function addMcp(input) {
  const name = clampText(input.name || "", 120).trim();
  const url = clampText(input.url || "", 800).trim();
  if (!name || !url) {
    const err = new Error("MCP server requires name and url");
    err.status = 400;
    throw err;
  }
  const id = randomId("mcp_");
  sqlRun(
    `INSERT INTO mcp_servers
      (id, name, url, transport, auth_type, auth_header, auth_value, headers_json, enabled, status, last_error,
       tools_json, protocol_version, session_id, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', '', '[]', '', '', ?, ?)`,
    id,
    name,
    url,
    input.transport || "http",
    input.auth_type || "none",
    input.auth_header || "Authorization",
    input.auth_value || input.token || "",
    JSON.stringify(input.headers || {}),
    input.enabled ? 1 : 0,
    now(),
    now(),
  );
  logEvent("INFO", "mcp_added", { mcp: id, name });
  return mcpRow(id);
}
function updateMcp(id, input) {
  const row = mcpRow(id);
  if (!row) return null;
  sqlRun(
    `UPDATE mcp_servers SET name = ?, url = ?, auth_type = ?, auth_header = ?, auth_value = ?,
      headers_json = ?, enabled = ?, updated = ? WHERE id = ?`,
    clampText(input.name || row.name, 120),
    clampText(input.url || row.url, 800),
    input.auth_type || row.auth_type,
    input.auth_header || row.auth_header,
    input.auth_value == null ? row.auth_value : String(input.auth_value),
    JSON.stringify(input.headers == null ? parseJson(row.headers_json, {}) : input.headers),
    input.enabled == null ? row.enabled : input.enabled ? 1 : 0,
    now(),
    id,
  );
  return mcpRow(id);
}
function deleteMcp(id) {
  const row = mcpRow(id);
  if (!row) return false;
  sqlRun("DELETE FROM tools WHERE source = 'mcp' AND mcp_server_id = ?", id);
  sqlRun("DELETE FROM mcp_sessions WHERE server_id = ?", id);
  sqlRun("DELETE FROM mcp_servers WHERE id = ?", id);
  logEvent("INFO", "mcp_deleted", { mcp: id });
  return true;
}
async function callMcpTool(row, externalName, args, conversationId) {
  let init;
  try {
    const existing = mcpSession(row.id, conversationId);
    if (existing && row.status === "connected" && row.protocol_version) {
      init = { version: row.protocol_version };
    } else {
      init = await mcpInitialize(row, conversationId);
    }
  } catch (error) {
    return { ok: false, error: "MCP initialize failed: " + compactError(error), output: "" };
  }
  try {
    const result = await mcpRpc(
      row,
      "tools/call",
      { name: externalName, arguments: args || {} },
      { conversationId, id: 3, protocolVersion: init.version },
    );
    const content = (result && result.content) || [];
    const text = content
      .map((part) => (part && part.type === "text" ? part.text : JSON.stringify(part)))
      .join("\n");
    return {
      ok: !(result && result.isError),
      output: text || JSON.stringify(result || {}),
      is_error: !!(result && result.isError),
    };
  } catch (error) {
    return { ok: false, error: compactError(error), output: "Error: " + compactError(error), is_error: true };
  }
}

// ═════════════════════════════════════════════════════════════
// Conversations and messages
// ═════════════════════════════════════════════════════════════
function conversationRow(id) {
  return sqlGet("SELECT * FROM conversations WHERE id = ?", id) || null;
}
function sessionRow(id) {
  return sqlGet("SELECT * FROM sessions WHERE id = ?", id) || null;
}
function createConversation(options = {}) {
  const project = options.project || activeProject();
  if (!project) throw new Error("no active project");
  const id = randomId("conv_");
  const provider =
    options.provider || (sessionRow(getSetting("active_conversation", "")) || {}).provider || getSetting("provider", "") || "";
  const model = options.model || getSetting("model", "") || "";
  const mode = options.mode || getSetting("mode", "build") || "build";
  const title = clampText(options.title || "New Session", 200);
  const ts = now();
  sqlRun(
    "INSERT INTO conversations (id, session_id, title, provider, model, mode, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    id,
    title,
    provider,
    model,
    mode,
    ts,
    ts,
  );
  sqlRun(
    "INSERT INTO sessions (id, conversation_id, project_id, provider, model, mode, title, running, last_status, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'idle', ?, ?)",
    id,
    id,
    project.id,
    provider,
    model,
    mode,
    title,
    ts,
    ts,
  );
  setSetting("active_conversation", id);
  return id;
}
function activeConversation() {
  const id = getSetting("active_conversation", null);
  return id ? conversationRow(id) : null;
}
function ensureConversation(body, url) {
  requestProjectId(url, body);
  const requested = String(body.conversation_id || url.searchParams.get("conversation_id") || "").trim();
  if (requested && conversationRow(requested)) {
    setSetting("active_conversation", requested);
    return conversationRow(requested);
  }
  const active = activeConversation();
  if (active) return active;
  const id = createConversation({});
  return conversationRow(id);
}
function nextSeq(conversationId) {
  const row = sqlGet("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE conversation_id = ?", conversationId);
  return row ? row.n : 1;
}
function appendMessage(input) {
  const id = randomId("msg_");
  const seq = nextSeq(input.conversation_id);
  const ts = now();
  sqlRun(
    `INSERT INTO messages
      (id, conversation_id, role, content, parts_json, tool_calls_json, tool_call_id, name, model, provider,
       usage_json, diff, is_error, seq, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.conversation_id,
    input.role,
    input.content == null ? "" : String(input.content),
    JSON.stringify(input.parts || []),
    JSON.stringify(input.tool_calls || []),
    input.tool_call_id || "",
    input.name || "",
    input.model || "",
    input.provider || "",
    JSON.stringify(input.usage || {}),
    input.diff || "",
    input.is_error ? 1 : 0,
    seq,
    ts,
  );
  sqlRun("UPDATE conversations SET updated = ? WHERE id = ?", ts, input.conversation_id);
  sqlRun("UPDATE sessions SET updated = ? WHERE id = ?", ts, input.conversation_id);
  return sqlGet("SELECT * FROM messages WHERE id = ?", id);
}
function messageRows(conversationId) {
  return sqlAll(
    "SELECT rowid AS rid, * FROM messages WHERE conversation_id = ? ORDER BY seq ASC, rowid ASC",
    conversationId,
  );
}
function frontendMessage(row) {
  const base = {
    id: row.id,
    role: row.role,
    content: row.content,
    time: Math.floor(row.created / 1000),
    model: row.model || undefined,
    provider: row.provider || undefined,
  };
  if (row.role === "assistant") {
    const parts = parseJson(row.parts_json, []);
    return {
      ...base,
      parts: parts.length ? parts : row.content ? [{ type: "text", text: row.content }] : [],
      usage: parseJson(row.usage_json, {}),
    };
  }
  if (row.role === "tool") {
    return {
      ...base,
      role: "tool_result",
      tool_call_id: row.tool_call_id,
      diff: row.diff || undefined,
      is_error: !!row.is_error,
    };
  }
  return base;
}
function conversationPayload(conversationId) {
  const conv = conversationRow(conversationId);
  if (!conv) return null;
  return {
    id: conv.id,
    title: conv.title,
    provider: conv.provider,
    model: conv.model,
    mode: conv.mode,
    messages: messageRows(conversationId)
      .filter((m) => m.role !== "system")
      .map(frontendMessage),
  };
}
function updateSessionFields(conversationId, fields) {
  const current = sessionRow(conversationId);
  if (!current) return;
  const next = {
    provider: fields.provider == null ? current.provider : fields.provider,
    model: fields.model == null ? current.model : fields.model,
    mode: fields.mode == null ? current.mode : fields.mode,
    title: fields.title == null ? current.title : fields.title,
    running: fields.running == null ? current.running : fields.running ? 1 : 0,
    last_status: fields.last_status == null ? current.last_status : fields.last_status,
  };
  sqlRun(
    "UPDATE sessions SET provider = ?, model = ?, mode = ?, title = ?, running = ?, last_status = ?, updated = ? WHERE id = ?",
    next.provider,
    next.model,
    next.mode,
    next.title,
    next.running,
    next.last_status,
    now(),
    conversationId,
  );
  sqlRun(
    "UPDATE conversations SET provider = ?, model = ?, mode = ?, title = ?, updated = ? WHERE id = ?",
    next.provider,
    next.model,
    next.mode,
    next.title,
    now(),
    conversationId,
  );
}
function titleFrom(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 60) : "New Session";
}

// ═════════════════════════════════════════════════════════════
// Tool execution
// ═════════════════════════════════════════════════════════════
const SKIP_DIRS = new Set([".git", "node_modules", ".softaculous", "vendor", "dist", "build", ".cache"]);

function walkFiles(root, start, out = [], limit = 2000) {
  if (out.length >= limit) return out;
  let entries;
  try {
    entries = fs.readdirSync(start, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= limit) break;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(start, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, out, limit);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function unifiedDiff(oldText, newText, label) {
  const a = String(oldText == null ? "" : oldText).split("\n");
  const b = String(newText == null ? "" : newText).split("\n");
  const header = "--- a/" + label + "\n+++ b/" + label + "\n";
  if (a.length * b.length > 4_000_000) {
    return header + "@@ full replacement @@\n" + b.map((line) => "+" + line).join("\n") + "\n";
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push(" " + a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push("-" + a[i++]);
    } else {
      lines.push("+" + b[j++]);
    }
  }
  while (i < a.length) lines.push("-" + a[i++]);
  while (j < b.length) lines.push("+" + b[j++]);
  return header + "@@\n" + lines.join("\n") + "\n";
}

function recordSnapshot(projectId, conversationId, label, files, diff) {
  sqlRun(
    "INSERT INTO snapshots (id, project_id, conversation_id, label, files_json, diff_text, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
    randomId("snap_"),
    projectId,
    conversationId || "",
    clampText(label, 200),
    JSON.stringify(files),
    diff || "",
    now(),
  );
  sqlRun(
    "DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots WHERE project_id = ? ORDER BY created DESC LIMIT 100)",
    projectId,
  );
}

function toolRows(enabledOnly, mode) {
  let rows = enabledOnly
    ? sqlAll("SELECT * FROM tools WHERE enabled = 1 ORDER BY source ASC, name ASC")
    : sqlAll("SELECT * FROM tools ORDER BY source ASC, name ASC");
  if (mode === "plan") rows = rows.filter((row) => !!row.read_only);
  return rows;
}
function openAiTools(mode) {
  return toolRows(true, mode).map((row) => ({
    type: "function",
    function: {
      name: row.name,
      description: row.description,
      parameters: parseJson(row.schema_json, { type: "object", properties: {} }),
    },
  }));
}
function findToolRow(name) {
  return sqlGet("SELECT * FROM tools WHERE name = ?", name) || null;
}

function runShell(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: { ...process.env, ZC_PROJECT: cwd },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, EXEC_TIMEOUT);
    child.stdout.on("data", (data) => {
      if (stdout.length < EXEC_MAX_BUFFER) stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      if (stderr.length < EXEC_MAX_BUFFER) stderr += data.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + "\n" + error.message, killed });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code == null ? -1 : code, stdout, stderr, killed });
    });
  });
}

async function executeTool(name, input, ctx) {
  const row = findToolRow(name);
  if (!row || !row.enabled) {
    return { ok: false, output: "tool is not enabled: " + name, is_error: true };
  }
  if (ctx.mode === "plan" && !row.read_only) {
    return { ok: false, output: "tool is read-only in plan mode: " + name, is_error: true };
  }
  const project = ctx.project;
  const root = project.path;
  const args = input && typeof input === "object" ? input : {};
  try {
    if (row.source === "mcp") {
      const server = mcpRow(row.mcp_server_id);
      if (!server || !server.enabled) {
        return { ok: false, output: "MCP server is disabled: " + (row.mcp_server_id || ""), is_error: true };
      }
      const result = await callMcpTool(server, row.external_name, args, ctx.conversationId);
      return result;
    }

    if (name === "server_info") {
      const enabled = toolRows(true, ctx.mode).map((t) => t.name);
      return {
        ok: true,
        output: JSON.stringify(
          {
            service: "zc-runtime",
            version: VERSION,
            storage: "sqlite",
            project: project.name,
            project_path: root,
            identity: identityPayload().name,
            mode: ctx.mode,
            tools: enabled,
          },
          null,
          2,
        ),
      };
    }

    if (name === "read_file") {
      const abs = safeResolve(root, args.path);
      let text = fs.readFileSync(abs, "utf8");
      if (args.start || args.end) {
        const lines = text.split("\n");
        const start = Math.max(1, asInt(args.start, 1));
        const end = Math.max(start, asInt(args.end, lines.length));
        text = lines
          .slice(start - 1, Math.min(end, lines.length))
          .map((line, index) => start + index + ": " + line)
          .join("\n");
      }
      if (text.length > 400000) text = text.slice(0, 400000) + "\n[truncated]";
      return { ok: true, output: text };
    }

    if (name === "list_files") {
      const abs = safeResolve(root, args.path || "/");
      const entries = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 500);
      const files = [];
      const directories = [];
      for (const entry of entries) {
        const full = path.join(abs, entry.name);
        const display = relativeDisplay(root, full);
        if (entry.isDirectory()) directories.push({ name: entry.name, path: display });
        else {
          const stat = fs.statSync(full);
          files.push({ name: entry.name, path: display, size: stat.size });
        }
      }
      return { ok: true, output: JSON.stringify({ directories, files }, null, 2) };
    }

    if (name === "grep") {
      const pattern = String(args.pattern || "");
      if (!pattern) return { ok: false, output: "pattern is required", is_error: true };
      let matcher;
      try {
        matcher = new RegExp(pattern, "i");
      } catch {
        matcher = null;
      }
      const start = safeResolve(root, args.path || "/");
      const files = walkFiles(root, start, [], 4000);
      const results = [];
      for (const file of files) {
        if (results.length >= 200) break;
        let text;
        try {
          text = fs.readFileSync(file, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\u0000")) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && results.length < 200; i++) {
          const hit = matcher ? matcher.test(lines[i]) : lines[i].toLowerCase().includes(pattern.toLowerCase());
          if (hit) {
            results.push(relativeDisplay(root, file) + ":" + (i + 1) + ":" + clampText(lines[i], 240));
          }
        }
      }
      return { ok: true, output: results.join("\n") || "no matches" };
    }

    if (name === "glob") {
      const pattern = String(args.pattern || "");
      if (!pattern) return { ok: false, output: "pattern is required", is_error: true };
      const matches = fs.globSync(pattern, { cwd: root }).slice(0, 200);
      return { ok: true, output: matches.join("\n") || "no matches" };
    }

    if (name === "write_file") {
      const abs = safeResolve(root, args.path);
      const content = String(args.content == null ? "" : args.content);
      const rel = relativeDisplay(root, abs).replace(/^\//, "");
      const existed = fs.existsSync(abs);
      const old = existed ? fs.readFileSync(abs, "utf8") : null;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      const diff = unifiedDiff(old || "", content, rel);
      recordSnapshot(project.id, ctx.conversationId, "write_file " + rel, { [rel]: old }, diff);
      return { ok: true, output: "wrote " + Buffer.byteLength(content) + " bytes to " + rel, diff };
    }

    if (name === "edit_file" || name === "replace_in_file") {
      const abs = safeResolve(root, args.path);
      const rel = relativeDisplay(root, abs).replace(/^\//, "");
      if (!fs.existsSync(abs)) return { ok: false, output: "file not found: " + rel, is_error: true };
      const old = fs.readFileSync(abs, "utf8");
      const needle = String(args.old_string == null ? args.oldText == null ? "" : args.oldText : args.old_string);
      const replacement = String(
        args.new_string == null ? args.newText == null ? "" : args.newText : args.new_string,
      );
      if (!needle) return { ok: false, output: "old_string is required", is_error: true };
      const count = old.split(needle).length - 1;
      if (count === 0) return { ok: false, output: "old_string not found in " + rel, is_error: true };
      if (name === "edit_file" && count !== 1) {
        return { ok: false, output: "old_string is not unique (" + count + " matches) in " + rel, is_error: true };
      }
      const next = old.split(needle).join(replacement);
      fs.writeFileSync(abs, next);
      const diff = unifiedDiff(old, next, rel);
      recordSnapshot(project.id, ctx.conversationId, name + " " + rel, { [rel]: old }, diff);
      return { ok: true, output: "updated " + rel + " (" + count + " replacement(s))", diff };
    }

    if (name === "bash") {
      const result = await runShell(String(args.command || ""), root);
      const output =
        "exit=" + result.code + (result.killed ? " (timeout)" : "") + "\n" +
        (result.stdout || "") +
        (result.stderr ? "\n[stderr]\n" + result.stderr : "");
      return { ok: result.code === 0, output: clampText(output, EXEC_MAX_BUFFER), is_error: result.code !== 0 };
    }

    return { ok: false, output: "unimplemented tool: " + name, is_error: true };
  } catch (error) {
    return {
      ok: false,
      output: "Error: " + compactError(error),
      is_error: true,
      diff: error && error.diff ? error.diff : "",
    };
  }
}

// ═════════════════════════════════════════════════════════════
// Agent loop
// ═════════════════════════════════════════════════════════════
const running = new Map();

function buildSystemPrompt(conversationId, mode, allowTools = true) {
  const prompt = activePrompt();
  const identity = identityPayload();
  const project = activeProject();
  const contexts = projectContexts(project ? project.id : null);
  const enabled = toolRows(true, mode || "build").map((row) => row.name);
  const lines = [
    prompt.content,
    "",
    "## Runtime identity",
    "name: " + identity.name,
    "owner: " + identity.owner,
    "source: " + identity.source,
    "conversation: " + (conversationId || ""),
    "",
    "## Active project",
    project
      ? "name: " + project.name + "\npath: " + project.path + "\ntype: " + project.type
      : "none",
    "",
    "## Enabled tools",
    allowTools ? enabled.join(", ") || "none" : "none (this provider does not support tool calls)",
  ];
  if (contexts.bootstrap) lines.push("", "## Project bootstrap", contexts.bootstrap);
  if (contexts.state) lines.push("", "## Project state", contexts.state);
  if (contexts.memory) lines.push("", "## Project memory", contexts.memory);
  return lines.join("\n");
}

function providerHistory(conversationId) {
  let rows = messageRows(conversationId).slice(-80);
  const firstUser = rows.findIndex((row) => row.role === "user");
  if (firstUser > 0) rows = rows.slice(firstUser);
  const out = [];
  for (const row of rows) {
    if (row.role === "user") {
      out.push({ role: "user", content: row.content });
    } else if (row.role === "assistant") {
      const calls = parseJson(row.tool_calls_json, []);
      const msg = { role: "assistant", content: row.content || "" };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    } else if (row.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: row.tool_call_id,
        content: row.content,
      });
    }
  }
  return out;
}

function normalizeToolCalls(message) {
  const calls = [];
  for (const call of message.tool_calls || []) {
    const fn = call.function || {};
    let parsed = {};
    try {
      parsed = JSON.parse(fn.arguments || "{}");
    } catch {
      parsed = { _raw: fn.arguments || "" };
    }
    calls.push({
      id: call.id || randomId("call_"),
      name: fn.name || call.name || "",
      input: parsed,
    });
  }
  return calls;
}

function ensureProviderForConversation(conv) {
  let provider = conv.provider ? providerRow(conv.provider) : null;
  if (!provider) {
    provider = sqlGet("SELECT * FROM providers WHERE connected = 1 ORDER BY CASE WHEN id = 'ollama' THEN 0 ELSE 1 END, is_custom_type ASC, name ASC LIMIT 1");
  }
  if (!provider) throw new Error("no provider connected");
  let model = conv.model || provider.default_model;
  const models = parseJson(provider.models_json, {});
  if (!model) model = Object.keys(models)[0] || "";
  if (!model) throw new Error("provider has no model: " + provider.id);
  updateSessionFields(conv.id, { provider: provider.id, model });
  return { provider, model };
}

async function runAgent(conversationId, content, emit = () => {}) {
  if (running.has(conversationId)) {
    const err = new Error("generation already in progress for this conversation");
    err.code = "already_running";
    throw err;
  }
  const conv = conversationRow(conversationId);
  if (!conv) throw new Error("conversation not found");
  const project = activeProject();
  if (!project) throw new Error("no active project");
  const { provider, model } = ensureProviderForConversation(conv);
  const controller = new AbortController();
  running.set(conversationId, controller);
  updateSessionFields(conversationId, { running: 1, last_status: "running" });

  const runStarted = now();
  recordSessionMetric(conversationId, {
    project_id: project.id,
    provider: provider.id,
    model,
    mode: conv.mode || "build",
    iterations: 0,
    tool_calls: 0,
    tool_errors: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cached_tokens: 0,
    total_tokens: 0,
    duration_ms: 0,
    status: "running",
    error: "",
    started: runStarted,
  });
  const userMessage = appendMessage({
    conversation_id: conversationId,
    role: "user",
    content: String(content || ""),
  });
  const isFirst = messageRows(conversationId).filter((m) => m.role === "user").length === 1;
  if (isFirst) {
    const title = titleFrom(content);
    updateSessionFields(conversationId, { title });
    emit({ _event: "title", conversation_id: conversationId, title });
  }

  const usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
  const allowTools = provider.supports_tools !== 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let iterations = 0;
  let finalText = "";
  let completed = false;

  try {
    for (let iteration = 1; iteration <= MAX_ITER; iteration++) {
      if (controller.signal.aborted) throw Object.assign(new Error("aborted"), { code: "aborted" });
      emit({
        _event: "iteration-start",
        conversation_id: conversationId,
        iteration,
      });
      const tools = allowTools ? openAiTools(conv.mode || "build") : [];
      const messages = [
        { role: "system", content: buildSystemPrompt(conversationId, conv.mode || "build", allowTools) },
        ...providerHistory(conversationId),
      ];
      const result = await providerChat(
        provider,
        {
          model,
          messages,
          tools,
          session: conv,
          conversation_id: conversationId,
        },
        AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
      );
      iterations++;
      const u = result.usage || {};
      usage.input_tokens += u.prompt_tokens || u.input_tokens || 0;
      usage.output_tokens += u.completion_tokens || u.output_tokens || 0;
      usage.cached_tokens +=
        (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ||
        u.cached_tokens ||
        u.cache_read_input_tokens ||
        0;

      const reasoning = result.message.reasoning_content || result.message.reasoning || "";
      const text = result.message.content == null ? "" : String(result.message.content);
      if (reasoning) {
        emit({
          _event: "reasoning-delta",
          conversation_id: conversationId,
          text: reasoning,
        });
      }
      if (text) {
        finalText += text;
        emit({
          _event: "text-delta",
          conversation_id: conversationId,
          text,
        });
      }

      const calls = normalizeToolCalls(result.message);
      if (calls.length) {
        toolCalls += calls.length;
        const parts = [];
        if (reasoning) parts.push({ type: "reasoning", text: reasoning });
        if (text) parts.push({ type: "text", text });
        for (const call of calls) {
          parts.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
        }
        appendMessage({
          conversation_id: conversationId,
          role: "assistant",
          content: text,
          parts,
          tool_calls: result.message.tool_calls || [],
          model,
          provider: provider.id,
          usage: u,
        });
        for (const call of calls) {
          emit({
            _event: "tool-call",
            conversation_id: conversationId,
            id: call.id,
            name: call.name,
            input: call.input,
          });
          const output = await executeTool(call.name, call.input, {
            project,
            conversationId,
            mode: conv.mode || "build",
          });
          if (output.is_error) toolErrors += 1;
          emit({
            _event: "tool-result",
            conversation_id: conversationId,
            id: call.id,
            name: call.name,
            input: call.input,
            output: output.output,
            is_error: !!output.is_error,
            diff: output.diff || "",
          });
          appendMessage({
            conversation_id: conversationId,
            role: "tool",
            content: output.output,
            tool_call_id: call.id,
            name: call.name,
            diff: output.diff || "",
            is_error: output.is_error,
            model,
            provider: provider.id,
          });
        }
        continue;
      }

      const parts = [];
      if (reasoning) parts.push({ type: "reasoning", text: reasoning });
      if (text) parts.push({ type: "text", text });
      appendMessage({
        conversation_id: conversationId,
        role: "assistant",
        content: text,
        parts,
        model,
        provider: provider.id,
        usage: u,
      });
      completed = true;
      break;
    }

    if (!completed) {
      throw new Error("tool loop exceeded " + MAX_ITER + " iterations");
    }

    updateSessionFields(conversationId, { running: 0, last_status: "completed" });
    recordSessionMetric(conversationId, {
      project_id: project.id,
      provider: provider.id,
      model,
      mode: conv.mode || "build",
      iterations,
      tool_calls: toolCalls,
      tool_errors: toolErrors,
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      cached_tokens: usage.cached_tokens,
      total_tokens: usage.input_tokens + usage.output_tokens,
      duration_ms: now() - runStarted,
      status: "completed",
      error: "",
      started: runStarted,
    });
    const allMessages = [
      { role: "system", content: buildSystemPrompt(conversationId, conv.mode || "build", allowTools) },
      ...providerHistory(conversationId),
    ];
    emit({
      _event: "usage",
      conversation_id: conversationId,
      usage,
      context_tokens: estimateTokens(allMessages),
    });
    emit({
      _event: "done",
      conversation_id: conversationId,
      usage,
      context_tokens: estimateTokens(allMessages),
      tool_calls: toolCalls,
      iterations,
      cost: 0,
      model,
      provider: provider.id,
      auto_title: isFirst ? titleFrom(content) : undefined,
    });
    logEvent("INFO", "agent_done", {
      conversation: conversationId,
      provider: provider.id,
      model,
      iterations,
      tool_calls: toolCalls,
      output_chars: finalText.length,
    });
    return {
      ok: true,
      conversation_id: conversationId,
      usage,
      tool_calls: toolCalls,
      iterations,
      text: finalText,
      user_message_id: userMessage.id,
    };
  } catch (error) {
    const aborted = error.code === "aborted" || controller.signal.aborted;
    updateSessionFields(conversationId, {
      running: 0,
      last_status: aborted ? "aborted" : "error",
    });
    recordSessionMetric(conversationId, {
      project_id: project.id,
      provider: provider.id,
      model,
      mode: conv.mode || "build",
      iterations,
      tool_calls: toolCalls,
      tool_errors: toolErrors,
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      cached_tokens: usage.cached_tokens,
      total_tokens: usage.input_tokens + usage.output_tokens,
      duration_ms: now() - runStarted,
      status: aborted ? "aborted" : "error",
      error: aborted ? "aborted" : compactError(error),
      started: runStarted,
    });
    if (!aborted) {
      emit({
        _event: "error",
        conversation_id: conversationId,
        message: compactError(error),
      });
      logEvent("ERROR", "agent_failed", {
        conversation: conversationId,
        provider: provider.id,
        model,
        error: compactError(error),
      });
    }
    return { ok: false, aborted, error: compactError(error) };
  } finally {
    running.delete(conversationId);
    updateSessionFields(conversationId, { running: 0 });
  }
}

// ═════════════════════════════════════════════════════════════
// Frontend actions
// ═════════════════════════════════════════════════════════════
function sessionForResponse() {
  const conv = activeConversation();
  if (!conv) {
    return {
      provider: getSetting("provider", ""),
      model: getSetting("model", ""),
      mode: getSetting("mode", "build"),
      active_conversation: null,
    };
  }
  return {
    provider: conv.provider,
    model: conv.model,
    mode: conv.mode,
    active_conversation: conv.id,
  };
}
function modelInfo() {
  const out = {};
  for (const row of sqlAll("SELECT models_json FROM providers")) {
    const models = parseJson(row.models_json, {});
    for (const [id, meta] of Object.entries(models)) {
      out[id] = { context: (meta && meta.context_window) || 32768 };
    }
  }
  return out;
}
function favoriteModels() {
  return sqlAll("SELECT model_id FROM favorites ORDER BY created ASC").map((row) => row.model_id);
}
function permissionsMap() {
  const out = {};
  for (const row of sqlAll("SELECT key, value FROM permissions")) out[row.key] = row.value;
  return out;
}
function listConversationsForActiveProject() {
  const project = activeProject();
  const rows = project
    ? sqlAll(
        `SELECT s.*, c.title AS conv_title,
          (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = s.id) AS message_count,
          sm.iterations, sm.tool_calls, sm.tool_errors, sm.prompt_tokens, sm.completion_tokens,
          sm.total_tokens, sm.duration_ms, sm.error AS metric_error, sm.status AS metric_status
         FROM sessions s JOIN conversations c ON c.id = s.id
         LEFT JOIN session_metrics sm ON sm.conversation_id = s.id
         WHERE s.project_id = ? ORDER BY s.updated DESC LIMIT 200`,
        project.id,
      )
    : [];
  return rows.map((row) => ({
    id: row.id,
    title: row.conv_title || row.title || "Untitled",
    updated_at: Math.floor(row.updated / 1000),
    message_count: row.message_count,
    running: !!row.running,
    last_status: row.metric_status || row.last_status,
    provider: row.provider,
    model: row.model,
    mode: row.mode,
    iterations: row.iterations || 0,
    tool_calls: row.tool_calls || 0,
    tool_errors: row.tool_errors || 0,
    total_tokens: row.total_tokens || 0,
    duration_ms: row.duration_ms || 0,
    error: row.metric_error || "",
  }));
}
function projectInfo() {
  const project = activeProject();
  if (!project) return { overview: "Project type: none\nProject path: " + WORKSPACE, type: "none" };
  const ctx = projectContexts(project.id);
  const overview = [
    "Project type: " + (project.type || "custom"),
    "Project path: " + project.path,
    ctx.bootstrap ? ctx.bootstrap : "",
  ].filter(Boolean).join("\n");
  return { project_id: project.id, name: project.name, path: project.path, type: project.type, overview };
}
function projectList() {
  return sqlAll("SELECT * FROM projects WHERE closed = 0 ORDER BY updated DESC").map((row) => ({
    project_id: row.id,
    name: row.name,
    path: row.path,
    type: row.type,
    insid: row.insid,
  }));
}
function createProject(input) {
  const name = clampText(input.name || "", 160).trim() || "Project";
  let requested = String(input.path || "").trim();
  if (!requested) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "project";
    requested = path.join(PROJECTS_DIR, slug);
  }
  if (!path.isAbsolute(requested)) requested = path.resolve(WORKSPACE, requested);
  const abs = path.resolve(requested);
  if (!ALLOW_OUTSIDE && !isInside(WORKSPACE, abs)) {
    throw new Error("project path must stay inside " + WORKSPACE);
  }
  fs.mkdirSync(abs, { recursive: true });
  const id = randomId("proj_");
  sqlRun(
    "INSERT INTO projects (id, name, path, type, insid, closed, created, updated) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
    id,
    name,
    abs,
    input.type || "custom",
    input.insid || "",
    now(),
    now(),
  );
  setSetting("active_project", id);
  setSetting("active_conversation", null);
  logEvent("INFO", "project_created", { project: id, path: abs });
  return { project_id: id, name, path: abs };
}
function closeProject(id) {
  const row = sqlGet("SELECT id FROM projects WHERE id = ?", id);
  if (!row) return false;
  for (const session of sqlAll("SELECT id FROM sessions WHERE project_id = ?", id)) {
    if (running.has(session.id)) running.get(session.id).abort();
  }
  sqlRun("UPDATE projects SET closed = 1, updated = ? WHERE id = ?", now(), id);
  if (getSetting("active_project", null) === id) {
    const next = sqlGet("SELECT id FROM projects WHERE closed = 0 ORDER BY created ASC LIMIT 1");
    setSetting("active_project", next ? next.id : null);
    setSetting("active_conversation", null);
  }
  return true;
}
function deleteProject(id) {
  const row = sqlGet("SELECT id FROM projects WHERE id = ?", id);
  if (!row) return false;
  for (const session of sqlAll("SELECT id FROM sessions WHERE project_id = ?", id)) {
    if (running.has(session.id)) running.get(session.id).abort();
  }
  sqlRun("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM sessions WHERE project_id = ?)", id);
  sqlRun("DELETE FROM session_metrics WHERE project_id = ?", id);
  sqlRun("DELETE FROM conversations WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)", id);
  sqlRun("DELETE FROM sessions WHERE project_id = ?", id);
  sqlRun("DELETE FROM project_contexts WHERE project_id = ?", id);
  sqlRun("DELETE FROM snapshots WHERE project_id = ?", id);
  sqlRun("DELETE FROM projects WHERE id = ?", id);
  if (getSetting("active_project", null) === id) {
    const next = sqlGet("SELECT id FROM projects WHERE closed = 0 ORDER BY created ASC LIMIT 1");
    setSetting("active_project", next ? next.id : null);
    setSetting("active_conversation", null);
  }
  return true;
}
function fileTree(input) {
  const root = projectRoot();
  const abs = safeResolve(root, input.path || "/");
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return { error: "directory not found", directories: [], files: [] };
  }
  const dirs = [];
  const files = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(abs, entry.name);
    const display = relativeDisplay(root, full);
    if (entry.isDirectory()) dirs.push({ name: entry.name, path: display });
    else {
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        /* ignore */
      }
      files.push({ name: entry.name, path: display, size });
    }
  }
  return { directories: dirs, files };
}
function readProjectFile(input) {
  const root = projectRoot();
  const abs = safeResolve(root, input.path || "");
  if (!fs.existsSync(abs)) return { error: "file not found" };
  if (fs.statSync(abs).isDirectory()) return { error: "path is a directory" };
  const content = fs.readFileSync(abs, "utf8");
  return { content: content.length > 800000 ? content.slice(0, 800000) + "\n[truncated]" : content };
}
function contextAction(kind, input) {
  const project = activeProject();
  if (!project) return { success: false, error: "no active project" };
  if (kind.endsWith("_get")) {
    const row = sqlGet(
      "SELECT content FROM project_contexts WHERE project_id = ? AND kind = ?",
      project.id,
      kind.replace("_get", ""),
    );
    return { content: row ? row.content : "" };
  }
  const base = kind.replace(/_(save|clear)$/, "");
  if (kind.endsWith("_clear")) {
    sqlRun("DELETE FROM project_contexts WHERE project_id = ? AND kind = ?", project.id, base);
    return { success: true };
  }
  const content = clampText(input.content || "", 100000);
  sqlRun(
    `INSERT INTO project_contexts (project_id, kind, content, updated) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, kind) DO UPDATE SET content = excluded.content, updated = excluded.updated`,
    project.id,
    base,
    content,
    now(),
  );
  return { success: true };
}
function compactConversation(conversationId, keepLast) {
  const rows = messageRows(conversationId);
  const keep = Math.max(1, Math.min(20, asInt(keepLast, 3)));
  const tail = rows.slice(-keep * 2);
  const removed = rows.length - tail.length;
  if (removed <= 0) return { success: true, messages: conversationPayload(conversationId).messages, summary: "nothing to compact" };
  const keepIds = new Set(tail.map((row) => row.id));
  sqlRun(
    "DELETE FROM messages WHERE conversation_id = ? AND id NOT IN (" + tail.map(() => "?").join(",") + ")",
    conversationId,
    ...tail.map((row) => row.id),
  );
  setSetting("compaction_note_" + conversationId, {
    removed,
    at: now(),
    note: "Earlier messages were removed by /compact; ask the user to restate anything essential.",
  });
  return { success: true, messages: conversationPayload(conversationId).messages, removed };
}
function undoConversation(conversationId, messageId) {
  const rows = messageRows(conversationId);
  const index = rows.findIndex((row) => row.id === messageId);
  if (index < 0) return { success: false, error: "message not found" };
  const removed = rows.slice(index);
  sqlRun(
    "INSERT INTO undo_stack (id, conversation_id, messages_json, created) VALUES (?, ?, ?, ?)",
    randomId("undo_"),
    conversationId,
    JSON.stringify(removed),
    now(),
  );
  sqlRun("DELETE FROM messages WHERE id IN (" + removed.map(() => "?").join(",") + ")", ...removed.map((row) => row.id));
  return { success: true, messages: conversationPayload(conversationId).messages };
}
function redoConversation(conversationId) {
  const row = sqlGet(
    "SELECT * FROM undo_stack WHERE conversation_id = ? ORDER BY created DESC LIMIT 1",
    conversationId,
  );
  if (!row) return { success: false, error: "nothing to redo" };
  const messages = parseJson(row.messages_json, []);
  for (const m of messages) {
    sqlRun(
      `INSERT OR IGNORE INTO messages
        (id, conversation_id, role, content, parts_json, tool_calls_json, tool_call_id, name, model, provider,
         usage_json, diff, is_error, seq, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      m.id,
      conversationId,
      m.role,
      m.content,
      m.parts_json,
      m.tool_calls_json,
      m.tool_call_id,
      m.name,
      m.model,
      m.provider,
      m.usage_json,
      m.diff,
      m.is_error,
      m.seq,
      m.created,
    );
  }
  sqlRun("DELETE FROM undo_stack WHERE id = ?", row.id);
  return { success: true, messages: conversationPayload(conversationId).messages };
}
function forkConversation(conversationId, messageId) {
  const rows = messageRows(conversationId);
  const index = rows.findIndex((row) => row.id === messageId);
  if (index < 0) return { success: false, error: "message not found" };
  const source = conversationRow(conversationId);
  const newId = createConversation({
    title: (source.title || "Session") + " (fork)",
    provider: source.provider,
    model: source.model,
    mode: source.mode,
  });
  const copied = rows.slice(0, index + 1);
  for (const m of copied) {
    appendMessage({
      conversation_id: newId,
      role: m.role,
      content: m.content,
      parts: parseJson(m.parts_json, []),
      tool_calls: parseJson(m.tool_calls_json, []),
      tool_call_id: m.tool_call_id,
      name: m.name,
      model: m.model,
      provider: m.provider,
      usage: parseJson(m.usage_json, {}),
      diff: m.diff,
      is_error: m.is_error,
    });
  }
  const lastUser = [...copied].reverse().find((m) => m.role === "user");
  return {
    success: true,
    conversation_id: newId,
    title: conversationRow(newId).title,
    forked_content: lastUser ? lastUser.content : "",
  };
}
function regenerateLast(conversationId) {
  const rows = messageRows(conversationId);
  let lastUserIndex = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return { success: false, error: "no user message" };
  const remove = rows.slice(lastUserIndex + 1);
  if (!remove.length) return { success: false, error: "nothing to regenerate" };
  sqlRun("DELETE FROM messages WHERE id IN (" + remove.map(() => "?").join(",") + ")", ...remove.map((row) => row.id));
  return { success: true, messages: conversationPayload(conversationId).messages };
}
function changesForProject() {
  const project = activeProject();
  if (!project) return { snapshots: [] };
  return {
    snapshots: sqlAll(
      "SELECT id, label, created FROM snapshots WHERE project_id = ? ORDER BY created DESC LIMIT 100",
      project.id,
    ).map((row) => ({ id: row.id, message: row.label, time: Math.floor(row.created / 1000) })),
  };
}
function diffSnapshot(id) {
  const row = sqlGet("SELECT * FROM snapshots WHERE id = ?", id);
  return row ? { diff: row.diff_text } : { error: "snapshot not found" };
}
function restoreSnapshot(id) {
  const row = sqlGet("SELECT * FROM snapshots WHERE id = ?", id);
  if (!row) return { restored: false, error: "snapshot not found" };
  const project = sqlGet("SELECT * FROM projects WHERE id = ?", row.project_id);
  if (!project) return { restored: false, error: "project not found" };
  const files = parseJson(row.files_json, {});
  for (const [rel, content] of Object.entries(files)) {
    const abs = safeResolve(project.path, rel);
    if (content == null) {
      if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(content));
    }
  }
  return { restored: true };
}

// ═════════════════════════════════════════════════════════════
// HTTP helpers
// ═════════════════════════════════════════════════════════════
function json(res, status, body, extra = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...brandingHeaders(),
    ...extra,
  });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers["content-length"] || "0", 10);
    if (declared > MAX_BODY) {
      reject(Object.assign(new Error("body too large"), { status: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const type = String(req.headers["content-type"] || "");
      if (type.includes("application/json")) return resolve(parseJson(raw || "{}", {}));
      const out = {};
      for (const [key, value] of new URLSearchParams(raw)) out[key] = value;
      resolve(out);
    });
    req.on("error", reject);
  });
}
function authorizedProxy(req) {
  const header = String(req.headers["x-zc-proxy-token"] || "");
  if (!PROXY_TOKEN) return true;
  if (!header || header.length !== PROXY_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(PROXY_TOKEN));
}
function authorizedAdmin(req) {
  if (!ADMIN_AUTH_ENABLED) return true;
  if (!ADMIN_TOKEN) return false;
  const header = String(req.headers["x-admin-token"] || "");
  const bearer = String(req.headers.authorization || "");
  const token = header || (bearer.startsWith("Bearer ") ? bearer.slice(7) : "");
  if (!token || token.length !== ADMIN_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
}
function sse(res, event) {
  if (res.writableEnded) return;
  try {
    res.write("data: " + JSON.stringify(event) + "\n\n");
  } catch {
    /* the browser disconnected */
  }
}
function sseStart(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });
  if (res.flushHeaders) res.flushHeaders();
}
function checkCsrf(body, url) {
  const expected = getSetting("csrf", "");
  if (!expected) return true;
  const token =
    String((body && body.csrf_token) || "") ||
    String((url && url.searchParams.get("csrf_token")) || "");
  return token === String(expected);
}

// ═════════════════════════════════════════════════════════════
// Admin core
// ═════════════════════════════════════════════════════════════
function sessionMetricRows(limit = 100) {
  return sqlAll(
    `SELECT sm.*, c.title, p.name AS project_name
     FROM session_metrics sm
     LEFT JOIN conversations c ON c.id = sm.conversation_id
     LEFT JOIN projects p ON p.id = sm.project_id
     ORDER BY sm.updated DESC LIMIT ?`,
    Math.max(1, Math.min(500, asInt(limit, 100))),
  );
}
function requestLogRows(limit = 100) {
  return sqlAll(
    `SELECT request_id, method, route, action, status, duration_ms, ip, user_agent, query,
            project_id, conversation_id, provider, model, bytes, is_admin, created
     FROM request_log ORDER BY id DESC LIMIT ?`,
    Math.max(1, Math.min(1000, asInt(limit, 100))),
  ).map((row) => ({ ...row, time: new Date(row.created).toISOString(), is_admin: !!row.is_admin }));
}
function usageTotals() {
  const totals = sqlGet(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(total_tokens), 0) AS tokens,
            COALESCE(SUM(tool_calls), 0) AS tool_calls, COALESCE(SUM(tool_errors), 0) AS tool_errors,
            COALESCE(AVG(duration_ms), 0) AS avg_duration_ms
     FROM session_metrics`,
  );
  return {
    runs: totals.runs,
    tokens: totals.tokens,
    tool_calls: totals.tool_calls,
    tool_errors: totals.tool_errors,
    avg_duration_ms: Math.round(totals.avg_duration_ms || 0),
    by_provider: sqlAll(
      `SELECT provider, COUNT(*) AS runs, COALESCE(SUM(total_tokens), 0) AS tokens,
              COALESCE(SUM(tool_calls), 0) AS tool_calls, COALESCE(SUM(tool_errors), 0) AS tool_errors
       FROM session_metrics GROUP BY provider ORDER BY tokens DESC`,
    ),
  };
}
function projectListAll() {
  return sqlAll("SELECT * FROM projects ORDER BY closed ASC, updated DESC").map((row) => ({
    project_id: row.id,
    name: row.name,
    path: row.path,
    type: row.type,
    insid: row.insid,
    closed: !!row.closed,
    created: row.created,
    updated: row.updated,
  }));
}
function activateProject(id) {
  const row = sqlGet("SELECT * FROM projects WHERE id = ? AND closed = 0", String(id || ""));
  if (!row) return null;
  setSetting("active_project", row.id);
  setSetting("active_conversation", null);
  logEvent("INFO", "project_activated", { project: row.id, path: row.path });
  return row;
}

function adminCore() {
  return {
    version: VERSION,
    workspace: WORKSPACE,
    identity: identityPayload(),
    state() {
      const project = activeProject();
      return {
        service: "zc-runtime",
        version: VERSION,
        storage: "sqlite",
        db: "zc.sqlite",
        workspace: WORKSPACE,
        projects_dir: PROJECTS_DIR,
        uptime_sec: Math.round((now() - STARTED) / 1000),
        php_url: "http://" + PHP_HOST + ":" + PHP_PORT + "/index.php",
        auth: { enabled: ADMIN_AUTH_ENABLED, has_token: !!ADMIN_TOKEN },
        env: {
          files: ENV_FILES,
          entries: sqlAll("SELECT key, value, secret, source, updated FROM env_import ORDER BY key ASC"),
        },
        identity: identityPayload(),
        prompt: activePrompt(),
        prompts: sqlAll("SELECT id, name, active, created, updated FROM system_prompts ORDER BY updated DESC"),
        providers: sqlAll("SELECT * FROM providers ORDER BY is_custom_type ASC, name ASC").map(providerMasked),
        tools: toolRows(false, null).map((row) => ({
          id: row.id,
          name: row.name,
          external_name: row.external_name,
          description: row.description,
          source: row.source,
          enabled: !!row.enabled,
          read_only: !!row.read_only,
          mcp_server_id: row.mcp_server_id,
        })),
        mcp: mcpList(),
        projects: projectListAll(),
        active_project: project ? { id: project.id, name: project.name, path: project.path } : null,
        sessions: listConversationsForActiveProject().slice(0, 50),
        metrics: sessionMetricRows(50),
        requests: requestLogRows(60),
        totals: usageTotals(),
        counts: {
          messages: sqlGet("SELECT COUNT(*) AS n FROM messages").n,
          sessions: sqlGet("SELECT COUNT(*) AS n FROM sessions").n,
          providers: sqlGet("SELECT COUNT(*) AS n FROM providers").n,
          tools: sqlGet("SELECT COUNT(*) AS n FROM tools").n,
          mcp: sqlGet("SELECT COUNT(*) AS n FROM mcp_servers").n,
          requests: sqlGet("SELECT COUNT(*) AS n FROM request_log").n,
          env: sqlGet("SELECT COUNT(*) AS n FROM env_import").n,
        },
        logs: sqlAll("SELECT level, event, detail, created FROM runtime_log ORDER BY id DESC LIMIT 50").map((row) => ({
          level: row.level,
          event: row.event,
          detail: parseJson(row.detail, {}),
          time: new Date(row.created).toISOString(),
        })),
      };
    },
    saveIdentity(input) {
      const row = activeIdentity();
      const name = clampText(input.name || (row && row.name) || "ZC", 160);
      const owner = clampText(input.owner || (row && row.owner) || "", 160);
      const metadata = input.metadata == null ? parseJson(row ? row.metadata : "{}", {}) : input.metadata;
      if (row) {
        sqlRun(
          "UPDATE identities SET name = ?, owner = ?, metadata = ?, updated = ? WHERE id = ?",
          name,
          owner,
          JSON.stringify(metadata),
          now(),
          row.id,
        );
      } else {
        sqlRun(
          "INSERT INTO identities (id, name, owner, source, metadata, created, updated) VALUES (?, ?, ?, 'admin', ?, ?, ?)",
          randomId("identity_"),
          name,
          owner,
          JSON.stringify(metadata),
          now(),
          now(),
        );
      }
      logEvent("INFO", "identity_saved", { name });
      return identityPayload();
    },
    listPrompts() {
      return sqlAll("SELECT * FROM system_prompts ORDER BY active DESC, updated DESC");
    },
    savePrompt(input) {
      const id = input.id || randomId("prompt_");
      const name = clampText(input.name || "Prompt", 160);
      const content = clampText(input.content || "", 200000);
      const existing = sqlGet("SELECT id FROM system_prompts WHERE id = ?", id);
      if (existing) {
        sqlRun("UPDATE system_prompts SET name = ?, content = ?, updated = ? WHERE id = ?", name, content, now(), id);
      } else {
        sqlRun(
          "INSERT INTO system_prompts (id, name, content, active, created, updated) VALUES (?, ?, ?, 0, ?, ?)",
          id,
          name,
          content,
          now(),
          now(),
        );
      }
      return sqlGet("SELECT * FROM system_prompts WHERE id = ?", id);
    },
    activatePrompt(id) {
      if (!sqlGet("SELECT id FROM system_prompts WHERE id = ?", id)) return false;
      sqlRun("UPDATE system_prompts SET active = 0");
      sqlRun("UPDATE system_prompts SET active = 1, updated = ? WHERE id = ?", now(), id);
      setSetting("active_prompt_id", id);
      return true;
    },
    deletePrompt(id) {
      const row = sqlGet("SELECT * FROM system_prompts WHERE id = ?", id);
      if (!row) return false;
      if (row.active) return false;
      sqlRun("DELETE FROM system_prompts WHERE id = ?", id);
      return true;
    },
    providers() {
      return sqlAll("SELECT * FROM providers ORDER BY is_custom_type ASC, name ASC").map(providerMasked);
    },
    saveProvider,
    deleteProvider,
    async testProvider(input) {
      const id = String(input.provider_id || input.id || "");
      let row = providerRow(id);
      if (!row) {
        saveProvider(input);
        row = providerRow(id);
      } else if (input.api_key || input.base_url || input.models) {
        saveProvider({ ...input, provider_id: id });
        row = providerRow(id);
      }
      if (!row) throw new Error("provider not found");
      return testProvider(row, input.model);
    },
    tools() {
      return toolRows(false, null).map((row) => ({
        id: row.id,
        name: row.name,
        external_name: row.external_name,
        description: row.description,
        source: row.source,
        enabled: !!row.enabled,
        read_only: !!row.read_only,
        mcp_server_id: row.mcp_server_id,
      }));
    },
    setToolEnabled(id, enabled) {
      const row = sqlGet("SELECT * FROM tools WHERE id = ? OR name = ?", id, id);
      if (!row) return false;
      sqlRun("UPDATE tools SET enabled = ?, updated = ? WHERE id = ?", enabled ? 1 : 0, now(), row.id);
      logEvent("INFO", "tool_toggle", { tool: row.name, enabled: !!enabled });
      return true;
    },
    mcp() {
      return mcpList();
    },
    addMcp(input) {
      return mcpMasked(addMcp(input));
    },
    updateMcp(id, input) {
      const row = updateMcp(id, input);
      return row ? mcpMasked(row) : null;
    },
    deleteMcp,
    async connectMcp(id) {
      const row = mcpRow(id);
      if (!row) return { ok: false, error: "MCP server not found" };
      return connectMcp(row);
    },
    setMcpEnabled(id, enabled) {
      const row = mcpRow(id);
      if (!row) return false;
      sqlRun("UPDATE mcp_servers SET enabled = ?, updated = ? WHERE id = ?", enabled ? 1 : 0, now(), id);
      sqlRun("UPDATE tools SET enabled = ?, updated = ? WHERE source = 'mcp' AND mcp_server_id = ?", enabled ? 1 : 0, now(), id);
      logEvent("INFO", "mcp_toggle", { mcp: id, enabled: !!enabled });
      return true;
    },
    async refreshMcp(id) {
      const row = mcpRow(id);
      if (!row) return { ok: false, error: "MCP server not found" };
      return connectMcp(row);
    },
    sessions() {
      return listConversationsForActiveProject();
    },
    conversation(id) {
      return conversationPayload(id);
    },
    deleteConversation(id) {
      const row = conversationRow(id);
      if (!row) return false;
      if (running.has(id)) running.get(id).abort();
      running.delete(id);
      sqlRun("DELETE FROM messages WHERE conversation_id = ?", id);
      sqlRun("DELETE FROM session_metrics WHERE conversation_id = ?", id);
      sqlRun("DELETE FROM undo_stack WHERE conversation_id = ?", id);
      sqlRun("DELETE FROM conversations WHERE id = ?", id);
      sqlRun("DELETE FROM sessions WHERE id = ?", id);
      if (getSetting("active_conversation", null) === id) setSetting("active_conversation", null);
      logEvent("INFO", "conversation_deleted", { conversation: id });
      return true;
    },
    async runTool(name, input) {
      const project = activeProject();
      if (!project) throw new Error("no active project");
      return executeTool(name, input || {}, {
        project,
        conversationId: getSetting("active_conversation", ""),
        mode: "build",
      });
    },
    projects() {
      return projectListAll();
    },
    createProject(input) {
      return createProject(input);
    },
    activateProject(id) {
      return activateProject(id);
    },
    closeProject(id) {
      return closeProject(id);
    },
    deleteProject(id) {
      return deleteProject(id);
    },
    metrics() {
      return { totals: usageTotals(), sessions: sessionMetricRows(200), requests: requestLogRows(300) };
    },
    async chatProvider(input) {
      const id = String(input.provider_id || input.id || "");
      const row = providerRow(id);
      if (!row) throw new Error("provider not found: " + id);
      const models = parseJson(row.models_json, {});
      const model = String(input.model || row.default_model || Object.keys(models)[0] || "");
      if (!model) throw new Error("provider has no model: " + id);
      const started = now();
      const result = await providerChat(
        row,
        {
          model,
          messages: [{ role: "user", content: String(input.message || "Reply with the single word: ok") }],
          max_tokens: Math.max(8, Math.min(512, asInt(input.max_tokens, 64))),
          temperature: 0,
        },
        AbortSignal.timeout(Math.max(5000, Math.min(180000, asInt(input.timeout_ms, 90000)))),
      );
      const message = result.message || {};
      logEvent("INFO", "provider_chat", {
        provider: id,
        model,
        ms: now() - started,
        content_chars: String(message.content || "").length,
      });
      return {
        ok: true,
        provider: id,
        model,
        ms: now() - started,
        content: message.content == null ? "" : String(message.content),
        reasoning: message.reasoning_content || message.reasoning || "",
        usage: result.usage || {},
      };
    },
    requests() {
      return requestLogRows(500);
    },
    async runTask(input) {
      const projectId = String(input.project_id || "").trim();
      if (projectId) activateProject(projectId);
      const project = activeProject();
      if (!project) throw new Error("no active project");
      const message = clampText(input.message || "", 40000).trim();
      if (!message) throw new Error("message is required");
      const providerId = String(input.provider || "ollama");
      const provider = providerRow(providerId);
      if (!provider) throw new Error("provider not found: " + providerId);
      const models = parseJson(provider.models_json, {});
      const model = String(input.model || provider.default_model || Object.keys(models)[0] || "");
      if (!model) throw new Error("provider has no model: " + providerId);
      if (Array.isArray(input.enable_tools)) {
        for (const name of input.enable_tools) {
          sqlRun("UPDATE tools SET enabled = 1, updated = ? WHERE name = ?", now(), String(name));
        }
      }
      const conversationId = createConversation({
        project,
        provider: providerId,
        model,
        mode: input.mode === "plan" ? "plan" : "build",
        title: titleFrom(message),
      });
      logEvent("INFO", "agent_task_started", {
        conversation: conversationId,
        project: project.id,
        provider: providerId,
        model,
      });
      const result = await runAgent(conversationId, message);
      const metrics = sqlGet("SELECT * FROM session_metrics WHERE conversation_id = ?", conversationId);
      logEvent(result.ok ? "INFO" : "ERROR", "agent_task_finished", {
        conversation: conversationId,
        ok: !!result.ok,
        tool_calls: result.tool_calls || 0,
        iterations: result.iterations || 0,
      });
      return {
        ok: !!result.ok,
        conversation_id: conversationId,
        project: { id: project.id, name: project.name, path: project.path },
        provider: providerId,
        model,
        result,
        metrics,
        conversation: conversationPayload(conversationId),
      };
    },
  };
}

const admin = require("./admin.js").create(adminCore());

// ═════════════════════════════════════════════════════════════
// Request dispatch
// ═════════════════════════════════════════════════════════════
async function handleFrontendAction(req, res, url) {
  const action = String(url.searchParams.get("action") || "").trim();
  const body = req.method === "POST" ? await readBody(req) : Object.fromEntries(url.searchParams);
  requestProjectId(url, body);
  if (!checkCsrf(body, url)) {
    return json(res, 403, { success: false, error: "invalid csrf token" });
  }
  const conv = activeConversation();

  switch (action) {
    case "status":
      return json(res, 200, {
        session: sessionForResponse(),
        providers: providerList(),
        favorite_models: favoriteModels(),
        model_info: modelInfo(),
        running_conversations: [...running.keys()],
        lock: { locked: running.size > 0 },
      });
    case "providers":
      return json(res, 200, providerList());
    case "settings_load":
      return json(res, 200, { favorite_models: favoriteModels(), permissions: permissionsMap() });
    case "settings_save": {
      const saved = saveProvider(body);
      return json(res, 200, { success: true, provider: saved });
    }
    case "settings_delete":
      deleteProvider(String(body.provider_id || ""));
      return json(res, 200, { success: true });
    case "test_connection": {
      let row = providerRow(String(body.provider_id || ""));
      if (!row) {
        saveProvider(body);
        row = providerRow(String(body.provider_id || ""));
      }
      if (!row) return json(res, 200, { success: false, error: "provider not found" });
      const result = await testProvider(row, body.model);
      return json(res, 200, result.ok ? { success: true, models: result.models } : { success: false, error: result.error });
    }
    case "start": {
      const provider = String(body.provider || "");
      const model = String(body.model || "");
      const mode = String(body.mode || "build");
      setSetting("provider", provider);
      setSetting("model", model);
      setSetting("mode", mode);
      if (conv && !running.has(conv.id)) updateSessionFields(conv.id, { provider, model, mode });
      return json(res, 200, { success: true, provider, model, mode });
    }
    case "new_session": {
      const id = createConversation({
        provider: getSetting("provider", ""),
        model: getSetting("model", ""),
        mode: getSetting("mode", "build"),
      });
      return json(res, 200, { id });
    }
    case "conversations":
      return json(res, 200, listConversationsForActiveProject());
    case "conversation": {
      const id = String(body.conversation_id || url.searchParams.get("conversation_id") || "");
      const payload = conversationPayload(id);
      if (!payload) return json(res, 200, { messages: [] });
      setSetting("active_conversation", id);
      return json(res, 200, payload);
    }
    case "switch_conversation": {
      const id = String(body.conversation_id || "");
      if (conversationRow(id)) setSetting("active_conversation", id);
      return json(res, 200, { success: !!conversationRow(id) });
    }
    case "delete_conversation": {
      const id = String(body.conversation_id || "");
      return json(res, 200, { success: adminCore().deleteConversation(id) });
    }
    case "rename_conversation": {
      const id = String(body.conversation_id || "");
      if (!conversationRow(id)) return json(res, 200, { success: false, error: "not found" });
      updateSessionFields(id, { title: clampText(body.title || "Untitled", 200) });
      return json(res, 200, { success: true });
    }
    case "set_mode": {
      const mode = body.mode === "plan" ? "plan" : "build";
      setSetting("mode", mode);
      if (conv && !running.has(conv.id)) updateSessionFields(conv.id, { mode });
      return json(res, 200, { success: true, mode });
    }
    case "clear": {
      if (conv) sqlRun("DELETE FROM messages WHERE conversation_id = ?", conv.id);
      return json(res, 200, { success: true, messages: [] });
    }
    case "compact": {
      if (!conv) return json(res, 200, { success: false, error: "no conversation" });
      return json(res, 200, compactConversation(conv.id, body.keep_last_n));
    }
    case "undo": {
      if (!conv) return json(res, 200, { success: false, error: "no conversation" });
      return json(res, 200, undoConversation(conv.id, String(body.message_id || "")));
    }
    case "redo": {
      if (!conv) return json(res, 200, { success: false, error: "no conversation" });
      return json(res, 200, redoConversation(conv.id));
    }
    case "fork": {
      if (!conv) return json(res, 200, { success: false, error: "no conversation" });
      return json(res, 200, forkConversation(conv.id, String(body.message_id || "")));
    }
    case "regenerate": {
      if (!conv) return json(res, 200, { success: false, error: "no conversation" });
      return json(res, 200, regenerateLast(conv.id));
    }
    case "abort": {
      if (conv && running.has(conv.id)) running.get(conv.id).abort();
      return json(res, 200, { success: true });
    }
    case "force_unlock": {
      for (const controller of running.values()) controller.abort();
      running.clear();
      sqlRun("UPDATE sessions SET running = 0, last_status = 'idle'");
      return json(res, 200, { success: true });
    }
    case "favorite_model":
      sqlRun("INSERT OR IGNORE INTO favorites (model_id, created) VALUES (?, ?)", String(body.model_id || ""), now());
      return json(res, 200, { success: true });
    case "unfavorite_model":
      sqlRun("DELETE FROM favorites WHERE model_id = ?", String(body.model_id || ""));
      return json(res, 200, { success: true });
    case "toggle_permission":
      sqlRun(
        "INSERT INTO permissions (key, value, updated) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated",
        String(body.permission || ""),
        String(body.value || ""),
        now(),
      );
      return json(res, 200, { success: true });
    case "project_info":
      return json(res, 200, projectInfo());
    case "projects_list":
      return json(res, 200, projectList());
    case "projects_wordpress":
      return json(res, 200, []);
    case "projects_create":
      try {
        return json(res, 200, createProject(body));
      } catch (error) {
        return json(res, 200, { error: compactError(error) });
      }
    case "projects_close":
      return json(res, 200, { success: closeProject(String(body.project_id || "")) });
    case "projects_delete":
      return json(res, 200, { success: deleteProject(String(body.project_id || "")) });
    case "file_tree":
      return json(res, 200, fileTree({ path: body.path || url.searchParams.get("path") || "/" }));
    case "read_file":
    case "resolve_file":
      return json(res, 200, readProjectFile({ path: body.path || url.searchParams.get("path") || "" }));
    case "shell": {
      const project = activeProject();
      if (!project) return json(res, 200, { output: "", error: "no active project", returncode: 1 });
      const result = await runShell(String(body.command || ""), project.path);
      return json(res, 200, {
        output: clampText(result.stdout + (result.stderr ? "\n" + result.stderr : ""), EXEC_MAX_BUFFER),
        error: result.stderr,
        returncode: result.code,
      });
    }
    case "changes":
      return json(res, 200, changesForProject());
    case "diff":
      return json(res, 200, diffSnapshot(String(body.id || "")));
    case "restore":
      return json(res, 200, restoreSnapshot(String(body.id || "")));
    case "bootstrap_get":
    case "bootstrap_save":
    case "bootstrap_clear":
    case "state_get":
    case "state_save":
    case "state_clear":
    case "memory_get":
    case "memory_save":
    case "memory_clear":
      return json(res, 200, contextAction(action, body));
    default:
      return json(res, 200, { success: false, error: "unknown frontend action: " + action });
  }
}

async function handleFrontendStream(req, res) {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return json(res, error.status || 400, { ok: false, error: compactError(error) });
  }
  if (!checkCsrf(body, new URL(req.url, "http://localhost"))) {
    sseStart(res);
    sse(res, { _event: "error", message: "invalid csrf token" });
    return res.end();
  }
  let conv = ensureConversation(body, new URL(req.url, "http://localhost"));
  if (!conv) conv = conversationRow(createConversation({}));
  const content = String(body.content || "");
  if (!content.trim()) {
    sseStart(res);
    sse(res, { _event: "error", conversation_id: conv.id, message: "empty input" });
    return res.end();
  }
  sseStart(res);
  const emit = (event) => sse(res, event);
  req.on("close", () => {
    if (running.has(conv.id)) running.get(conv.id).abort();
  });
  try {
    await runAgent(conv.id, content, emit);
  } catch (error) {
    sse(res, { _event: "error", conversation_id: conv.id, message: compactError(error) });
  }
  if (!res.writableEnded) res.end();
}

// ═════════════════════════════════════════════════════════════
// Server
// ═════════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const started = now();
  const requestId = randomId("req_");
  const url = new URL(req.url || "/", "http://localhost");
  const route = url.pathname.replace(/\/+$/, "") || "/";
  res.setHeader("X-Request-Id", requestId);
  for (const [key, value] of Object.entries(brandingHeaders())) res.setHeader(key, value);
  res.on("finish", () => {
    const safeQuery = new URLSearchParams(url.searchParams);
    for (const key of [...safeQuery.keys()]) {
      if (/(token|key|secret|password|authorization)/i.test(key)) safeQuery.set(key, "***");
    }
    const conversationId =
      String(url.searchParams.get("conversation_id") || "") ||
      String(getSetting("active_conversation", "") || "");
    const projectId = String(url.searchParams.get("project_id") || "") || (activeProject() ? activeProject().id : "");
    requestLog({
      request_id: requestId,
      method: req.method || "GET",
      route,
      action: String(url.searchParams.get("action") || ""),
      status: res.statusCode,
      duration_ms: now() - started,
      ip: String(req.socket.remoteAddress || "").replace(/^::ffff:/, ""),
      user_agent: String(req.headers["user-agent"] || ""),
      query: safeQuery.toString(),
      project_id: projectId,
      conversation_id: conversationId,
      provider: String(getSetting("provider", "") || ""),
      model: String(getSetting("model", "") || ""),
      bytes: Number(res.getHeader("content-length") || 0),
      is_admin: route.startsWith("/api/admin"),
    });
  });
  if (req.method === "OPTIONS") return json(res, 204, {});
  try {
    if (route === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }

    if (route === "/health") {
      return json(res, 200, {
        ok: true,
        service: "zc-runtime",
        version: VERSION,
        storage: "sqlite",
        node: process.version,
        uptime_sec: Math.round((now() - STARTED) / 1000),
        php: NO_PHP ? "disabled" : "http://" + PHP_HOST + ":" + PHP_PORT + "/",
      });
    }

    if (route === "/api/bootstrap") {
      if (!authorizedProxy(req)) return json(res, 401, { error: "proxy token required" });
      const requestedProject = url.searchParams.get("project_id");
      if (requestedProject) requestProjectId(url, {});
      const project = activeProject();
      const identity = identityPayload();
      let csrf = getSetting("csrf", "");
      if (!csrf) {
        csrf = crypto.randomBytes(18).toString("hex");
        setSetting("csrf", csrf);
      }
      return json(res, 200, {
        service: "zc-runtime",
        version: VERSION,
        workspace: WORKSPACE,
        project: project ? { id: project.id, name: project.name, path: project.path, type: project.type } : null,
        identity: {
          name: identity.name,
          owner: identity.owner,
          source: identity.source,
          version: identity.version,
          tagline: identity.tagline,
          powered_by_header: identity.powered_by_header,
          branding: identity.branding,
          contact: identity.contact,
        },
        csrf,
        active_conversation: getSetting("active_conversation", null),
        providers: providerList().map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
        node_url: "http://" + HOST + ":" + PORT,
        php_url: "http://" + PHP_HOST + ":" + PHP_PORT + "/index.php",
      });
    }

    if (route === "/api/identity" && req.method === "GET") {
      return json(res, 200, { ok: true, identity: identityPayload() });
    }

    if (route === "/admin" || route === "/admin/") {
      const html = admin.page();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(html);
    }

    if (route === "/admin.js" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return res.end(admin.clientScript());
    }

    if (route === "/" && req.method === "GET") {
      res.writeHead(302, { Location: "/admin" });
      return res.end();
    }

    if (route.startsWith("/api/admin")) {
      if (!authorizedAdmin(req)) return json(res, 401, { error: "admin token required" });
      return await admin.handle(req, res, url);
    }

    if (route === "/frontend/action") {
      if (!authorizedProxy(req)) return json(res, 401, { error: "proxy token required" });
      return await handleFrontendAction(req, res, url);
    }

    if (route === "/frontend/stream") {
      if (!authorizedProxy(req)) return json(res, 401, { error: "proxy token required" });
      return await handleFrontendStream(req, res);
    }

    if (route === "/v1/models") {
      const data = [];
      for (const p of providerList()) {
        if (!p.connected) continue;
        for (const id of Object.keys(p.models)) data.push({ id: p.id + "/" + id, object: "model", owned_by: p.id });
      }
      return json(res, 200, { object: "list", data });
    }

    if (route === "/v1/chat/completions") {
      return json(res, 501, {
        ok: false,
        error: {
          code: "use_frontend",
          message: "Use the Code with AI frontend or admin; this contract is not a model host.",
        },
      });
    }

    return json(res, 404, { ok: false, error: "no route: " + req.method + " " + route });
  } catch (error) {
    logEvent("ERROR", "request_failed", { route, error: compactError(error) });
    return json(res, error.status || 500, { ok: false, error: compactError(error) });
  }
});

// ═════════════════════════════════════════════════════════════
// PHP child process
// ═════════════════════════════════════════════════════════════
let phpChild = null;

function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host, port });
      socket.setTimeout(400);
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      const fail = () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 120);
      };
      socket.on("error", fail);
      socket.on("timeout", fail);
    };
    attempt();
  });
}

async function startPhp() {
  if (NO_PHP) return false;
  const phpBin = process.env.PHP_BIN || "php";
  const probe = spawnSync(phpBin, ["-v"], { encoding: "utf8" });
  if (probe.status !== 0) {
    logEvent("WARN", "php_missing", { bin: phpBin, error: compactError(probe.error || probe.stderr) });
    return false;
  }
  const router = path.join(APP_DIR, "index.php");
  if (!fs.existsSync(router)) {
    logEvent("WARN", "php_router_missing", { router });
    return false;
  }
  const env = {
    ...process.env,
    ZC_NODE_URL: "http://" + HOST + ":" + PORT,
    ZC_PROXY_TOKEN: PROXY_TOKEN,
    ZC_WORKSPACE: WORKSPACE,
    ZC_PHP_PORT: String(PHP_PORT),
    ZC_NODE_HOST: HOST,
    ZC_NODE_PORT: String(PORT),
  };
  phpChild = spawn(
    phpBin,
    ["-S", PHP_HOST + ":" + PHP_PORT, "-t", APP_DIR, router],
    { cwd: WORKSPACE, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  phpChild.stdout.on("data", (data) => {
    const line = data.toString().trim();
    if (line) logEvent("INFO", "php", { line });
  });
  phpChild.stderr.on("data", (data) => {
    const line = data.toString().trim();
    if (!line) return;
    const access = /Accepted|Closing|Closed without|Development Server|started/.test(line);
    logEvent(access ? "INFO" : "ERROR", access ? "php_access" : "php", { line });
  });
  phpChild.on("exit", (code, signal) => {
    logEvent("WARN", "php_exit", { code, signal });
    phpChild = null;
  });
  const ready = await waitForPort(PHP_HOST, PHP_PORT, 4000);
  logEvent(ready ? "INFO" : "WARN", "php_started", {
    ready,
    url: "http://" + PHP_HOST + ":" + PHP_PORT + "/index.php",
  });
  return ready;
}

function shutdown(signal) {
  logEvent("INFO", "shutdown", { signal });
  if (phpChild) {
    try {
      phpChild.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  server.close(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
server.on("error", (error) => {
  logEvent("ERROR", "listen_failed", { error: compactError(error) });
  process.exit(1);
});

async function main() {
  server.listen(PORT, HOST, async () => {
    logEvent("INFO", "listening", {
      url: "http://" + HOST + ":" + PORT,
      admin: "http://" + HOST + ":" + PORT + "/admin",
      storage: "sqlite",
      db: DB_PATH,
      projects_dir: PROJECTS_DIR,
      env_files: ENV_FILES,
      admin_auth: ADMIN_AUTH_ENABLED ? "token" : "disabled",
      node: process.version,
      php: NO_PHP ? "disabled" : "starting",
    });
    await startPhp();
    if (!ADMIN_AUTH_ENABLED) {
      logEvent("WARN", "admin_auth_disabled", { hint: "ADMIN_TOKEN_ENABLED=false allows every caller" });
    }
    // Provider and MCP discovery is best effort and never blocks startup.
    for (const id of ["ollama", "infinite", "custom:nvidia"]) {
      const row = providerRow(id);
      if (!row) continue;
      testProvider(row).catch((error) => {
        logEvent("WARN", "provider_refresh_failed", { provider: id, error: compactError(error) });
      });
    }
    if (ENV_MCP_ID && String(process.env.IEZ_MCP_CONNECT || "true") !== "false") {
      const row = mcpRow(ENV_MCP_ID);
      if (row) {
        connectMcp(row)
          .then((result) => logEvent(result.ok ? "INFO" : "WARN", "mcp_env_probe", {
            mcp: row.id,
            ok: !!result.ok,
            tools: (result.tools || []).length,
            error: result.error || "",
          }))
          .catch((error) => logEvent("WARN", "mcp_env_probe_failed", { mcp: row.id, error: compactError(error) }));
      }
    }
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  server,
  db,
  core: adminCore(),
  admin,
  runAgent,
  executeTool,
  providerChat,
  createConversation,
  appendMessage,
  conversationPayload,
  activeProject,
  startPhp,
  shutdown,
  config: {
    PORT,
    HOST,
    PHP_PORT,
    WORKSPACE,
    DATA_DIR,
    DB_PATH,
    PROJECTS_DIR,
    ENV_FILES,
    PROXY_TOKEN,
    VERSION,
    ADMIN_AUTH_ENABLED,
    SYSTEM_IDENTITY,
  },
};
