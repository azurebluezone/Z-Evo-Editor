# RUNBOOK — ZombieCoder Runtime (Z-Evo-Editor)

> এই ডকুমেন্ট নতুন সেশনের প্রথম পড়া। এখানে উদ্দেশ্য, বর্তমান অবস্থা, যা যাচাই হয়েছে, যা হয়নি, এবং পরের কাজের ক্রম আছে। অনুমান নয়—যা চালিয়ে দেখা হয়েছে সেটাই লেখা।

---

## ০. এক নজরে

আমরা একটি স্বাধীন, self-hosted coding-agent runtime বানাচ্ছি। PHP ফ্রন্টএন্ড আগের Softaculous UI চুক্তিতে চলবে; Node runtime প্রোভাইডার, SQLite, MCP, টুল, সেশন, মেট্রিক্স ও অ্যাডমিনের একমাত্র কর্তৃপক্ষ।

বর্তমান অবস্থা: **লোকাল ফাইল লেখা Ollama দিয়ে কাজ করছে**। InfiniteEarningZone ও NVIDIA-তে চ্যাট কাজ করছে। MCP হ্যান্ডশেক কাজ করছে। Gemini/অন্য কিছু প্রোভাইডার সংযুক্ত, কিন্তু বাস্তবে ফাইল লিখতে পারে—এটা এখনো প্রমাণিত নয়।

---

## ১. মূল লক্ষ্য (North Star)

একটি এমন runtime, যেখানে:

1. যেকোনো OpenAI-compatible প্রোভাইডার যোগ করা যায়—কোড বদল ছাড়া।
2. এজেন্ট নির্দিষ্ট working directory-এর ভিতরে ফাইল পড়তে, লিখতে, এডিট করতে এবং কমান্ড চালাতে পারে।
3. প্রতিটি রিকোয়েস্ট, সেশন, টুল কল, টোকেন ও ফলাফল SQLite-এ থাকে; অ্যাডমিনে দেখা যায়।
4. MCP সার্ভার যোগ/কানেক্ট/বন্ধ করা যায়; টুলগুলো এজেন্টের কনটেক্সট নিয়ন্ত্রণ করে।
5. PHP ফ্রন্টএন্ড ও অ্যাডমিন UI একই সত্য দেখে—দুই রকম response নয়।
6. কোনো প্রোভাইডার বা MCP বন্ধ হলে বাকি সিস্টেম থামে না।
7. মিথ্যা সাফল্য নেই: ফাইল তৈরি না হলে "হয়েছে" বলা যাবে না।

---

## ২. যা এখন তৈরি

### ২.১ রানটাইম

- `php/server/server.js` — Node runtime:
  - env loader (`.env` → process env)
  - SQLite schema, seed, migrations
  - provider gateway (OpenAI-compatible)
  - MCP JSON-RPC client
  - session/conversation/message store
  - agent tool loop
  - request log + session metrics
  - admin API core
  - PHP child process spawn
- `php/server/admin.js` — admin HTML + `/api/admin/*`
- `php/app/index.php` — PHP front controller + Node proxy
- `php/app/index.live.php` — পুরোনো UI snapshot (অপরিবর্তিত)
- `php/server/.env.example` — নিরাপদ env টেমপ্লেট
- `php/data/zc.sqlite` — runtime DB (git-এ নেই)
- `php/workspaces/` — নতুন প্রজেক্টের working directory (git-এ নেই)

### ২.২ ডাটাবেজ

`php/data/zc.sqlite` (WAL, `0600`)-এ টেবিল:

`identities`, `system_prompts`, `providers`, `tools`, `mcp_servers`, `mcp_sessions`, `projects`, `sessions`, `conversations`, `messages`, `session_metrics`, `request_log`, `env_import`, `snapshots`, `favorites`, `permissions`, `project_contexts`, `runtime_log`।

### ২.৩ অ্যাডমিন

