# যাচাই প্রতিবেদন — ২০২৬-১১-২৪

এই প্রতিবেদনে শুধু যা চালিয়ে দেখা হয়েছে তা লেখা আছে। কোনো পরিকল্পনা বা
অনুমানকে "সফল" বলা হয়নি। স্ক্রিনশট ও কাঁচা ফলাফল `php/verification/`-এ আছে।

## পরিবেশ

| উপাদান | মান |
|---|---|
| Node | `v24.22.2` |
| PHP | `8.4.27` (curl, PDO, mbstring) |
| SQLite | Node-এর `node:sqlite` (WAL) |
| ব্রাউজার | Playwright-bundled Chromium 1254, Selenium দিয়ে চালানো |
| লোকাল মডেল | Ollama `qwen2.5:1.5b` (`http://127.0.0.1:11434/v1`) |
| রিমোট প্রোভাইডার | জম্বি বিডি `.env` থেকে Groq ও OpenCode কী, শুধু পরীক্ষার সময় |
| MCP | স্থানীয় mock MCP (`initialize`, `tools/list`, `tools/call`) |

## ১. কোড-লেভেল টেস্ট

```bash
cd php/server
node --test server.test.js
```

ফলাফল: **৮টি টেস্ট, ৮টি pass, ০ fail**।

যা যাচাই হয়েছে:

- startup-এ প্রয়োজনীয় টেবিল ও seed তৈরি
- অ্যাডমিন state-এ API key ফাঁস হয় না
- অ্যাডমিন provider/tool/MCP রুট HTTP-তে উত্তর দেয়
- ফ্রন্টএন্ড `settings_save` দিয়ে কাস্টম প্রোভাইডার যোগ/ডিলিট
- `/frontend/stream` SSE-তে `tool-call`, `tool-result`, `done`
- এজেন্ট লুপে টুল চালিয়ে মেসেজ সংরক্ষণ
- `../../etc/passwd` ধরনের path traversal ব্লক
- `write_file` snapshot, diff ও পরিবর্তন সংরক্ষণ

## ২. বাস্তব ব্রাউজার — Selenium

স্ক্রিপ্ট: `php/verification/selenium-result.json` (কাঁচা ফলাফল)।

**১৩টি ধাপ, ১৩টি pass; ব্রাউজার কনসোলে কোনো SEVERE error নেই।**

| ধাপ | ফল |
|---|---|
| অ্যাডমিন ওভারভিউ | `v2.0.0`, SQLite state দেখা গেছে |
| Providers টেবিল | ১৩টি প্রোভাইডার |
| Tools টেবিল | ৯টি বিল্ট-ইন টুল |
| `write_file` টগল | অ্যাডমিন থেকে on → off |
| MCP যোগ | `Verification MCP` যোগ হয়ে `connected`, ১টি টুল |
| ফ্রন্টএন্ড | ১১৯টি মডেল-row লোড |
| মডেল নির্বাচন | `ollama/qwen2.5:1.5b` |
| টুল কার্ড | `list_files` দেখা গেছে |
| উত্তর | `.softaculous`, `ajax`, `php` — তিনটি ডিরেক্টরি |
| টুল স্ট্যাটাস | `running...` নয়, `done` |
| অ্যাডমিন সেশন/লগ | শেষ সেশন ও রানটাইম লগ দেখা গেছে |
| DB রেকর্ড | `role=tool`, `name=list_files`, `is_error=0` |

স্ক্রিনশট:

| ফাইল | কী দেখায় |
|---|---|
| `01-admin-overview.png` | আইডেন্টিটি, প্রজেক্ট, কাউন্ট |
| `02-admin-providers.png` | প্রোভাইডার তালিকা ও কী-মাস্ক |
| `03-admin-tool-enabled.png` | `write_file` অ্যাডমিন থেকে চালু |
| `04-admin-mcp.png` | MCP যোগ, connected, session id, ১টি টুল |
| `05-admin-sessions-before.png` | শুরুর সেশন তালিকা |
| `06-frontend-loaded.png` | PHP ফ্রন্টএন্ড ও মডেল ড্রপডাউন |
| `07-frontend-tool-running.png` | টুল চলার সময়ের কার্ড |
| `08-frontend-tool-complete.png` | `done` + তিনটি ডিরেক্টরি |
| `09-admin-sessions-after.png` | সেশন ও মেসেজ কাউন্ট |
| `10-admin-logs.png` | `agent_done`, request লগ |

