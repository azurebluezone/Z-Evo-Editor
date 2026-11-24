# php/ — PHP ফ্রন্টএন্ড, Node রানটাইম ও অ্যাডমিন

এই ফোল্ডারে এখন দুইটি প্রক্রিয়া আছে, কিন্তু একটিই কর্তৃপক্ষ:

```
ব্রাউজার
  │  index.live.php-এর UI চুক্তি
  ▼
PHP front controller  php/app/index.php        :8788
  │  /frontend/action, /frontend/stream
  ▼
Node runtime          php/server/server.js     :8787
  │  node:sqlite + fetch + MCP JSON-RPC
  ▼
php/data/zc.sqlite
```

PHP শুধু ফ্রন্টএন্ড পরিবেশন করে এবং UI-এর অনুরোধ Node-এ পাঠায়। Node-ই
প্রোভাইডার, MCP, সেশন, কনভারসেশন, টুল অনুমতি ও SQLite-এর একমাত্র মালিক।
`server.js` চালু হলে সে নিজেই PHP built-in server spawn করে; আলাদা করে PHP
চালানোর দরকার নেই।

## চালানো

```bash
cd php/server
node server.js
```

প্রত্যাশিত আউটপুট (সংক্ষেপে):

```json
{"level":"INFO","event":"listening","url":"http://127.0.0.1:8787","storage":"sqlite"}
{"level":"INFO","event":"php_started","ready":true,"url":"http://127.0.0.1:8788/index.php"}
```

- অ্যাডমিন: `http://127.0.0.1:8787/admin`
- ফ্রন্টএন্ড: `http://127.0.0.1:8788/index.php`
- স্বাস্থ্য: `curl -s http://127.0.0.1:8787/health`

`ZC_NO_PHP=1` দিলে শুধু Node API/অ্যাডমিন চালু হবে। PHP আলাদা সার্ভারে
রাখলে `ZC_NODE_URL`, `ZC_PROXY_TOKEN`, `ZC_WORKSPACE` একই মান দিতে হবে।

## পরিবেশ চলক

`server.js` শুরুতেই `php/server/.env` ও `php/.env` পড়ে; আসল process
environment সবসময় আগে। `.env` ফাইল `0600`; `php/server/.env.example` একটি
নিরাপদ টেমপ্লেট।

| চলক | ডিফল্ট | কাজ |
|---|---|---|
| `PORT` | `8787` | Node পোর্ট |
| `HOST` | `127.0.0.1` | Node বাইন্ড |
| `PHP_PORT` | `8788` | PHP built-in server পোর্ট |
| `PHP_HOST` | `127.0.0.1` | PHP বাইন্ড |
| `DATA_DIR` | `php/data` | SQLite ও লগের জায়গা |
| `ZC_WORKSPACE` | `php/../..` | প্রজেক্ট রুটের সীমা |
| `ZC_PROJECTS_DIR` | `<workspace>/php/workspaces` | UI থেকে নতুন প্রজেক্টের ডিফল্ট ফোল্ডার |
| `ZC_ALLOW_OUTSIDE` | `0` | `1` হলে ওয়ার্কস্পেসের বাইরে প্রজেক্ট |
| `ADMIN_TOKEN_ENABLED` | `false` | `false` হলে কোনো টোকেন যাচাই নেই; `true` হলে `ADMIN_TOKEN` লাগবে |
| `ADMIN_TOKEN` | (খালি) | `ADMIN_TOKEN_ENABLED=true` হলে `/api/admin/*`-এর টোকেন |
| `ZC_ZOMBIE_ENV` | `~/zombiebd/.env` | পুরোনো আইডেন্টিটি/প্রোভাইডার ইমপোর্টের ঐচ্ছিক উৎস |
| `IEZ_BASE_URL` | `https://api.infiniteearningzone.com/v1` | InfiniteEarningZone OpenAI-সামঞ্জস্য API |
| `IEZ_API_KEY` | (খালি) | ঐচ্ছিক; ফ্রি alias-গুলো কী ছাড়াই চলে |
| `IEZ_MODELS` | ১০টি alias | `mission`, `code-guru`, `bug-hunter`, ... |
| `IEZ_MCP_URL` | `https://api.infiniteearningzone.com/mcp` | বাহ্যিক MCP endpoint |
| `IEZ_MCP_ENABLED` | `false` | `true` হলে MCP টুলগুলো এজেন্টের কাছে চালু |
| `IEZ_MCP_CONNECT` | `true` | চালু হলে startup-এ initialize/tools-list probe |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | NVIDIA API Catalog |
| `NVIDIA_API_KEY` | (খালি) | NVIDIA কী |
| `NVIDIA_MODELS` | মডেল তালিকা | `custom:nvidia` প্রোভাইডারের seed |
| `ZC_IDENTITY_*` | ZombieCoder ডিফল্ট | নাম, ভার্সন, tagline, owner, branding, contact |
| `MAX_ITER` | `8` | এক অনুরোধে সর্বোচ্চ টুল লুপ |
| `EXEC_TIMEOUT` | `30000` | `bash` টুলের সময়সীমা (ms) |
| `PHP_BIN` | `php` | PHP বাইনারি |