- Overview: identity, project, env sync, counters
- Projects & Agent: প্রজেক্ট তৈরি, working directory, activate/close/delete, provider/model বেছে টাস্ক চালানো
- Metrics: run totals, provider totals, session runs, request log
- Identity & Prompt
- Providers: add/update/test/chat/delete; `supports_tools` ফ্ল্যাগ
- Tools: enable/disable, direct run
- MCP: add/connect/enable/refresh/delete
- Sessions ও Logs

### ২.৪ হেডার ও আইডেন্টিটি

প্রতিটি HTTP রেসপন্সে:

```text
X-Powered-By: ZombieCoder-by-SahonSrabon
X-System-Identity: ZombieCoder
X-System-Version: 1.0.0
X-System-Owner: Sahon Srabon
X-System-Website: https://zombiecoder.my.id/
X-Request-Id: req_...
```

প্রোভাইডারে `X-ZC-Identity` (base64url JSON), `X-ZC-Project`, `X-ZC-Session`, `X-ZC-Conversation` যায়।

### ২.৫ লগ

- `request_log`: method, route, action, status, duration, IP, User-Agent, redacted query, project, conversation, provider, model, bytes, admin flag
- `session_metrics`: conversation, provider, model, iterations, tool_calls, tool_errors, message_count, prompt/completion/cached/total tokens, duration, status, error
- `runtime_log`: event-level log
- `php/data/zc.log`: JSON lines

---

## ৩. যা বাস্তবে যাচাই হয়েছে

### ৩.১ InfiniteEarningZone

```text
GET https://api.infiniteearningzone.com/v1/models
→ 200, 10 models
```

`POST /api/admin/providers/chat`:

```json
{"provider_id":"infinite","model":"mission","message":"Reply with exactly: PONG","max_tokens":32}
```

ফল:

```text
content=PONG, ms=3580, total_tokens=15
```

সতর্কতা: এই alias-গুলো `mission-barisal`-এর agent endpoint। `/providers/chat` কাজ করে, কিন্তু full runtime prompt + stream পাথে ৯০ সেকেন্ডে শেষ হয়নি। তাই `supports_tools=false` এবং লোকাল টুল লুপে ব্যবহার করা হয় না।

### ৩.২ NVIDIA

```text
GET https://integrate.api.nvidia.com/v1/models
→ 200, 32 models
```

`custom:nvidia` / `meta/muse-glimmer-30b`:

```text
max_tokens=64  → content খালি, শুধু reasoning
max_tokens=512 → content=PONG, ms=21364, total_tokens=146
```

অর্থাৎ মডেল কল কাজ করে; reasoning মডেলে content পেতে যথেষ্ট token budget দরকার।

### ৩.৩ MCP

```text
POST https://api.infiniteearningzone.com/mcp
initialize → 200, protocol 2025-06-18, server mission-barisal
tools/list → 101 tools
```

SQLite-এ `mcp_servers.status=connected`, `protocol_version=2025-06-18`, `session_id` সংরক্ষিত। ডিফল্টে `IEZ_MCP_ENABLED=false`; ১০১টি টুল ডাটাবেজে আছে কিন্তু এজেন্টের সক্রিয় টুল লিস্টে যায় না।

### ৩.৪ অ্যাডমিন টোকেন

```text
ADMIN_TOKEN_ENABLED=true  → token ছাড়া 401, token দিয়ে 200
ADMIN_TOKEN_ENABLED=false → token ছাড়া 200
```

টোকেন শুধু env থেকে পড়া হয়; DB-তে রাখা হয় না।

### ৩.৫ PHP → Node প্যারামিটার

`http://127.0.0.1:8788/index.php`-এ served HTML-এর `window.__ZC_BOOTSTRAP__`-এ আছে:

```json
{
  "node_url": "http://127.0.0.1:8787",
  "workspace": "/home/sahon/Downloads/skil/ai",
  "project_id": "proj_...",
  "project_path": "...",
  "identity": {"name":"ZombieCoder","owner":"Sahon Srabon","version":"1.0.0","branding":{},"contact":{}},
  "csrf": "...",
  "version": "2.0.0"
}
```

PHP দিয়ে `act=ai&ai_php_api=status` → 200; session/provider/model ফেরত।