## ৩. লোকাল Ollama — আসল টুল এক্সিকিউশন

পাঠানো অনুরোধ: `Call the list_files tool with path / ... Do not guess.`

SSE-তে যে ক্রম এসেছে:

```text
title
iteration-start
tool-call      name=list_files input={"path":"/"}
tool-result    output={"directories":[".softaculous","ajax","php"], ...}
iteration-start
text-delta     "The three top-level directories are: ..."
usage
done           tool_calls=1 iterations=2 provider=ollama model=qwen2.5:1.5b
```

SQLite-এ `messages` টেবিলে `role=tool`, `name=list_files`, `is_error=0`
এবং পুরো JSON আউটপুট সংরক্ষিত হয়েছে। অর্থাৎ UI-তে যেটা দেখা গেছে, DB-তেও
সেটাই আছে; শুধু স্ক্রিনশট নয়।

## ৪. রিমোট প্রোভাইডার

জম্বি বিডি `.env`-এর কী শুধু রানটাইম DB-তে ইমপোর্ট করা হয়েছে; ডকুমেন্টে
কোনো কী নেই।

- Groq: `GET /models` সফল, তারপর `openai/gpt-oss-20b`-এ আসল chat —
  `text-delta: "remote"`, `done`, provider `groq`।
- OpenCode Zen: `GET /models` সফল; ফ্রি মডেলে chat 429
  `FreeUsageLimitError` ফেরত দিয়েছে। সার্ভার সেটাই `error` ইভেন্টে দেখিয়েছে,
  ভুয়া উত্তর বানায়নি।
- NVIDIA custom provider: `GET /models` সফল।
- `custom:zombie-gateway`: Cloudflare 530; সার্ভার সৎভাবে error দেখিয়েছে।

## ৫. MCP

স্থানীয় mock MCP-তে:

```text
POST /api/admin/mcp            -> server id
POST /api/admin/mcp/:id/connect -> connected, tools=1, protocol=2025-06-18
tools টেবিলে                   mcp__<server>__echo, enabled=1
tools/call echo {text:"hello mcp"} -> "mcp-echo:hello mcp"
```

অ্যাডমিন থেকে MCP যোগ, কানেক্ট, টগল, রিফ্রেশ ও ডিলিট—সব রুট আছে।
`mcp_sessions`-এ `session_id` রাখা হয়েছে।

## ৬. ডিফল্ট চালু (কোনো DATA_DIR ছাড়া)

```bash
cd php/server
node server.js
```

- `php/data/zc.sqlite` তৈরি হয়েছে, `0600` মোড
- `/health` → `{"ok":true,"storage":"sqlite"}`
- `/admin` → 200
- PHP `/index.php` → 200
- Ollama মডেল লিস্ট রিফ্রেশ হয়েছে

যাচাই শেষে `php/data`-র DB ও লগ মুছে দেওয়া হয়েছে, যাতে জম্বি বিডি কী
ডেলিভারেবল ফাইলে না থাকে। পরের `node server.js` আবার DB তৈরি করবে এবং
প্রয়োজন হলে `.env` থেকে ইমপোর্ট করবে।

## ৭. যা এখনও যাচাই হয়নি

- প্রোডাকশন MCP সার্ভারের OAuth/টোকেন রিফ্রেশ ও TLS
- একাধিক ব্যবহারকারী/প্রজেক্টের আলাদা অথেন্টিকেশন
- মোবাইল ব্রাউজার ও ছোট স্ক্রিন
- বড় ফাইল/বড় কনটেক্সটে টোকেন বাজেট
- Windows-এ PHP spawn ও path behaviour
- API key at-rest encryption (এখন ফাইল permission `0600`)

## ৮. পরবর্তী UI-এর পরামর্শ

