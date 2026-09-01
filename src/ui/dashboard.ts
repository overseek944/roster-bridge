export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>roster-bridge</title>
<style>
:root{--ink:#0f172a;--dim:#475569;--faint:#64748b;--line:#e2e8f0;--bg:#f8fafc;--paper:#fff;
      --blue:#2563eb;--amber:#b45309;--mint:#059669;--red:#b91c1c;
      --mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{background:var(--ink);color:#fff;padding:1.2rem 2rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem}
header h1{margin:0;font-size:1.1rem}header p{margin:.3rem 0 0;color:#94a3b8;font-size:13px}
header input{font-family:var(--mono);padding:.4rem .55rem;border:1px solid #334155;background:#1e293b;color:#fff;width:19rem}
main{max-width:1180px;margin:0 auto;padding:2rem}
section{background:var(--paper);border:1px solid var(--line);margin-bottom:1.5rem}
section>h2{margin:0;padding:.85rem 1.25rem;border-bottom:1px solid var(--line);font:700 12px/1.4 var(--mono);
           letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}
.body{padding:1.25rem}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;padding:.5rem 1rem .5rem 0;border-bottom:1px solid var(--ink);font:700 11px/1.4 var(--mono);
   letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
td{padding:.65rem 1rem .65rem 0;border-bottom:1px solid var(--line);vertical-align:top}
code,.mono{font-family:var(--mono);font-size:12.5px}
button{border:1px solid var(--ink);background:var(--ink);color:#fff;padding:.5rem .9rem;font-size:13.5px;font-weight:600;cursor:pointer}
button.ghost{background:transparent;color:var(--ink)}
button:disabled{opacity:.45;cursor:default}
.row{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line)}
.tile{background:var(--paper);padding:1rem 1.15rem}
.tile span{display:block;font:600 11px/1.4 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
.tile strong{display:block;margin-top:.35rem;font-size:1.6rem;font-weight:700}
.pass{color:var(--mint)}.warn{color:var(--amber)}.fail{color:var(--red)}
.badge{display:inline-block;padding:.15rem .5rem;font:700 11px/1.5 var(--mono);border:1px solid currentColor}
.check{border-bottom:1px solid var(--line);padding:.9rem 0}
.check:last-child{border-bottom:0}
.check h4{margin:0;font-size:14px}
.check p{margin:.25rem 0 0;color:var(--dim);font-size:13px}
.check .obs{margin-top:.3rem;font-family:var(--mono);font-size:12px;color:var(--faint)}
.muted{color:var(--faint);font-size:13px}
</style></head><body>
<header>
  <div><h1>roster-bridge</h1><p>District rostering and compliance. Nothing is applied until it passes.</p></div>
  <div class="row"><input id="key" type="password" placeholder="admin key" autocomplete="off"/><button id="connect">Connect</button><span id="status" class="muted"></span></div>
</header>
<main>
  <section><h2>Districts</h2><div class="body" id="districts">Not connected.</div></section>
  <section><h2>Sync health</h2><div class="body" id="health">Select a district.</div></section>
  <section><h2>Runs</h2><div class="body" id="runs">Select a district.</div></section>
  <section><h2>Validation</h2><div class="body" id="checks">Select a run.</div></section>
  <section><h2>Compliance</h2><div class="body" id="compliance">Select a district.</div></section>
</main>
<script>
const $=id=>document.getElementById(id);let KEY=sessionStorage.getItem("rbKey")||"";let DIST=null;
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function api(p,o={}){const r=await fetch("/api"+p,{...o,headers:{"x-admin-key":KEY,"content-type":"application/json","x-actor":"console",...(o.headers||{})}});
  if(!r.ok)throw new Error(await r.text()||r.statusText);return r.json();}
async function refresh(){$("status").textContent="loading…";
  try{const d=await api("/districts");renderDistricts(d.districts);$("status").innerHTML='<span class="pass">connected</span>';sessionStorage.setItem("rbKey",KEY);}
  catch(e){$("status").innerHTML='<span class="fail">'+esc(e.message)+'</span>';}}
function renderDistricts(list){
  if(!list.length){$("districts").innerHTML='<p class="muted">No districts configured.</p>';return;}
  $("districts").innerHTML='<table><tr><th>District</th><th>Jurisdiction</th><th>Breach clock</th><th>Retention</th><th></th></tr>'+
    list.map(d=>'<tr><td><strong>'+esc(d.name)+'</strong><br><code>'+esc(d.id)+'</code></td>'+
      '<td>'+esc(d.jurisdiction_name)+'<br><span class="muted">'+esc(d.statute||"")+'</span></td>'+
      '<td class="mono">'+(d.breach_notify_hours/24)+' days</td>'+
      '<td class="mono">'+d.retention_days+' days</td>'+
      '<td><button class="ghost" data-d="'+esc(d.id)+'">Open</button></td></tr>').join('')+'</table>';
  document.querySelectorAll("[data-d]").forEach(b=>b.addEventListener("click",()=>selectDistrict(b.dataset.d)));}
async function selectDistrict(id){DIST=id;await Promise.all([loadHealth(),loadRuns(),loadCompliance()]);}
async function loadHealth(){const h=await api("/districts/"+DIST+"/health");
  const c=h.counts;const stale=h.hoursSinceSuccess;
  $("health").innerHTML='<div class="tiles">'+
    tile("people",c.people)+tile("classes w/o students",c.classesWithNoStudents)+
    tile("classes w/o teacher",c.classesWithNoTeacher)+tile("people w/o enrolment",c.peopleWithNoEnrollment)+
    tile("hours since success",stale===null?"never":stale)+'</div>'+
    '<div class="row" style="margin-top:1.25rem"><button id="sync">Start sync</button>'+
    '<span class="muted">latest: '+(h.latestRun?esc(h.latestRun.state)+' '+esc(h.latestRun.message||""):"none")+'</span></div>';
  $("sync").addEventListener("click",startSync);}
function tile(label,value){return '<div class="tile"><span>'+esc(label)+'</span><strong>'+esc(value)+'</strong></div>';}
async function startSync(){const b=$("sync");b.disabled=true;b.textContent="running…";
  try{const {runId}=await api("/districts/"+DIST+"/sync",{method:"POST",body:"{}"});
    let done=false,guard=0;
    while(!done&&guard++<40){const r=await api("/runs/"+runId+"/drive?steps=25",{method:"POST"});
      b.textContent=r.state+" …";done=r.done;}
    await loadRuns();await loadHealth();await showRun(runId);}
  catch(e){alert(e.message);}finally{const nb=$("sync");if(nb){nb.disabled=false;nb.textContent="Start sync";}}}
async function loadRuns(){const {runs}=await api("/districts/"+DIST+"/runs");
  if(!runs.length){$("runs").innerHTML='<p class="muted">No runs yet.</p>';return;}
  $("runs").innerHTML='<table><tr><th>Run</th><th>State</th><th>Started</th><th>Diff</th><th></th></tr>'+
    runs.map(r=>{const cls=r.state==="applied"?"pass":r.state==="quarantined"?"warn":r.state==="failed"?"fail":"";
      const d=r.stats&&r.stats.diff?Object.entries(r.stats.diff).map(([k,v])=>k+" +"+v.created+"/~"+v.updated).join("  "):"";
      return '<tr><td><code>'+esc(r.id)+'</code></td><td><span class="badge '+cls+'">'+esc(r.state)+'</span>'+
        (r.message?'<br><span class="muted">'+esc(r.message)+'</span>':'')+'</td>'+
        '<td class="mono">'+esc(String(r.startedAt).slice(5,19).replace("T"," "))+'</td>'+
        '<td class="mono" style="font-size:11.5px">'+esc(d)+'</td>'+
        '<td><button class="ghost" data-r="'+esc(r.id)+'">Checks</button></td></tr>';}).join('')+'</table>';
  document.querySelectorAll("[data-r]").forEach(b=>b.addEventListener("click",()=>showRun(b.dataset.r)));}
async function showRun(runId){const {run,validation}=await api("/runs/"+runId);
  $("checks").innerHTML='<p class="muted">Run <code>'+esc(run.id)+'</code> — <strong>'+esc(run.state)+'</strong>'+
    (run.message?" — "+esc(run.message):"")+'</p>'+
    validation.map(v=>'<div class="check"><h4><span class="badge '+esc(v.outcome==="pass"?"pass":v.outcome==="warn"?"warn":"fail")+'">'+
      esc(v.outcome)+'</span> &nbsp;'+esc(v.check_name)+'</h4><p>'+esc(v.detail)+'</p>'+
      '<div class="obs">observed: '+esc(v.observed)+(v.threshold?"   ·   threshold: "+esc(v.threshold):"")+'</div></div>').join('');}
async function loadCompliance(){const clock=await fetch("/api/compliance/districts/"+DIST+"/incident-clock",
    {headers:{"x-admin-key":KEY}}).then(r=>r.json());
  $("compliance").innerHTML=
    '<div class="row"><input id="q" placeholder="find a student" style="padding:.4rem .5rem;border:1px solid var(--line)"/>'+
    '<button id="find" class="ghost">Search</button>'+
    '<button id="dryrun" class="ghost">Retention dry run</button></div>'+
    '<p class="muted" style="margin-top:1rem">Breach notification: <strong>'+esc(clock.breachNotification&&clock.breachNotification.within)+
    '</strong> from '+esc(clock.breachNotification&&clock.breachNotification.from)+' · framework '+esc(clock.securityFramework)+
    ' · '+esc(clock.jurisdiction&&clock.jurisdiction.statute)+'</p><div id="cresult"></div>';
  $("find").addEventListener("click",async()=>{const q=$("q").value;
    const {people}=await api("/districts/"+DIST+"/people?q="+encodeURIComponent(q));
    $("cresult").innerHTML=people.length?'<table><tr><th>Name</th><th>Grade</th><th>Email</th><th></th></tr>'+
      people.map(p=>'<tr><td>'+esc(p.given_name)+' '+esc(p.family_name)+'</td><td class="mono">'+esc(p.grade_level||"-")+
      '</td><td class="mono">'+esc(p.email||"none")+'</td><td><button class="ghost" data-p="'+esc(p.id)+'">Record</button></td></tr>').join('')+
      '</table>':'<p class="muted">No match.</p>';
    document.querySelectorAll("[data-p]").forEach(b=>b.addEventListener("click",()=>showRecord(b.dataset.p)));});
  $("dryrun").addEventListener("click",async()=>{
    const r=await fetch("/api/compliance/districts/"+DIST+"/deletion-jobs",{method:"POST",
      headers:{"x-admin-key":KEY,"content-type":"application/json","x-actor":"console"},body:JSON.stringify({dryRun:true})}).then(r=>r.json());
    $("cresult").innerHTML='<pre class="mono" style="background:var(--bg);padding:1rem;overflow:auto">'+esc(JSON.stringify(r,null,2))+'</pre>';});}
async function showRecord(personId){
  const r=await fetch("/api/compliance/districts/"+DIST+"/persons/"+personId+"/record",
    {headers:{"x-admin-key":KEY,"x-actor":"console"}}).then(r=>r.json());
  $("cresult").innerHTML='<pre class="mono" style="background:var(--bg);padding:1rem;overflow:auto;max-height:32rem">'+esc(JSON.stringify(r,null,2))+'</pre>';}
$("connect").addEventListener("click",()=>{KEY=$("key").value.trim();refresh();});
$("key").addEventListener("keydown",e=>{if(e.key==="Enter")$("connect").click();});
if(KEY){$("key").value=KEY;refresh();}
</script></body></html>`;