### ৩.৬ বাস্তব এজেন্ট টাস্ক

Admin UI থেকে:

```text
Project: ZombieCoder Runtime
Working directory: php/workspaces/zombiecoder-runtime
Provider/model: ollama / qwen2.5:1.5b
Task: RUNTIME.md তৈরি করা, যাতে ZombieCoder 1.0.0, owner Sahon Srabon,
      API base URL https://api.infiniteearningzone.com/v1 থাকে
```

ফল:

```text
status=completed
iterations=2
tool_calls=1
tool_errors=0
total_tokens=1905
duration_ms=86261
messages: user, assistant(tool_call), tool(write_file), assistant
RUNTIME.md = 90 bytes
```

এটি শুধু UI মেসেজ নয়; SQLite-এ `role=tool`, `name=write_file`, `is_error=0` আছে।

প্রমাণ:

- `php/verification/11-admin-overview-runtime.png`
- `php/verification/12-admin-project-created.png`
- `php/verification/13-admin-agent-task.png`
- `php/verification/14-admin-metrics.png`
- `php/verification/15-admin-providers.png`
- `php/verification/16-admin-mcp.png`
- `php/verification/17-admin-sessions.png`
- `php/verification/runtime-ui-result.json`
- `php/verification/runtime-checks.json`

---

## ৪. যা এখনো যাচাই হয়নি / সীমা

### ৪.১ প্রোভাইডার execution matrix

| প্রোভাইডার | Chat | Tools | File write | Stream | মন্তব্য |
|---|---|---|---|---|---|
| Ollama `qwen2.5:1.5b` | হ্যাঁ | হ্যাঁ | হ্যাঁ | হ্যাঁ | আসল `RUNTIME.md` লেখা হয়েছে |
| InfiniteEarningZone `mission` | হ্যাঁ | না | না | না | alias নিজেই agent; full stream ৯০s-এ শেষ হয়নি |
| NVIDIA `meta/muse-glimmer-30b` | হ্যাঁ | যাচাই হয়নি | না | যাচাই হয়নি | reasoning মডেল; বেশি token দরকার |
| Gemini | সংযুক্ত | যাচাই হয়নি | **না** | যাচাই হয়নি | ফাইল লেখার路径 নেই/প্রমাণিত নয় |
| Groq | সংযুক্ত | যাচাই হয়নি | না | যাচাই হয়নি | আগের সেশনে chat হয়েছে |
| OpenCode Zen | সংযুক্ত | যাচাই হয়নি | না | যাচাই হয়নি | free limit 429 হতে পারে |

**পরের সেশনেই এটাই মূল কাজ:** শুধু "connected" দেখে সন্তুষ্ট না হয়ে প্রতিটি প্রোভাইডারের জন্য `chat`, `tools`, `file_write`, `stream` আলাদা করে প্রমাণ করা।

### ৪.২ Gemini ফাইল লেখে না

Gemini সংযুক্ত, কিন্তু বাস্তবে `write_file` টুল কল করে ফাইল লিখেছে—এমন প্রমাণ নেই। সম্ভাব্য কারণ:

- provider/model tool-call ফরম্যাট সমর্থন করে না
- আমাদের OpenAI-compatible adapter-এ tool schema/marker ঠিকভাবে যাচ্ছে না
- মডেল টেক্সটে ফাইল লিখে দেয়, কিন্তু structured `tool_calls` দেয় না

পরের কাজ: provider capability matrix + non-tool fallback (নিচে)।

### ৪.৩ InfiniteEarningZone full stream

Alias endpoint নিজের agent চালায়। আমাদের system prompt + tools + 90s timeout-এ শেষ হয়নি। তাই:

- `supports_tools=false`
- `/providers/chat` দিয়ে simple chat verified
- full agent stream-এ ব্যবহার করলে timeout হতে পারে

### ৪.৪ MCP টুল সংখ্যা

১০১টি টুল ডিফল্টে বন্ধ। ছোট মডেলের কনটেক্সটে এত টুল একসাথে গেলে QUALITY কমে। টুল-লেভেল পলিসি দরকার।