### অ্যাডমিন

1. **লাইভ ইভেন্ট স্ট্রিম** — সেশন খুললে `tool-call`/`tool-result`/`error`
   সরাসরি দেখা যাবে; এখন ৫ সেকেন্ডে polling হয়।
2. **MCP টুল-লেভেল টগল ও স্কিমা ভিউয়ার** — এখন পুরো MCP চালু/বন্ধ হয়;
   প্রতিটি টুল আলাদা দেখা ও বন্ধ করার সুযোগ দিলে কনটেক্সট বাঁচবে।
3. **প্রোভাইডার হেলথ** — মডেল সংখ্যা, শেষ টেস্টের সময়, লেটেন্সি, HTTP স্টেটাস
   একসাথে দেখানো।
4. **সিক্রেট রোটেশন** — কী লেখার সময়ই "শেষ কবে বদলানো হয়েছে" ও "কী মুছুন"।
5. **অডিট ফিল্টার** — `agent_done`, `provider_test`, `mcp_*` আলাদা ফিল্টার।
6. **ব্যাল্ক টেস্ট** — সব প্রোভাইডার/MCP এক ক্লিকে টেস্ট, ফল টেবিলে।

### ফ্রন্টএন্ড

1. টুল কার্ডে স্পষ্ট `running / done / error`, সময় ও exit code।
2. টুল আউটপুট বড় হলে collapse + "copy" + "open in viewer"।
3. প্রোভাইডার না থাকলে বা 429/530 এলে ইনলাইন "Connect / Retry"।
4. MCP টুল কার্ডে সার্ভারের নাম ও ব্যাজ।
5. টোকেন বাজেট বার এখন আছে; এতে টুল স্কিমার খরচ আলাদা দেখানো।
6. মোবাইলে সাইডবার ও টুল কার্ডের জন্য এক-কলাম লেআউট।
7. প্রম্পট-হিস্ট্রি ও সেশন সার্চ এক জায়গায়; এখন দুটো আলাদা জায়গায়।
8. রঙ কমিয়ে একটাই অ্যাকসেন্ট; এখন নীল-বেগুনি-সবুজ অনেক জায়গায় লড়াই করছে।

### স্থাপত্য

- PHP-কে thin proxy রাখা; এজেন্ট, টুল ও DB সব Node-এ।
- প্রতি প্রজেক্টে আলাদা API টোকেন এবং CSRF কুকি।
- `api_key` OS keyring বা `openssl` দিয়ে at-rest encrypt।
- `bash` টুলের জন্য cgroup/namespace বাউন্ডারি (এখন timeout+buffer)।


# যাচাই — রানটাইম env, প্রোভাইডার, MCP ও অ্যাডমিন টাস্ক (২০২৬-১১-২৪)

এই অংশে শুধু চালিয়ে দেখা ফল আছে। কোনো mock/demo টেস্ট চালানো হয়নি।
স্ক্রিনশট ও কাঁচা লগ `php/verification/`-এ আছে।

## ১. স্ট্যাটিক যাচাই

```bash
node --check php/server/server.js
node --check php/server/admin.js
php -l php/app/index.php
```

ফল: তিনটিই syntax error ছাড়া pass। `node --test` ইচ্ছাকৃতভাবে চালানো হয়নি,
কারণ নির্দেশ ছিল ডেমো টেস্ট নয়—শুধু বাস্তব execution।

## ২. Startup ও env → SQLite

`php/server/.env` লোড হয়েছে, `env_import`-এ ১৩টি কী এসেছে।
`ADMIN_TOKEN` ও `NVIDIA_API_KEY` শুধু `set` হিসেবে; মান নেই।

```text
env_synced files=["/home/sahon/Downloads/skil/ai/php/server/.env"] entries=13
listening admin_auth=disabled projects_dir=/home/sahon/Downloads/skil/ai/php/workspaces
```

Startup-এ প্রোভাইডার probe:

| প্রোভাইডার | ফল | মডেল |
|---|---|---|
| `ollama` | ok | ৩ |
| `infinite` | ok | ১০ |
| `custom:nvidia` | ok | ৩২ |