### Environment থেকে SQLite-এ boost

startup-এ `syncEnvAudit()` নির্দিষ্ট env কী-গুলোর snapshot `env_import`-এ
লেখে (secret মান শুধু `set`/খালি হিসেবে)। `syncProviderFromEnv()`
InfiniteEarningZone ও NVIDIA-কে `providers` টেবিলে upsert করে, মডেল তালিকা
merge করে এবং কী শুধু env-এ থাকলে সেট করে। `syncMcpFromEnv()` MCP URL-টা
`mcp_servers`-এ যোগ করে; `IEZ_MCP_CONNECT=true` হলে startup-এ initialize ও
tools/list চালিয়ে সেশন ও টুল তালিকা সংরক্ষণ করে। `ensureIdentity()`
`identities`-এ পূর্ণ system identity রাখে।

কী কখনো `/api/admin/state`-এ ফেরত যায় না, শুধু `has_key` আসে।
`zc.sqlite` ফাইল `0600` মোডে রাখা হয়।

## ডাটাবেজ

`server.js` চালু হওয়ার সময় `CREATE TABLE IF NOT EXISTS` দিয়ে সব টেবিল
তৈরি করে, তারপর যা নেই শুধু তা seed করে।

| টেবিল | মূল কলাম | কাজ |
|---|---|---|
| `identities` | `name, owner, source, metadata` | জম্বি বিডি/.env থেকে আসা আইডেন্টিটি |
| `system_prompts` | `name, content, active` | সিস্টেম প্রম্পটের ইতিহাস |
| `providers` | `id, base_url, api_key, models_json, connected, is_custom_type` | বিল্ট-ইন ও কাস্টম প্রোভাইডার |
| `tools` | `name, description, schema_json, source, enabled, read_only, mcp_server_id` | বিল্ট-ইন ও MCP টুলের স্ট্যাটাস |
| `mcp_servers` | `url, auth_type, auth_header, auth_value, enabled, status, tools_json` | MCP সংযোগ ও অথেন্টিকেশন |
| `mcp_sessions` | `server_id, conversation_id, session_id, protocol_version` | তৃতীয় পক্ষের MCP সেশন |
| `projects` | `name, path, type, closed` | প্রজেক্ট রুট |
| `sessions` | `conversation_id, project_id, provider, model, mode, running, last_status` | সেশন |
| `conversations` | `title, provider, model, mode` | কনভারসেশন |
| `messages` | `role, content, parts_json, tool_calls_json, tool_call_id, diff` | সম্পূর্ণ ইতিহাস |
| `snapshots` | `label, files_json, diff_text` | লেখার আগের অবস্থা |
| `session_metrics` | `conversation_id, provider, model, iterations, tool_calls, tool_errors, tokens, duration_ms, status` | প্রতিটি রানের সংখ্যাগত মেট্রিক্স |
| `request_log` | `request_id, method, route, action, status, duration_ms, ip, user_agent, project_id, conversation_id` | প্রতিটি HTTP রিকোয়েস্টের বিস্তারিত |
| `env_import` | `key, value, secret, source, updated` | env snapshot; secret মান redacted |
| `favorites`, `permissions`, `project_contexts`, `runtime_log` | — | UI সেটিংস ও রানটাইম লগ |