### ৪.৫ একাধিক ক্লায়েন্ট

একই SQLite-এ একাধিক ব্রাউজার একই active project/conversation শেয়ার করে। একটি ক্লায়েন্টের `start` অন্যটির session metadata বদলাতে পারে (running session-এ আমরা ব্লক করেছি, কিন্তু completed-এর পরে নয়)। মাল্টি-টেন্যান্ট নয়।

### ৪.৬ অ্যাডমিন auth

`ADMIN_TOKEN_ENABLED=false` মানে সব caller অনুমোদিত। `HOST=0.0.0.0` হলে বিপজ্জনক। প্রোডাকশনে `true` + strong token + TLS দরকার।

### ৪.৭ আরও

- API key at-rest encryption নেই; ফাইল permission `0600` ভরসা।
- Windows path/PHP spawn যাচাই হয়নি।
- বড় ফাইল/বড় কনটেক্সটে chunking/budget নেই।
- MCP OAuth/token refresh নেই।
- Frontend UI/UX আপডেট বাকি (ব্যবহারকারীর পরবর্তী চাহিদা)।

---

## ৫. ফাইল ম্যাপ

```text
README.md                         পাবলিক প্রজেক্ট README
php/
  README.md                       টেকনিক্যাল চুক্তি (বাংলা)
  RUNBOOK.md                      এই ফাইল
  VERIFICATION.md                 যাচাই প্রতিবেদন
  app/
    index.php                     PHP front controller + proxy
    index.live.php                UI snapshot
  server/
    server.js                     runtime (single source of truth)
    admin.js                      admin page + routes
    server.test.js                contract tests (ঐচ্ছিক)
    .env.example                  env template
  verification/
    11..17 *.png                  runtime screenshots
    runtime-ui-result.json        UI task result
    runtime-checks.json           API/MCP/DB checks
  data/                           SQLite + logs (git-এ নেই)
  workspaces/                     নতুন প্রজেক্ট (git-এ নেই)
ajax/                             UI static assets
```

---

## ৬. চালানো

```bash
cd php/server
node server.js
```

প্রত্যাশিত:

```text
listening http://127.0.0.1:8787
php_started http://127.0.0.1:8788/index.php
provider_test ollama ok
provider_test infinite ok
provider_test custom:nvidia ok
mcp_connected tools=101
```

- Admin: `http://127.0.0.1:8787/admin`
- Frontend: `http://127.0.0.1:8788/index.php`
- Health: `http://127.0.0.1:8787/health`

`ZC_NO_PHP=1` দিলে শুধু Node চলবে। আলাদা PHP সার্ভারে `ZC_NODE_URL`, `ZC_PROXY_TOKEN`, `ZC_WORKSPACE` একই রাখতে হবে।

---

## ৭. যাচাই করার নিয়ম (ডেমো নয়)

1. আগে `/health` ও `/api/admin/state` দেখুন।
2. প্রোভাইডার `/models` কল করুন।
3. `/api/admin/providers/chat` দিয়ে ছোট real chat করুন।
4. টুল-সহ execution দরকার হলে Ollama দিয়ে admin Projects & Agent ব্যবহার করুন।
5. ফাইল সত্যিই তৈরি হয়েছে কিনা `ls`/`cat` দিয়ে দেখুন।
6. SQLite-এ `messages` ও `session_metrics` মিলিয়ে দেখুন।
7. স্ক্রিনশট নিন; ব্রাউজার console-এ severe error আছে কিনা দেখুন।
8. "কাজ করেছে" বলার আগে—ফাইল, DB row, HTTP status—তিনটাই প্রমাণ রাখুন।

কোনো mock/demo টেস্টকে বাস্তব execution বলে দেখাবেন না।

---

## ৮. পরের সেশন কোথায় শুরু

### P0 — Provider capability matrix ও execution

প্রতিটি provider row-তে স্পষ্ট ফ্ল্যাগ:

```text
supports_chat, supports_tools, supports_file_write, supports_stream
```