## ৩. InfiniteEarningZone API — আসল মডেল কল

`GET /v1/models` → HTTP 200, ১০টি alias (`mission`, `code-guru`, ... )।

`POST /api/admin/providers/chat`:

```json
{"provider_id":"infinite","model":"mission","message":"Reply with exactly: PONG","max_tokens":32}
```

ফল: HTTP 200, `content="PONG"`, `ms=3580`, `total_tokens=15`।

গুরুত্বপূর্ণ পর্যবেক্ষণ: এই alias-গুলো `mission-barisal`-এর agent endpoint;
সাধারণ `/chat/completions` কল কাজ করে, কিন্তু tools দিলে ওই সার্ভার নিজের
working directory-তে নিজের টুল চালাতে পারে। তাই আমাদের লোকাল প্রজেক্ট টুল
লুপের জন্য এগুলো ব্যবহার করা হয়নি; লোকাল execution-এ Ollama ব্যবহার করা
হয়েছে।

## ৪. NVIDIA কাস্টম প্রোভাইডার — আসল মডেল কল

`GET /v1/models` → HTTP 200, ৩২টি মডেল; `custom:nvidia` হিসেবে SQLite-এ।

`meta/muse-glimmer-30b`-এ `max_tokens=64` দিলে শুধু reasoning আসে, content
খালি। `max_tokens=512` দিলে:

```json
{"provider_id":"custom:nvidia","model":"meta/muse-glimmer-30b",
 "message":"Reply with exactly: PONG","max_tokens":512}
```

ফল: HTTP 200, `content="PONG"`, `ms=21364`, `total_tokens=146`। অর্থাৎ
মডেল কল কাজ করে; reasoning মডেলে content পেতে যথেষ্ট token budget দরকার।

## ৫. MCP — `https://api.infiniteearningzone.com/mcp`

`initialize` → HTTP 200, `protocolVersion=2025-06-18`,
`serverInfo.name=mission-barisal`, `mcp-session-id` সংরক্ষিত।

`tools/list` → **১০১টি টুল**। SQLite-এ `mcp_servers.status=connected`,
`protocol_version=2025-06-18`, `session_id=zc-...`; `mcp_sessions`-এ সার্ভার
সেশন। ডিফল্টে `IEZ_MCP_ENABLED=false`, তাই ১০১টি টুল ডাটাবেজে আছে কিন্তু
এজেন্টের সক্রিয় টুল লিস্টে যায় না।

## ৬. অ্যাডমিন টোকেন — true/false

`ADMIN_TOKEN_ENABLED=true` করে restart:

```text
GET /api/admin/state (token ছাড়া)  -> 401 {"error":"admin token required"}
GET /api/admin/state (X-Admin-Token)-> 200, auth={enabled:true,has_token:true}
```

আবার `ADMIN_TOKEN_ENABLED=false` করে restart:

```text
GET /api/admin/state (token ছাড়া)  -> 200, auth={enabled:false,has_token:true}
```

## ৭. ফ্রন্টএন্ডে ব্যাকএন্ড প্যারামিটার

`http://127.0.0.1:8788/index.php`-এ served HTML-এর ভিতরে:

```json
window.__ZC_BOOTSTRAP__={"node_url":"http://127.0.0.1:8787",
"workspace":"/home/sahon/Downloads/skil/ai",
"project_id":"proj_workspace","project_path":"/home/sahon/Downloads/skil/ai",
"identity":{"name":"ZombieCoder","owner":"Sahon Srabon","version":"1.0.0",
"tagline":"যেখানে কোড ও কথা বলে","branding":{...},"contact":{...}},
"csrf":"...","version":"2.0.0"}
```

PHP দিয়ে `act=ai&ai_php_api=status` → HTTP 200, session/provider/model ফেরত।
অর্থাৎ backend-এর `project_id`, `conversation_id`, `csrf_token`, identity ও
provider তালিকা ফ্রন্টএন্ডে পৌঁছায়।

## ৮. অ্যাডমিন থেকে প্রজেক্ট তৈরি ও বাস্তব এজেন্ট টাস্ক