## ফ্রন্টএন্ড চুক্তি

UI যেসব নাম ডাকে, সেগুলোই `/frontend/action`-এ আছে:

- বুট: `status`, `providers`, `settings_load`, `project_info`, `projects_list`, `projects_wordpress`
- প্রজেক্ট: `projects_create`, `projects_close`, `projects_delete`
- সেশন: `conversations`, `conversation`, `new_session`, `switch_conversation`, `rename_conversation`, `delete_conversation`, `start`, `set_mode`
- মেসেজ: `clear`, `compact`, `undo`, `redo`, `regenerate`, `fork`, `abort`, `force_unlock`
- ফাইল: `file_tree`, `read_file`, `resolve_file`, `changes`, `diff`, `restore`, `shell`
- সেটিংস: `settings_save`, `settings_delete`, `test_connection`, `favorite_model`, `unfavorite_model`, `toggle_permission`
- কনটেক্সট: `bootstrap_get/save/clear`, `state_get/save/clear`, `memory_get/save/clear`
- স্ট্রিম: `POST /frontend/stream` — `data: {...}` লাইনে `iteration-start`, `reasoning-delta`, `text-delta`, `tool-call`, `tool-result`, `title`, `usage`, `done`, `error`

`index.live.php` স্ন্যাপশটে পুরোনো হোম-পাথ একটি ডিসপ্লে টেক্সট হিসেবে আছে।
`php/app/index.php` সেটি স্ন্যাপশটের `HD` মান থেকে পড়ে রানটাইমে
`ZC_WORKSPACE` দিয়ে বদলে দেয়; ফাইলের ভিতরে পাথ হার্ডকোড করা নেই।

PHP ব্রাউজার থেকে পাওয়া `index.live.php?act=ai&ai_php_api=...` অনুরোধের
`csrf_token`, `path`, `depth`, `conversation_id`, `project_id` সহ Node-এ
পাঠায়। স্ট্রিমিং রেসপন্স cURL write callback দিয়ে unbuffered ফরওয়ার্ড হয়।

## অ্যাডমিন

`php/server/admin.js`-এ ছোট HTML পেজ ও `/api/admin/*` রাউট আছে। রানটাইমে
বদলানো যায়:

- আইডেন্টিটি ও সিস্টেম প্রম্পট (তৈরি, সম্পাদনা, অ্যাক্টিভেট)
- প্রোভাইডার (নতুন/কাস্টম, কী, বেস URL, মডেল, টেস্ট, ডিলিট)
- টুল চালু/বন্ধ, সরাসরি টুল রান
- MCP যোগ, কানেক্ট, চালু/বন্ধ, রিফ্রেশ, ডিলিট; auth type `none|bearer|header`
- সেশন দেখা/ডিলিট, রানটাইম লগ

`tools.enabled` ও `mcp_servers.enabled` প্রতি অনুরোধে ডাটাবেজ থেকে পড়া হয়;
তাই অ্যাডমিনে টগল করলেই পরের এজেন্ট অনুরোধে ক্যাপাবিলিটি বদলে যায়।

অ্যাডমিনে আরও আছে:

- **Projects & Agent** — নাম/working directory দিয়ে প্রজেক্ট তৈরি, activate,
  close, delete; নির্বাচিত প্রজেক্টে provider/model/mode বেছে সরাসরি এজেন্ট
  টাস্ক চালানো। ডিফল্ট প্রজেক্ট ফোল্ডার `ZC_PROJECTS_DIR`।
- **Metrics** — মোট run, token, tool call, tool error, গড় সময়; provider
  অনুযায়ী totals; প্রতিটি সেশনের iterations/tokens/duration; শেষ HTTP
  রিকোয়েস্টের status, duration, IP, bytes।
- **Environment sync** — কোন `.env` ফাইল পড়া হয়েছে, কোন কী এসেছে।

