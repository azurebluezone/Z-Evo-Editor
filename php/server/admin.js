"use strict";

// =============================================================================
// admin.js
// -----------------------------------------------------------------------------
// The admin surface is deliberately one small HTML page plus the request routes
// that read and write the same SQLite tables the agent uses at runtime.
// =============================================================================

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZC Runtime Admin</title>
<style>
:root{--bg:#0b1120;--panel:#111a2e;--panel2:#16223a;--bd:#27344d;--text:#e5edf8;--muted:#8fa3bf;--accent:#60a5fa;--ok:#34d399;--err:#f87171;--warn:#fbbf24}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 600px at 20% -10%,#13264a 0%,var(--bg) 45%,#090f1d 100%);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh}
header{display:flex;align-items:center;gap:14px;padding:13px 22px;border-bottom:1px solid var(--bd);background:rgba(13,22,40,.92);backdrop-filter:blur(10px);position:sticky;top:0;z-index:10}
header h1{font-size:15px;margin:0;letter-spacing:.2px}header h1 span{color:var(--accent)}header .badge{font-size:11px;color:var(--muted);border:1px solid var(--bd);border-radius:999px;padding:3px 9px;white-space:nowrap}
header .spacer{flex:1}header input{width:220px}
nav{display:flex;gap:6px;padding:10px 22px;border-bottom:1px solid var(--bd);overflow-x:auto;background:#0e182b;position:sticky;top:57px;z-index:9}
nav button{background:transparent;border:1px solid transparent;color:var(--muted);padding:7px 12px;border-radius:8px;cursor:pointer;white-space:nowrap;font-weight:600;font-size:12px}
nav button:hover{color:var(--text);background:var(--panel)}nav button.active{color:#fff;background:var(--accent);border-color:var(--accent)}
main{padding:20px 22px 60px;max-width:1480px;margin:0 auto}section{display:none}section.active{display:block}
h2{font-size:15px;margin:0 0 12px}h3{font-size:13px;margin:0 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:18px}
.card{background:var(--panel);border:1px solid var(--bd);border-radius:12px;padding:14px}.card .k{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.card .v{font-size:22px;font-weight:700;margin-top:3px}
.panel{background:var(--panel);border:1px solid var(--bd);border-radius:12px;padding:16px;margin-bottom:16px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.row>*{min-width:0}
input,select,textarea,button{font:inherit}input,select,textarea{background:var(--panel2);border:1px solid var(--bd);color:var(--text);border-radius:8px;padding:8px 10px;outline:none;width:100%}
input:focus,textarea:focus,select:focus{border-color:var(--accent)}textarea{min-height:120px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
label{display:block;font-size:11px;color:var(--muted);margin-bottom:4px}
button{background:var(--panel2);border:1px solid var(--bd);color:var(--text);border-radius:8px;padding:8px 12px;cursor:pointer;font-weight:600;font-size:12px;white-space:nowrap}
button:hover{border-color:var(--accent)}button.primary{background:var(--accent);border-color:var(--accent);color:#07111f}button.danger{color:var(--err)}button.small{padding:4px 8px;font-size:11px}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--bd);vertical-align:top}th{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}
tr:hover td{background:rgba(96,165,250,.04)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all}
.pill{display:inline-block;border-radius:999px;padding:2px 8px;font-size:10px;font-weight:700;border:1px solid var(--bd)}
.pill.on{color:var(--ok);border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.08)}.pill.off{color:var(--muted)}.pill.err{color:var(--err);border-color:rgba(248,113,113,.4);background:rgba(248,113,113,.08)}
.muted{color:var(--muted)}.err{color:var(--err)}.ok{color:var(--ok)}.warn{color:var(--warn)}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}.fields .wide{grid-column:1/-1}
.split{display:grid;grid-template-columns:minmax(260px,360px) 1fr;gap:16px}@media(max-width:900px){.split{grid-template-columns:1fr}}
.hero{background:linear-gradient(135deg,rgba(96,165,250,.10),rgba(52,211,153,.06));border:1px solid var(--bd);border-radius:14px;padding:18px 20px;margin-bottom:16px}
.hero .title{font-size:18px;font-weight:700;margin-bottom:4px}.hero .sub{color:var(--muted);font-size:12px}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}.metric{background:var(--panel2);border:1px solid var(--bd);border-radius:10px;padding:12px}.metric .k{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.metric .v{font-size:24px;font-weight:800;margin-top:2px}
.bar{height:6px;background:var(--panel2);border-radius:999px;overflow:hidden;border:1px solid var(--bd)}.bar span{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--ok))}
.statusdot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--muted);margin-right:6px}.statusdot.on{background:var(--ok);box-shadow:0 0 0 3px rgba(52,211,153,.12)}.statusdot.err{background:var(--err)}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:#0a1324;border:1px solid var(--bd);border-radius:8px;padding:10px;overflow:auto;max-height:360px;white-space:pre-wrap}
.tabsline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.tabsline .muted{font-size:11px}
.empty{padding:14px;color:var(--muted);text-align:center;border:1px dashed var(--bd);border-radius:10px}
.list{display:flex;flex-direction:column;gap:6px;max-height:420px;overflow:auto}.item{border:1px solid var(--bd);background:var(--panel2);border-radius:8px;padding:8px;cursor:pointer}.item:hover{border-color:var(--accent)}.item.active{border-color:var(--accent)}
.chat{max-height:480px;overflow:auto;display:flex;flex-direction:column;gap:8px}.msg{border:1px solid var(--bd);border-radius:8px;padding:8px;background:var(--panel2);white-space:pre-wrap;font-size:12px}.msg.user{border-color:rgba(96,165,250,.4)}.msg .role{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
.toast{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:50}.toast div{background:#15233b;border:1px solid var(--bd);border-left:3px solid var(--accent);padding:9px 12px;border-radius:8px;font-size:12px;box-shadow:0 12px 32px rgba(0,0,0,.35)}
pre{white-space:pre-wrap;word-break:break-word;margin:0}
</style>
</head>
<body>
<header>
  <h1><span id="brandName">ZombieCoder</span> Runtime</h1>
  <span class="badge" id="version">loading</span>
  <span class="badge" id="health">-</span>
  <span class="badge" id="authBadge">auth</span>
  <span class="badge" id="identityBadge">identity</span>
  <div class="spacer"></div>
  <input id="adminToken" type="password" placeholder="Admin token (if configured)" autocomplete="off">
  <button id="refreshBtn">Refresh</button>
</header>
<nav>
  <button data-tab="overview" class="active">Overview</button>
  <button data-tab="projects">Projects &amp; Agent</button>
  <button data-tab="metrics">Metrics</button>
  <button data-tab="identity">Identity &amp; Prompt</button>
  <button data-tab="providers">Providers</button>
  <button data-tab="tools">Tools</button>
  <button data-tab="mcp">MCP</button>
  <button data-tab="sessions">Sessions</button>
  <button data-tab="logs">Logs</button>
</nav>
<main>
  <section id="tab-overview" class="active">
    <div class="hero">
      <div class="title" id="heroTitle">Runtime control plane</div>
      <div class="sub" id="heroSub">SQLite-backed agent runtime, provider gateway and MCP client.</div>
    </div>
    <h2>Runtime state</h2>
    <div class="grid" id="overviewCards"></div>
    <div class="panel"><h3>Active identity</h3><div id="overviewIdentity" class="mono"></div></div>
    <div class="panel"><h3>Active project</h3><div id="overviewProject" class="mono"></div></div>
    <div class="panel"><h3>Environment sync</h3><div id="overviewEnv" class="mono"></div></div>
    <div class="panel"><h3>Quick links</h3><div class="row"><a id="frontendLink" href="#" target="_blank" style="color:var(--accent)">Open PHP frontend</a><span class="muted" id="frontendUrl"></span></div></div>
  </section>

  <section id="tab-projects">
    <h2>Projects and working directories</h2>
    <div class="panel">
      <div class="fields">
        <div><label>Project name</label><input id="projectName" placeholder="Runtime Notes"></div>
        <div><label>Working directory (absolute or relative to root)</label><input id="projectPath" placeholder="php/workspaces/runtime-notes"></div>
        <div><label>Type</label><input id="projectType" value="custom"></div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="primary" id="createProject">Create project</button>
        <span class="muted" id="projectStatus"></span>
      </div>
      <div class="muted" style="margin-top:8px">Paths are created inside the workspace. Leave the path blank to create <span class="mono">projects_dir/&lt;slug&gt;</span>.</div>
    </div>
    <div class="panel"><div id="projectTable"></div></div>
    <h2>Run an agent task</h2>
    <div class="panel">
      <div class="fields">
        <div><label>Project</label><select id="taskProject"></select></div>
        <div><label>Provider</label><select id="taskProvider"></select></div>
        <div><label>Model</label><input id="taskModel" placeholder="qwen2.5:1.5b"></div>
        <div><label>Mode</label><select id="taskMode"><option value="build">build</option><option value="plan">plan</option></select></div>
        <div class="wide"><label>Task message</label><textarea id="taskMessage" style="min-height:100px" placeholder="Write a small, real deliverable in the selected working directory."></textarea></div>
      </div>
      <div class="tabsline" style="margin-top:10px">
        <button class="primary" id="runTask">Run task</button>
        <button id="enableWriteTools">Enable write tools</button>
        <span class="muted" id="taskStatus"></span>
      </div>
      <pre id="taskOutput" class="code" style="margin-top:10px;display:none"></pre>
    </div>
  </section>

  <section id="tab-metrics">
    <h2>Session metrics</h2>
    <div class="metrics" id="metricCards"></div>
    <div class="panel"><h3>Provider totals</h3><div id="providerTotals"></div></div>
    <div class="panel"><h3>Session runs</h3><div id="sessionMetricsTable"></div></div>
    <div class="panel"><h3>Request log</h3><div id="requestTable"></div></div>
  </section>

  <section id="tab-identity">
    <h2>Identity</h2>
    <div class="panel">
      <div class="fields">
        <div><label>Name</label><input id="idName"></div>
        <div><label>Owner</label><input id="idOwner"></div>
        <div class="wide"><label>Metadata (JSON)</label><textarea id="idMeta" style="min-height:90px"></textarea></div>
      </div>
      <div class="row" style="margin-top:10px"><button class="primary" id="saveIdentity">Save identity</button><span class="muted" id="identitySource"></span></div>
    </div>
    <h2>System prompts</h2>
    <div class="split">
      <div class="panel">
        <div class="row" style="margin-bottom:8px"><button id="newPrompt">New prompt</button></div>
        <div class="list" id="promptList"></div>
      </div>
      <div class="panel">
        <div class="fields">
          <div><label>Prompt id</label><input id="promptId" readonly></div>
          <div><label>Name</label><input id="promptName"></div>
          <div class="wide"><label>Content</label><textarea id="promptContent" style="min-height:300px"></textarea></div>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="primary" id="savePrompt">Save prompt</button>
          <button id="activatePrompt">Activate</button>
          <button class="danger" id="deletePrompt">Delete</button>
          <span class="muted" id="promptStatus"></span>
        </div>
      </div>
    </div>
  </section>

  <section id="tab-providers">
    <h2>Providers</h2>
    <div class="panel">
      <div class="fields">
        <div><label>Provider id</label><input id="pvId" placeholder="custom:my-provider"></div>
        <div><label>Name</label><input id="pvName"></div>
        <div><label>Base URL</label><input id="pvBase" placeholder="https://api.example.com/v1"></div>
        <div><label>API key</label><input id="pvKey" type="password" placeholder="leave blank to keep existing"></div>
        <div><label>Default model</label><input id="pvDefault"></div>
        <div><label>Supports tool calls</label><select id="pvTools"><option value="1">yes</option><option value="0">no</option></select></div>
        <div><label>Models (id=name, ...)</label><input id="pvModels" placeholder="model-id=Model Name, model-2"></div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="primary" id="saveProvider">Add / update</button>
        <button id="testProvider">Test by id</button>
        <button id="clearProviderForm">Clear form</button>
        <span class="muted" id="providerStatus"></span>
      </div>
    </div>
    <div class="panel"><div id="providerTable"></div></div>
  </section>

  <section id="tab-tools">
    <h2>Tools</h2>
    <div class="panel"><div id="toolTable"></div></div>
    <div class="panel">
      <h3>Run a tool directly</h3>
      <div class="fields">
        <div><label>Tool name</label><select id="runToolName"></select></div>
        <div class="wide"><label>Arguments (JSON)</label><textarea id="runToolInput" style="min-height:80px">{}</textarea></div>
      </div>
      <div class="row" style="margin-top:10px"><button class="primary" id="runTool">Run</button><span class="muted" id="runToolStatus"></span></div>
      <pre id="runToolOutput" class="mono" style="margin-top:10px;max-height:240px;overflow:auto"></pre>
    </div>
  </section>

  <section id="tab-mcp">
    <h2>MCP servers</h2>
    <div class="panel">
      <div class="fields">
        <div><label>Name</label><input id="mcpName"></div>
        <div><label>MCP endpoint URL</label><input id="mcpUrl" placeholder="https://example.com/mcp"></div>
        <div><label>Auth type</label><select id="mcpAuthType"><option value="none">none</option><option value="bearer">bearer</option><option value="header">header</option></select></div>
        <div><label>Auth header</label><input id="mcpAuthHeader" placeholder="Authorization"></div>
        <div><label>Token / value</label><input id="mcpToken" type="password"></div>
        <div><label>Enabled</label><select id="mcpEnabled"><option value="0">off</option><option value="1">on</option></select></div>
      </div>
      <div class="row" style="margin-top:10px"><button class="primary" id="addMcp">Add MCP</button><span class="muted" id="mcpStatus"></span></div>
    </div>
    <div class="panel"><div id="mcpTable"></div></div>
  </section>

  <section id="tab-sessions">
    <h2>Sessions</h2>
    <div class="split">
      <div class="panel"><div class="list" id="sessionList"></div></div>
      <div class="panel"><div id="sessionDetail" class="muted">Select a session.</div></div>
    </div>
  </section>

  <section id="tab-logs">
    <h2>Runtime logs</h2>
    <div class="panel"><div id="logTable"></div></div>
  </section>
</main>
<div class="toast" id="toast"></div>
<script src="/admin.js"></script>
</body>
</html>`;
}

function clientScript() {
  return String.raw`
(function(){
var state=null, activePrompt=null, activeSession=null;
var $=function(s){return document.querySelector(s)};
var tokenInput=$('#adminToken');
tokenInput.value=localStorage.getItem('zc_admin_token')||'';
tokenInput.addEventListener('change',function(){localStorage.setItem('zc_admin_token',tokenInput.value.trim());refresh()});
function toast(message,type){var box=$('#toast');var d=document.createElement('div');d.textContent=message;if(type==='err')d.style.borderLeftColor='var(--err)';if(type==='ok')d.style.borderLeftColor='var(--ok)';box.appendChild(d);setTimeout(function(){d.remove()},3500)}
function api(path,opts){
  opts=opts||{};
  var headers={'Content-Type':'application/json'};
  var token=localStorage.getItem('zc_admin_token')||'';
  if(token)headers['X-Admin-Token']=token;
  return fetch('/api/admin'+path,{method:opts.method||'GET',headers:headers,body:opts.body?JSON.stringify(opts.body):undefined})
    .then(function(res){return res.json().then(function(json){if(!res.ok||json.ok===false)throw new Error(json.error||('HTTP '+res.status));return json})});
}
function setTab(name){
  document.querySelectorAll('nav button').forEach(function(b){b.classList.toggle('active',b.dataset.tab===name)});
  document.querySelectorAll('main section').forEach(function(s){s.classList.toggle('active',s.id==='tab-'+name)});
}
document.querySelectorAll('nav button').forEach(function(b){b.addEventListener('click',function(){setTab(b.dataset.tab)})});
$('#refreshBtn').addEventListener('click',function(){refresh()});
function pill(on,onText,offText){return '<span class="pill '+(on?'on':'off')+'">'+(on?(onText||'on'):(offText||'off'))+'</span>'}
function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

function render(){
  if(!state)return;
  $('#brandName').textContent=state.identity.name||'ZombieCoder';
  $('#heroTitle').textContent=(state.identity.name||'ZombieCoder')+' '+(state.identity.version||'')+' control plane';
  $('#heroSub').textContent=(state.identity.tagline||'')+' · '+state.storage+' · '+state.projects_dir;
  $('#version').textContent='v'+state.version;
  $('#health').textContent=state.storage+' / '+state.counts.messages+' messages / '+state.counts.requests+' requests';
  $('#authBadge').textContent=state.auth&&state.auth.enabled?'token required':'token disabled';
  $('#authBadge').className='badge '+(state.auth&&state.auth.enabled?'':'muted');
  $('#identityBadge').textContent=(state.identity.name||'')+' / '+(state.identity.branding&&state.identity.branding.owner||'');
  $('#adminToken').disabled=!(state.auth&&state.auth.enabled);
  $('#adminToken').placeholder=state.auth&&state.auth.enabled?'Admin token required':'Admin token disabled by environment';
  $('#frontendUrl').textContent=state.php_url;
  $('#frontendLink').href=state.php_url;
  $('#overviewCards').innerHTML=[
    ['Sessions',state.counts.sessions],['Messages',state.counts.messages],['Providers',state.counts.providers],
    ['Tools',state.counts.tools],['MCP',state.counts.mcp],['Requests',state.counts.requests],
    ['Runs',state.totals?state.totals.runs:0],['Tokens',state.totals?state.totals.tokens:0],['Uptime',state.uptime_sec+'s']
  ].map(function(x){return '<div class="card"><div class="k">'+x[0]+'</div><div class="v">'+x[1]+'</div></div>'}).join('');
  $('#overviewIdentity').textContent=JSON.stringify(state.identity,null,2);
  $('#overviewProject').textContent=state.active_project?JSON.stringify(state.active_project,null,2):'no project';
  $('#overviewEnv').textContent=JSON.stringify({files:state.env&&state.env.files,projects_dir:state.projects_dir,entries:(state.env&&state.env.entries||[]).map(function(e){return e.key+(e.secret?' (secret '+(e.value||'empty')+')':'='+e.value)})},null,2);
  if(document.activeElement!==$('#idName')&&document.activeElement!==$('#idOwner')&&document.activeElement!==$('#idMeta')){
    $('#idName').value=state.identity.name||'';$('#idOwner').value=state.identity.owner||'';
    $('#idMeta').value=JSON.stringify(state.identity.metadata||{},null,2);
  }
  $('#identitySource').textContent='source: '+(state.identity.source||'')+' / owner: '+(state.identity.owner||'');
  renderPrompts();renderProviders();renderTools();renderMcp();renderSessions();renderLogs();renderProjects();renderMetrics();
}

function fmtNum(n){n=Number(n||0);return n>=1000000?(n/1000000).toFixed(1)+'M':n>=1000?(n/1000).toFixed(1)+'k':String(n)}
function fmtMs(ms){ms=Number(ms||0);return ms>=1000?(ms/1000).toFixed(1)+'s':Math.round(ms)+'ms'}
function renderProjects(){
  var rows=state.projects||[];
  var active=state.active_project?state.active_project.id:'';
  var el=$('#projectTable');
  el.innerHTML=rows.length?'<table><thead><tr><th>Project</th><th>Working directory</th><th>State</th><th></th></tr></thead><tbody>'+
    rows.map(function(p){return '<tr><td><b>'+esc(p.name)+'</b><div class="mono muted">'+esc(p.project_id)+'</div></td>'+
      '<td class="mono">'+esc(p.path)+'</td>'+
      '<td>'+(p.closed?'<span class="pill off">closed</span>':(p.project_id===active?'<span class="pill on"><span class="statusdot on"></span>active</span>':'<span class="pill">open</span>'))+'</td>'+
      '<td style="white-space:nowrap">'+(p.closed?'':'<button class="small" data-activate="'+esc(p.project_id)+'">Activate</button> ')+'<button class="small" data-use="'+esc(p.project_id)+'">Use for task</button> '+(p.closed?'':'<button class="small" data-close="'+esc(p.project_id)+'">Close</button> ')+'<button class="small danger" data-del="'+esc(p.project_id)+'">Delete</button></td></tr>'}).join('')+'</tbody></table>':'<div class="empty">No projects yet.</div>';
  el.querySelectorAll('[data-activate]').forEach(function(b){b.addEventListener('click',function(){api('/projects/'+encodeURIComponent(b.dataset.activate)+'/activate',{method:'POST',body:{}}).then(function(){toast('Project activated','ok');refresh()}).catch(function(e){toast(e.message,'err')})})});
  el.querySelectorAll('[data-use]').forEach(function(b){b.addEventListener('click',function(){var sel=$('#taskProject');if(sel){sel.value=b.dataset.use;setTab('projects');sel.dispatchEvent(new Event('change'))}})});
  el.querySelectorAll('[data-close]').forEach(function(b){b.addEventListener('click',function(){if(confirm('Close this project?'))api('/projects/'+encodeURIComponent(b.dataset.close)+'/close',{method:'POST',body:{}}).then(function(){toast('Project closed','ok');refresh()}).catch(function(e){toast(e.message,'err')})})});
  el.querySelectorAll('[data-del]').forEach(function(b){b.addEventListener('click',function(){if(confirm('Delete this project, its sessions and metrics?'))api('/projects/'+encodeURIComponent(b.dataset.del),{method:'DELETE'}).then(function(){toast('Project deleted','ok');refresh()}).catch(function(e){toast(e.message,'err')})})});
  var tp=$('#taskProject');var current=tp.value;
  tp.innerHTML=rows.filter(function(p){return !p.closed}).map(function(p){return '<option value="'+esc(p.project_id)+'">'+esc(p.name)+' — '+esc(p.path)+'</option>'}).join('');
  if(current)tp.value=current;
  if(active&&!tp.value)tp.value=active;
  var prov=$('#taskProvider');var cur=prov.value;
  prov.innerHTML=(state.providers||[]).filter(function(p){return p.connected}).map(function(p){return '<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>'}).join('');
  if(cur)prov.value=cur;
  if(!prov.value&&(state.providers||[]).some(function(p){return p.id==='ollama'}))prov.value='ollama';
  if(!$('#taskModel').value){var row=(state.providers||[]).find(function(p){return p.id===prov.value});$('#taskModel').value=row?(row.default_model||Object.keys(row.models||{})[0]||''):''}
}
$('#createProject').addEventListener('click',function(){
  var name=$('#projectName').value.trim();var path=$('#projectPath').value.trim();
  if(!name){toast('Project name is required','err');return}
  $('#projectStatus').textContent='creating...';
  api('/projects',{method:'POST',body:{name:name,path:path||undefined,type:$('#projectType').value.trim()||'custom'}})
    .then(function(res){$('#projectStatus').textContent='created '+res.project.path;toast('Project created','ok');$('#projectName').value='';$('#projectPath').value='';refresh()})
    .catch(function(e){$('#projectStatus').textContent='failed: '+e.message;toast(e.message,'err')});
});
$('#taskProvider').addEventListener('change',function(){var row=(state.providers||[]).find(function(p){return p.id===$('#taskProvider').value});if(row)$('#taskModel').value=row.default_model||Object.keys(row.models||{})[0]||''});
$('#enableWriteTools').addEventListener('click',function(){
  var names=['write_file','edit_file','replace_in_file'];var ids=(state.tools||[]).filter(function(t){return names.indexOf(t.name)!==-1}).map(function(t){return t.id});
  Promise.all(ids.map(function(id){return api('/tools/'+encodeURIComponent(id)+'/toggle',{method:'POST',body:{enabled:true}})})).then(function(){toast('Write tools enabled','ok');refresh()}).catch(function(e){toast(e.message,'err')});
});
$('#runTask').addEventListener('click',function(){
  var message=$('#taskMessage').value.trim();if(!message){toast('Task message is required','err');return}
  var body={project_id:$('#taskProject').value,provider:$('#taskProvider').value,model:$('#taskModel').value.trim(),mode:$('#taskMode').value,message:message,enable_tools:['read_file','list_files','grep','glob','write_file']};
  $('#taskStatus').textContent='running...';$('#taskOutput').style.display='block';$('#taskOutput').textContent='waiting for the agent...';
  api('/agent/run',{method:'POST',body:body}).then(function(res){
    $('#taskStatus').textContent=res.ok?'completed':'failed';
    $('#taskOutput').textContent=JSON.stringify({ok:res.ok,conversation_id:res.conversation_id,project:res.project,provider:res.provider,model:res.model,metrics:res.metrics,result:res.result},null,2);
    toast(res.ok?'Agent task completed':'Agent task failed',res.ok?'ok':'err');refresh();
  }).catch(function(e){$('#taskStatus').textContent='failed: '+e.message;$('#taskOutput').textContent=e.message;toast(e.message,'err')});
});
function renderMetrics(){
  var t=state.totals||{};
  $('#metricCards').innerHTML=[['Runs',t.runs||0],['Tokens',fmtNum(t.tokens||0)],['Tool calls',t.tool_calls||0],['Tool errors',t.tool_errors||0],['Avg run',fmtMs(t.avg_duration_ms||0)]].map(function(x){return '<div class="metric"><div class="k">'+x[0]+'</div><div class="v">'+x[1]+'</div></div>'}).join('');
  var by=t.by_provider||[];
  $('#providerTotals').innerHTML=by.length?'<table><thead><tr><th>Provider</th><th>Runs</th><th>Tokens</th><th>Tool calls</th><th>Errors</th></tr></thead><tbody>'+by.map(function(p){return '<tr><td class="mono">'+esc(p.provider||'-')+'</td><td>'+p.runs+'</td><td>'+fmtNum(p.tokens)+'</td><td>'+p.tool_calls+'</td><td class="'+(p.tool_errors?'err':'')+'">'+p.tool_errors+'</td></tr>'}).join('')+'</tbody></table>':'<div class="empty">No completed runs yet.</div>';
  var rows=state.metrics||[];
  $('#sessionMetricsTable').innerHTML=rows.length?'<table><thead><tr><th>Updated</th><th>Session</th><th>Provider / model</th><th>Status</th><th>Iter</th><th>Tools</th><th>Errors</th><th>Tokens</th><th>Duration</th></tr></thead><tbody>'+rows.map(function(m){return '<tr><td class="mono">'+new Date(m.updated).toLocaleString()+'</td><td><b>'+esc(m.title||m.conversation_id)+'</b><div class="mono muted">'+esc(m.conversation_id)+'</div></td><td>'+esc(m.provider)+'<div class="muted mono">'+esc(m.model)+'</div></td><td><span class="pill '+(m.status==='completed'?'on':(m.status==='error'?'err':'off'))+'">'+esc(m.status)+'</span></td><td>'+m.iterations+'</td><td>'+m.tool_calls+'</td><td class="'+(m.tool_errors?'err':'')+'">'+m.tool_errors+'</td><td>'+fmtNum(m.total_tokens)+'</td><td>'+fmtMs(m.duration_ms)+'</td></tr>'}).join('')+'</tbody></table>':'<div class="empty">No session metrics yet.</div>';
  var req=state.requests||[];
  $('#requestTable').innerHTML=req.length?'<table><thead><tr><th>Time</th><th>Method</th><th>Route</th><th>Action</th><th>Status</th><th>Duration</th><th>IP</th><th>Bytes</th></tr></thead><tbody>'+req.map(function(r){return '<tr><td class="mono">'+esc(r.time)+'</td><td>'+esc(r.method)+'</td><td class="mono">'+esc(r.route)+(r.is_admin?' <span class="pill">admin</span>':'')+'</td><td>'+esc(r.action||'-')+'</td><td class="'+(r.status>=400?'err':'ok')+'">'+r.status+'</td><td>'+fmtMs(r.duration_ms)+'</td><td class="mono">'+esc(r.ip||'-')+'</td><td>'+(r.bytes||0)+'</td></tr>'}).join('')+'</tbody></table>':'<div class="empty">No requests logged yet.</div>';
}

function renderPrompts(){
  var list=$('#promptList');list.innerHTML='';
  (state.prompts||[]).forEach(function(p){
    var d=document.createElement('div');d.className='item'+(activePrompt&&activePrompt.id===p.id?' active':'');
    d.innerHTML='<div style="font-weight:600">'+esc(p.name)+' '+pill(!!p.active,'active')+'</div><div class="muted mono">'+esc(p.id)+'</div>';
    d.addEventListener('click',function(){loadPrompt(p.id)});list.appendChild(d);
  });
  if(!activePrompt&&state.prompts&&state.prompts.length)loadPrompt(state.prompts[0].id);
}
function loadPrompt(id){
  api('/prompts').then(function(res){
    var p=(res.prompts||[]).find(function(x){return x.id===id});
    if(!p)return;activePrompt=p;$('#promptId').value=p.id;$('#promptName').value=p.name;$('#promptContent').value=p.content;
    $('#promptStatus').textContent=p.active?'active':'inactive';renderPrompts();
  }).catch(function(e){toast(e.message,'err')});
}
$('#newPrompt').addEventListener('click',function(){activePrompt={id:'',name:'New prompt',content:'',active:0};$('#promptId').value='';$('#promptName').value='New prompt';$('#promptContent').value='';$('#promptStatus').textContent='new';renderPrompts()});
$('#savePrompt').addEventListener('click',function(){
  api('/prompts',{method:'POST',body:{id:activePrompt&&activePrompt.id?activePrompt.id:undefined,name:$('#promptName').value,content:$('#promptContent').value}})
    .then(function(res){toast('Prompt saved','ok');activePrompt=res.prompt;refresh()}).catch(function(e){toast(e.message,'err')});
});
$('#activatePrompt').addEventListener('click',function(){if(!activePrompt||!activePrompt.id)return;api('/prompts/'+encodeURIComponent(activePrompt.id)+'/activate',{method:'POST',body:{}}).then(function(){toast('Prompt activated','ok');refresh()}).catch(function(e){toast(e.message,'err')})});
$('#deletePrompt').addEventListener('click',function(){if(!activePrompt||!activePrompt.id)return;if(!confirm('Delete this prompt?'))return;api('/prompts/'+encodeURIComponent(activePrompt.id),{method:'DELETE'}).then(function(){toast('Prompt deleted','ok');activePrompt=null;refresh()}).catch(function(e){toast(e.message,'err')})});
$('#saveIdentity').addEventListener('click',function(){
  var meta={};try{meta=JSON.parse($('#idMeta').value||'{}')}catch(e){toast('Metadata is not valid JSON','err');return}
  api('/identity',{method:'POST',body:{name:$('#idName').value,owner:$('#idOwner').value,metadata:meta}})
    .then(function(){toast('Identity saved','ok');refresh()}).catch(function(e){toast(e.message,'err')});
});

function renderProviders(){
  var el=$('#providerTable');var rows=state.providers||[];
  el.innerHTML='<table><thead><tr><th>Provider</th><th>Status</th><th>Models</th><th>Base URL</th><th>Test</th><th></th></tr></thead><tbody>'+
    rows.map(function(p){
      return '<tr><td><b>'+esc(p.name)+'</b><div class="muted mono">'+esc(p.id)+'</div></td>'+
        '<td>'+pill(!!p.connected,'connected','not set')+(p.has_key?' <span class="muted">key set</span>':'')+(p.is_custom_type?' <span class="pill">custom</span>':'')+'</td>'+
        '<td>'+Object.keys(p.models||{}).length+'</td><td class="mono">'+esc(p.base_url)+'<div>'+(p.supports_tools===false?'<span class="pill off">chat only</span>':'<span class="pill">tools</span>')+'</div></td>'+
        '<td><button class="small" data-test="'+esc(p.id)+'">Test</button> <button class="small" data-chat="'+esc(p.id)+'">Chat</button></td>'+
        '<td><button class="small" data-edit="'+esc(p.id)+'">Edit</button> <button class="small danger" data-del="'+esc(p.id)+'">Delete</button></td></tr>';
    }).join('')+'</tbody></table>';
  el.querySelectorAll('[data-test]').forEach(function(b){b.addEventListener('click',function(){testProvider(b.dataset.test)})});
  el.querySelectorAll('[data-chat]').forEach(function(b){b.addEventListener('click',function(){
    $('#providerStatus').textContent='chat '+b.dataset.chat+'...';
    api('/providers/chat',{method:'POST',body:{provider_id:b.dataset.chat,message:'Reply with exactly: PONG',max_tokens:64}})
      .then(function(res){$('#providerStatus').textContent=res.provider+' / '+res.model+' / '+res.ms+'ms / '+(res.usage&&res.usage.total_tokens||0)+' tokens / '+JSON.stringify(res.content);toast('Chat ok: '+res.content,res.content?'ok':'err')})
      .catch(function(e){$('#providerStatus').textContent='chat failed: '+e.message;toast(e.message,'err')});
  })});
  el.querySelectorAll('[data-edit]').forEach(function(b){b.addEventListener('click',function(){fillProvider(b.dataset.edit)})});
  el.querySelectorAll('[data-del]').forEach(function(b){b.addEventListener('click',function(){if(confirm('Delete provider '+b.dataset.del+'?'))api('/providers/'+encodeURIComponent(b.dataset.del),{method:'DELETE'}).then(function(){toast('Deleted','ok');refresh()}).catch(function(e){toast(e.message,'err')})})});
}
function fillProvider(id){
  var p=(state.providers||[]).find(function(x){return x.id===id});if(!p)return;
  $('#pvId').value=p.id;$('#pvName').value=p.name;$('#pvBase').value=p.base_url||'';$('#pvKey').value='';
  $('#pvDefault').value=p.default_model||'';$('#pvTools').value=p.supports_tools===false?'0':'1';$('#pvModels').value=Object.keys(p.models||{}).map(function(k){var m=p.models[k];return k+'='+(m&&m.name?m.name:k)}).join(', ');
  $('#providerStatus').textContent='editing '+id;
}
$('#clearProviderForm').addEventListener('click',function(){$('#pvId').value='';$('#pvName').value='';$('#pvBase').value='';$('#pvKey').value='';$('#pvDefault').value='';$('#pvTools').value='1';$('#pvModels').value='';$('#providerStatus').textContent=''});
$('#saveProvider').addEventListener('click',function(){
  var pid=$('#pvId').value.trim();
  var name=$('#pvName').value.trim();
  if(!pid&&name)pid='custom:'+name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
  if(!name&&pid)name=pid;
  var body={provider_id:pid,name:name,base_url:$('#pvBase').value.trim(),api_key:$('#pvKey').value,default_model:$('#pvDefault').value.trim(),supports_tools:$('#pvTools').value,models:$('#pvModels').value};
  api('/providers',{method:'POST',body:body}).then(function(res){toast('Provider saved','ok');$('#pvId').value=res.provider.id;$('#providerStatus').textContent='saved '+res.provider.id;refresh()}).catch(function(e){toast(e.message,'err')});
});
$('#testProvider').addEventListener('click',function(){testProvider($('#pvId').value.trim())});
function testProvider(id){
  if(!id){toast('Provider id is required','err');return}
  $('#providerStatus').textContent='testing '+id;
  api('/providers/test',{method:'POST',body:{provider_id:id,model:$('#pvDefault').value.trim(),api_key:$('#pvKey').value,base_url:$('#pvBase').value.trim(),models:$('#pvModels').value}})
    .then(function(res){$('#providerStatus').textContent=res.ok?'ok / '+Object.keys(res.models||{}).length+' models':('failed: '+res.error);toast(res.ok?'Provider test passed':'Provider test failed',res.ok?'ok':'err');refresh()})
    .catch(function(e){$('#providerStatus').textContent='failed: '+e.message;toast(e.message,'err')});
}

function renderTools(){
  var rows=state.tools||[];var el=$('#toolTable');
  el.innerHTML='<table><thead><tr><th>Tool</th><th>Source</th><th>Mode</th><th>Status</th><th></th></tr></thead><tbody>'+
    rows.map(function(t){return '<tr><td><b>'+esc(t.name)+'</b><div class="muted">'+esc(t.description||'')+'</div>'+(t.external_name?'<div class="mono muted">MCP name: '+esc(t.external_name)+'</div>':'')+'</td>'+
      '<td>'+esc(t.source)+(t.mcp_server_id?'<div class="muted mono">'+esc(t.mcp_server_id)+'</div>':'')+'</td>'+
      '<td>'+(t.read_only?'read-only':'write')+'</td><td>'+pill(!!t.enabled,'enabled','disabled')+'</td>'+
      '<td><button class="small" data-toggle="'+esc(t.id)+'" data-enabled="'+(t.enabled?0:1)+'">'+(t.enabled?'Disable':'Enable')+'</button></td></tr>'}).join('')+'</tbody></table>';
  el.querySelectorAll('[data-toggle]').forEach(function(b){b.addEventListener('click',function(){
    api('/tools/'+encodeURIComponent(b.dataset.toggle)+'/toggle',{method:'POST',body:{enabled:b.dataset.enabled==='1'}})
      .then(function(){toast('Tool updated','ok');refresh()}).catch(function(e){toast(e.message,'err')});
  })});
  var sel=$('#runToolName');var current=sel.value;sel.innerHTML=rows.map(function(t){return '<option value="'+esc(t.name)+'">'+esc(t.name)+'</option>'}).join('');if(current)sel.value=current;
}
$('#runTool').addEventListener('click',function(){
  var input={};try{input=JSON.parse($('#runToolInput').value||'{}')}catch(e){toast('Arguments are not valid JSON','err');return}
  $('#runToolStatus').textContent='running...';$('#runToolOutput').textContent='';
  api('/tools/run',{method:'POST',body:{name:$('#runToolName').value,input:input}})
    .then(function(res){$('#runToolStatus').textContent=res.ok?'ok':'failed';$('#runToolOutput').textContent=JSON.stringify(res,null,2)})
    .catch(function(e){$('#runToolStatus').textContent='failed';$('#runToolOutput').textContent=e.message});
});

function renderMcp(){
  var rows=state.mcp||[];var el=$('#mcpTable');
  el.innerHTML='<table><thead><tr><th>Server</th><th>Status</th><th>Auth</th><th>Tools</th><th>Session</th><th></th></tr></thead><tbody>'+
    rows.map(function(m){return '<tr><td><b>'+esc(m.name)+'</b><div class="mono muted">'+esc(m.url)+'</div><div class="muted mono">'+esc(m.id)+'</div></td>'+
      '<td><span class="pill '+(m.status==='connected'?'on':(m.status==='error'?'err':'off'))+'">'+esc(m.status)+'</span>'+(m.last_error?'<div class="err mono">'+esc(m.last_error)+'</div>':'')+'</td>'+
      '<td>'+esc(m.auth_type)+(m.has_auth?' / set':'')+'</td><td>'+(m.tools||[]).length+'</td><td class="mono">'+esc(m.session_id||'-')+'</td>'+
      '<td><button class="small" data-connect="'+esc(m.id)+'">Connect</button> <button class="small" data-toggle="'+esc(m.id)+'" data-enabled="'+(m.enabled?0:1)+'">'+(m.enabled?'Disable':'Enable')+'</button> <button class="small danger" data-del="'+esc(m.id)+'">Delete</button></td></tr>'}).join('')+'</tbody></table>';
  el.querySelectorAll('[data-connect]').forEach(function(b){b.addEventListener('click',function(){api('/mcp/'+encodeURIComponent(b.dataset.connect)+'/connect',{method:'POST',body:{}}).then(function(res){toast(res.ok?'MCP connected':'MCP failed: '+res.error,res.ok?'ok':'err');refresh()}).catch(function(e){toast(e.message,'err')})})});
  el.querySelectorAll('[data-toggle]').forEach(function(b){b.addEventListener('click',function(){api('/mcp/'+encodeURIComponent(b.dataset.toggle)+'/toggle',{method:'POST',body:{enabled:b.dataset.enabled==='1'}}).then(function(){toast('MCP updated','ok');refresh()}).catch(function(e){toast(e.message,'err')})})});
  el.querySelectorAll('[data-del]').forEach(function(b){b.addEventListener('click',function(){if(confirm('Delete this MCP server and its tools?'))api('/mcp/'+encodeURIComponent(b.dataset.del),{method:'DELETE'}).then(function(){toast('MCP deleted','ok');refresh()}).catch(function(e){toast(e.message,'err')})})});
}
$('#addMcp').addEventListener('click',function(){
  var body={name:$('#mcpName').value.trim(),url:$('#mcpUrl').value.trim(),auth_type:$('#mcpAuthType').value,auth_header:$('#mcpAuthHeader').value.trim(),auth_value:$('#mcpToken').value,enabled:$('#mcpEnabled').value==='1'};
  api('/mcp',{method:'POST',body:body}).then(function(res){
    toast('MCP added','ok');refresh();
    if(res.mcp&&res.mcp.id)api('/mcp/'+encodeURIComponent(res.mcp.id)+'/connect',{method:'POST',body:{}}).then(function(out){toast(out.ok?'MCP connected':'MCP connect failed: '+out.error,out.ok?'ok':'err');refresh()});
  }).catch(function(e){toast(e.message,'err')});
});

function renderSessions(){
  var rows=state.sessions||[];var el=$('#sessionList');el.innerHTML='';
  if(!rows.length){el.innerHTML='<div class="muted">No sessions yet.</div>';return}
  rows.forEach(function(s){var d=document.createElement('div');d.className='item'+(activeSession===s.id?' active':'');
    d.innerHTML='<div style="font-weight:600">'+esc(s.title||'Untitled')+'</div><div class="muted">'+new Date((s.updated_at||0)*1000).toLocaleString()+' / '+s.message_count+' messages / '+esc(s.last_status||'')+'</div><div class="muted mono">'+esc(s.provider||'')+' / '+esc(s.model||'')+' · '+fmtNum(s.total_tokens||0)+' tokens · '+fmtMs(s.duration_ms||0)+'</div>';
    d.addEventListener('click',function(){loadSession(s.id)});el.appendChild(d)});
}
function loadSession(id){
  activeSession=id;renderSessions();
  api('/sessions/'+encodeURIComponent(id)).then(function(res){
    var detail=$('#sessionDetail');
    if(!res.conversation){detail.textContent='Session not found.';return}
    var conv=res.conversation;
    detail.innerHTML='<div class="row" style="justify-content:space-between"><div><b>'+esc(conv.title)+'</b><div class="muted mono">'+esc(conv.id)+' / '+esc(conv.provider)+' / '+esc(conv.model)+' / '+esc(conv.mode)+'</div></div><button class="small danger" id="deleteSession">Delete</button></div><div class="chat" id="sessionChat">'+
      (conv.messages||[]).map(function(m){var text=m.content||'';if(!text&&m.parts)text=m.parts.map(function(p){return p.text||(p.name?'['+p.name+'] ':'')}).join('\n');return '<div class="msg '+(m.role==='user'?'user':'')+'"><div class="role">'+esc(m.role)+'</div>'+esc(text)+'</div>'}).join('')+'</div>';
    var db=$('#deleteSession');if(db)db.addEventListener('click',function(){if(confirm('Delete this session?'))api('/sessions/'+encodeURIComponent(id),{method:'DELETE'}).then(function(){toast('Session deleted','ok');activeSession=null;$('#sessionDetail').textContent='Select a session.';refresh()}).catch(function(e){toast(e.message,'err')})});
  }).catch(function(e){toast(e.message,'err')});
}

function renderLogs(){
  var rows=state.logs||[];$('#logTable').innerHTML='<table><thead><tr><th>Time</th><th>Level</th><th>Event</th><th>Detail</th></tr></thead><tbody>'+
    rows.map(function(l){return '<tr><td class="mono">'+esc(l.time)+'</td><td><span class="pill '+(l.level==='ERROR'?'err':(l.level==='WARN'?'':'on'))+'">'+esc(l.level)+'</span></td><td>'+esc(l.event)+'</td><td class="mono">'+esc(JSON.stringify(l.detail))+'</td></tr>'}).join('')+'</tbody></table>';
}

function refresh(){
  api('/state').then(function(res){state=res;render()}).catch(function(e){
    if(String(e.message).indexOf('401')!==-1){$('#health').textContent='admin token required';$('#health').className='badge err'}
    else{$('#health').textContent='offline: '+e.message;$('#health').className='badge err'}
  });
}
setInterval(refresh,5000);
refresh();
})();
`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

function create(core) {
  return {
    page: pageHtml,
    clientScript,
    async handle(req, res, url) {
      const route = url.pathname.replace(/\/+$/, "");
      const suffix = route.slice("/api/admin".length) || "/";
      const method = req.method || "GET";
      try {
        if (method === "GET" && (suffix === "/state" || suffix === "/")) {
          return send(res, 200, { ok: true, ...core.state() });
        }
        if (method === "GET" && suffix === "/metrics") {
          return send(res, 200, { ok: true, ...core.metrics() });
        }
        if (method === "GET" && suffix === "/requests") {
          return send(res, 200, { ok: true, requests: core.requests() });
        }
        if (method === "POST" && suffix === "/projects") {
          const body = await readJson(req);
          const project = core.createProject(body);
          return send(res, 200, { ok: true, project });
        }
        let projectMatch = suffix.match(/^\/projects\/([^/]+)\/(activate|close)$/);
        if (method === "POST" && projectMatch) {
          const id = decodeURIComponent(projectMatch[1]);
          const action = projectMatch[2];
          if (action === "activate") {
            const project = core.activateProject(id);
            return send(res, project ? 200 : 404, project ? { ok: true, project } : { ok: false, error: "project not found" });
          }
          const ok = core.closeProject(id);
          return send(res, ok ? 200 : 404, ok ? { ok: true } : { ok: false, error: "project not found" });
        }
        projectMatch = suffix.match(/^\/projects\/([^/]+)$/);
        if (method === "DELETE" && projectMatch) {
          const ok = core.deleteProject(decodeURIComponent(projectMatch[1]));
          return send(res, ok ? 200 : 404, ok ? { ok: true } : { ok: false, error: "project not found" });
        }
        if (method === "POST" && suffix === "/agent/run") {
          const body = await readJson(req);
          const result = await core.runTask(body);
          return send(res, 200, { ok: !!result.ok, ...result });
        }
        if (method === "GET" && suffix === "/prompts") {
          return send(res, 200, { ok: true, prompts: core.listPrompts() });
        }
        if (method === "POST" && suffix === "/prompts") {
          const body = await readJson(req);
          const prompt = core.savePrompt(body);
          return send(res, 200, { ok: true, prompt });
        }
        let match = suffix.match(/^\/prompts\/([^/]+)\/activate$/);
        if (method === "POST" && match) {
          const ok = core.activatePrompt(decodeURIComponent(match[1]));
          return send(res, 200, ok ? { ok: true } : { ok: false, error: "prompt not found" });
        }
        match = suffix.match(/^\/prompts\/([^/]+)$/);
        if (method === "DELETE" && match) {
          const ok = core.deletePrompt(decodeURIComponent(match[1]));
          return send(res, 200, ok ? { ok: true } : { ok: false, error: "active or missing prompt cannot be deleted" });
        }
        if (method === "GET" && suffix === "/providers") {
          return send(res, 200, { ok: true, providers: core.providers() });
        }
        if (method === "POST" && suffix === "/providers/test") {
          const body = await readJson(req);
          const result = await core.testProvider(body);
          return send(res, 200, { ok: !!result.ok, ...result });
        }
        if (method === "POST" && suffix === "/providers/chat") {
          const body = await readJson(req);
          const result = await core.chatProvider(body);
          return send(res, 200, result);
        }
        if (method === "POST" && suffix === "/providers") {
          const body = await readJson(req);
          const provider = core.saveProvider(body);
          return send(res, 200, { ok: true, provider });
        }
        match = suffix.match(/^\/providers\/([^/]+)$/);
        if (method === "DELETE" && match) {
          const ok = core.deleteProvider(decodeURIComponent(match[1]));
          return send(res, 200, ok ? { ok: true } : { ok: false, error: "provider not found" });
        }
        if (method === "GET" && suffix === "/tools") {
          return send(res, 200, { ok: true, tools: core.tools() });
        }
        match = suffix.match(/^\/tools\/([^/]+)\/toggle$/);
        if (method === "POST" && match) {
          const body = await readJson(req);
          const ok = core.setToolEnabled(decodeURIComponent(match[1]), !!body.enabled);
          return send(res, 200, ok ? { ok: true } : { ok: false, error: "tool not found" });
        }
        if (method === "POST" && suffix === "/tools/run") {
          const body = await readJson(req);
          const result = await core.runTool(body.name, body.input);
          return send(res, 200, { ok: !!result.ok, ...result });
        }
        if (method === "GET" && suffix === "/mcp") {
          return send(res, 200, { ok: true, mcp: core.mcp() });
        }
        if (method === "POST" && suffix === "/mcp") {
          const body = await readJson(req);
          const server = core.addMcp(body);
          return send(res, 200, { ok: true, mcp: server });
        }
        match = suffix.match(/^\/mcp\/([^/]+)\/connect$/);
        if (method === "POST" && match) {
          const result = await core.connectMcp(decodeURIComponent(match[1]));
          return send(res, 200, { ok: !!result.ok, ...result });
        }
        match = suffix.match(/^\/mcp\/([^/]+)\/refresh$/);
        if (method === "POST" && match) {
          const result = await core.refreshMcp(decodeURIComponent(match[1]));
          return send(res, 200, { ok: !!result.ok, ...result });
        }
        match = suffix.match(/^\/mcp\/([^/]+)\/toggle$/);
        if (method === "POST" && match) {
          const body = await readJson(req);
          const ok = core.setMcpEnabled(decodeURIComponent(match[1]), !!body.enabled);
          return send(res, 200, ok ? { ok: true } : { ok: false, error: "MCP server not found" });
        }
        match = suffix.match(/^\/mcp\/([^/]+)$/);
        if (method === "DELETE" && match) {
          const ok = core.deleteMcp(decodeURIComponent(match[1]));
          return send(res, 200, ok ? { ok: true } : { ok: false, error: "MCP server not found" });
        }
        if (method === "PATCH" && match) {
          const body = await readJson(req);
          const server = core.updateMcp(decodeURIComponent(match[1]), body);
          return send(res, 200, { ok: !!server, mcp: server });
        }
        if (method === "GET" && suffix === "/sessions") {
          return send(res, 200, { ok: true, sessions: core.sessions() });
        }
        match = suffix.match(/^\/sessions\/([^/]+)$/);
        if (method === "GET" && match) {
          return send(res, 200, { ok: true, conversation: core.conversation(decodeURIComponent(match[1])) });
        }
        if (method === "DELETE" && match) {
          const ok = core.deleteConversation(decodeURIComponent(match[1]));
          return send(res, 200, ok ? { ok: true } : { ok: false, error: "session not found" });
        }
        if (method === "GET" && suffix === "/logs") {
          return send(res, 200, { ok: true, logs: core.state().logs });
        }
        return send(res, 404, { ok: false, error: "unknown admin route: " + method + " " + suffix });
      } catch (error) {
        return send(res, error.status || 500, { ok: false, error: error.message || String(error) });
      }
    },
  };
}

module.exports = { create, pageHtml, clientScript, esc };