- `supports_tools=false` হলে tools payload যাবে না (এখন `infinite`-তে আছে)।
- `supports_file_write=false` হলে UI-তে স্পষ্ট দেখাবে "chat only"।
- প্রমাণ ছাড়া কোনো ফ্ল্যাগ `true` নয়।

Acceptance:

- ৬টি প্রোভাইডারের একটি টেবিল, প্রতিটিতে chat/tools/file_write/stream-এর verified/unverified।
- যেগুলো verified, সেগুলোর জন্য reproducible command/doc।
- যেগুলো failed, সেগুলোর জন্য exact error।

### P1 — Gemini / non-tool model fallback

Gemini ফাইল লিখতে পারে না—এটাই এখন বড় গ্যাপ। অপশন:

1. **Native tool adapter** — Gemini/OpenAI ফরম্যাট ম্যাপিং ঠিক করা।
2. **Marker protocol** — মডেল টেক্সটে নির্দিষ্ট ব্লক দিলে runtime সেটা পার্স করে `write_file` চালাবে (OpenAI-compatible marker)।
3. **Chat-only mode** — যে মডেল টুল সমর্থন করে না, তাকে শুধু পরামর্শ/কোড দেওয়ার জন্য ব্যবহার করা; execution আলাদা tool-capable মডেলে।

Acceptance:

- Gemini দিয়ে একটি নির্দিষ্ট ফোল্ডারে বাস্তব ফাইল তৈরি।
- SQLite-এ `role=tool`, `name=write_file`, `is_error=0`।
- ফাইল content মিলিয়ে দেখা।

### P2 — UI/UX

- Admin: provider health/latency, capability badge, live event stream, bulk test।
- Frontend: model capability देखিয়ে tool-enabled/chat-only আলাদা করা।
- Error state: timeout, 429, no-key, MCP down—সব আলাদা মেসেজ।
- Mobile/compact layout।

### P3 — Tool policy / intent

- সব enabled টুল একসাথে না পাঠিয়ে intent অনুযায়ী subset।
- MCP ১০১ টুলের জন্য allowlist।
- ছোট মডেলের context budget।

### P4 — Session isolation

- প্রতি client/project-এ আলাদা active conversation।
- `start`/`set_mode` যেন অন্য running/completed session metadata না বদলায়।
- Admin-এ explicit project switch।

---

## ৯. পরিচালনার নিয়ম

1. **সত্য প্রথম।** ব্যর্থ হলে "ব্যর্থ" লিখুন; ব্যাখ্যা দিয়ে "সফল" বানাবেন না।
2. **ডেমো নয়।** আসল HTTP, আসল মডেল, আসল ফাইল, আসল DB।
3. **সিক্রেট নয়।** `.env`, `php/data`, `paten.md`, `.softaculous` git-এ যাবে না।
4. **কোডে বাংলা/ইমোজি নয়।** কমেন্ট শুধু "কেন" বলবে।
5. **এক সত্য।** একই কাজের দুই response format নয়।
6. **ছোট পরিবর্তন।** আগে পড়ুন, তারপর বদলান, তারপর যাচাই করুন।

---

## ১০. Handoff checklist

- [ ] `git status` clean
- [ ] `.env` ও `php/data` staged নয়
- [ ] `node --check php/server/server.js` pass
- [ ] `php -l php/app/index.php` pass
- [ ] `/health` 200
- [ ] `/api/admin/state` 200 (auth অনুযায়ী)
- [ ] Ollama real file write প্রমাণ
- [ ] provider chat প্রমাণ
- [ ] MCP handshake প্রমাণ
- [ ] স্ক্রিনশট/JSON আপডেট
- [ ] এই RUNBOOK-এ "যা হয়নি" আপডেট

শেষ কথা: এই সিস্টেমের মূল্য প্রোভাইডারের সংখ্যায় নয়—প্রমাণিত execution-এ। যতক্ষণ একটি মডেল নির্দিষ্ট ফোল্ডারে আসল ফাইল লিখতে না পারে, ততক্ষণ তাকে "execution-capable" বলা যাবে না।