`ADMIN_TOKEN_ENABLED=false` হলে `/admin` পেজ খোলে এবং `/api/admin/*` কোনো
টোকেন ছাড়াই চলে; `true` হলে `X-Admin-Token` বা `Authorization: Bearer`
লাগে। টোকেন সবসময় env থেকে পড়া হয়, ডাটাবেজে রাখা হয় না।

## টুল ও নিরাপত্তা

- ডিফল্টে `server_info`, `read_file`, `list_files`, `grep`, `glob` চালু।
- `write_file`, `edit_file`, `replace_in_file`, `bash` ডিফল্টে বন্ধ; অ্যাডমিন থেকে চালু করতে হয়।
- `plan` মোডে শুধু `read_only=1` টুল চলে।
- প্রতিটি ফাইল পাথ প্রজেক্ট রুটের ভিতরে resolve হয়; `../` বাইরে গেলে ব্লক।
- `bash` প্রজেক্ট রুটে চলে, সময়সীমা ও আউটপুট সীমা আছে।
- `bash`/`write` চালু না থাকলে মডেল টুল পেলেও এক্সিকিউশন হবে না।
- প্রোভাইডারে যাওয়ার সময় `X-ZC-Identity` (base64url JSON), `X-ZC-Project`,
  `X-ZC-Session`, `X-ZC-Conversation` হেডার যায়।
- প্রতিটি HTTP রেসপন্সে `X-Powered-By: ZombieCoder-by-SahonSrabon`,
  `X-System-Identity`, `X-System-Version`, `X-System-Owner`,
  `X-System-Website` ও `X-Request-Id` থাকে। PHP front controller ও একই
  হেডার পাঠায়।
- `requestLog()` প্রতিটি রিকোয়েস্টের method, route, action, status,
  duration, IP, User-Agent, redacted query, project, conversation, provider,
  model ও bytes `request_log` এবং `zc.log`-এ লেখে।

## MCP

অ্যাডমিন থেকে নাম, URL, auth type ও টোকেন দিয়ে MCP যোগ করলে সার্ভার
`initialize` ও `tools/list` চালায়। পাওয়া টুল `mcp__<server>__<tool>` নামে
`tools` টেবিলে ঢোকে এবং `mcp_sessions`-এ সেশন আইডি রাখা হয়। এজেন্ট
`tools/call` করলে Node সেই MCP-তে JSON-RPC পাঠায়। MCP বন্ধ করলে তার সব
টুলও বন্ধ হয়; ডিলিট করলে টুল ও সেশন মুছে যায়।

`https://api.infiniteearningzone.com/mcp` env থেকে স্বয়ংক্রিয়ভাবে যোগ হয়।
যাচাইয়ে এটির `initialize` সফল, protocol `2025-06-18`, সেশন আইডি সংরক্ষিত
এবং `tools/list` ১০১টি টুল ফেরত দিয়েছে। ডিফল্টে `IEZ_MCP_ENABLED=false`,
তাই টুলগুলো ডাটাবেজে থাকলেও এজেন্টের কনটেক্সটে যায় না; অ্যাডমিন থেকে
Enable করলে যায়।

## যাচাই

এই হালনাগাদে কোনো ডেমো বা mock টেস্ট চালানো হয়নি। যা চালানো হয়েছে:

- আসল InfiniteEarningZone `/v1/models` (১০) ও `mission` chat (`PONG`)।
- আসল NVIDIA `/v1/models` (৩২) ও `meta/muse-glimmer-30b` chat (`PONG`)।
- আসল MCP `initialize` + `tools/list` (১০১ টুল, protocol `2025-06-18`)।
- `ADMIN_TOKEN_ENABLED` true (401/200) ও false (200) দুই অবস্থা।
- PHP frontend bootstrap-এ project, csrf, identity, branding ও contact।
- Admin UI থেকে প্রজেক্ট তৈরি ও Ollama `qwen2.5:1.5b` দিয়ে আসল
  `RUNTIME.md` লেখা (২ iteration, ১ tool call, ০ error)।

কাঁচা ফল: `php/verification/runtime-checks.json` ও
`runtime-ui-result.json`; স্ক্রিনশট `11`–`17`। বিস্তারিত:
`php/VERIFICATION.md`। নতুন সেশনে শুরু করার জন্য:
`php/RUNBOOK.md`।