UI থেকেই (Selenium Chromium, স্ক্রিপ্ট `runtime-ui-result.json`):

- Project: `ZombieCoder Runtime`
- Working directory: `/home/sahon/Downloads/skil/ai/php/workspaces/zombiecoder-runtime`
- Provider/model: `ollama / qwen2.5:1.5b`
- Task: `RUNTIME.md` তৈরি করা, যাতে ZombieCoder, version 1.0.0,
  owner Sahon Srabon এবং `https://api.infiniteearningzone.com/v1` থাকে।

SSE-তে নয়, admin `/api/admin/agent/run` দিয়ে চালানো হয়েছে। ফল:

```text
status=completed
iterations=2
tool_calls=1
tool_errors=0
total_tokens=1905
duration_ms=86261
messages: user, assistant(tool_call), tool(write_file), assistant
```

তৈরি ফাইল (৯০ বাইট):

```text
ZombieCoder 1.0.0
owner: Sahon Srabon
API base URL: https://api.infiniteearningzone.com/v1
```

অর্থাৎ এজেন্ট নির্দিষ্ট working directory-তে সত্যিই ফাইল লিখেছে; শুধু UI
মেসেজ নয়, DB-তে `role=tool`, `name=write_file`, `is_error=0` আছে।

## ৯. স্ক্রিনশট ও প্রমাণ ফাইল

| ফাইল | কী দেখায় |
|---|---|
| `11-admin-overview-runtime.png` | ZombieCoder identity, env, counters |
| `12-admin-project-created.png` | UI-তৈরি প্রজেক্ট ও working directory |
| `13-admin-agent-task.png` | টাস্ক completed, metrics, project path |
| `14-admin-metrics.png` | provider totals, session runs, request log |
| `15-admin-providers.png` | InfiniteEarningZone (10) ও NVIDIA (32) connected |
| `16-admin-mcp.png` | MCP connected, 101 tools, session id |
| `17-admin-sessions.png` | সেশন ও provider/model |
| `runtime-ui-result.json` | ৯টি ধাপ, সব pass, browser console-এ severe error নেই |
| `runtime-checks.json` | API/model/MCP/DB যাচাইয়ের কাঁচা ফল |

`runtime-server.log` ও `runtime-request.log` রানটাইমে তৈরি হয়, কিন্তু
সিক্রেট/লোকাল আর্টিফ্যাক্ট এড়াতে রেপোতে কমিট করা হয় না।

## ১০. যা এখনও সীমা

- InfiniteEarningZone মডেল alias-গুলো নিজের agent; আমাদের লোকাল টুল লুপের
  জন্য নয়। লোকাল execution Ollama-তে; NVIDIA শুধু chat-এ যাচাই হয়েছে।
- MCP-র ১০১টি টুল ডিফল্টে বন্ধ; চালু করলে ছোট মডেলের কনটেক্সট বাড়বে।
- একাধিক ক্লায়েন্ট একই SQLite-এর active project/conversation শেয়ার করে;
  `start` এখন চলমান সেশনের provider/model বদলায় না, তবে নতুন ক্লায়েন্টের
  selection বদলালে সেটিং বদলাতে পারে।
- admin token false মানে সব caller অনুমোদিত; `HOST=0.0.0.0` হলে এটি বিপজ্জনক।
- **Gemini ফাইল লিখতে পারে—এটি এখনো প্রমাণিত নয়।** Gemini সংযুক্ত, কিন্তু
  বাস্তব `write_file` execution-এর কোনো প্রমাণ নেই। এটি পরবর্তী সেশনের
  প্রধান কাজ।
- প্রোভাইডার capability matrix অসম্পূর্ণ: chat (InfiniteEarningZone, NVIDIA)
  যাচাই হয়েছে; tools/file_write/stream শুধু Ollama-তে সম্পূর্ণ যাচাই হয়েছে।
- Frontend UI/UX আপডেট বাকি; MCP টুল-লেভেল পলিসি ও মাল্টি-ক্লায়েন্ট
  আইসোলেশন বাকি।
