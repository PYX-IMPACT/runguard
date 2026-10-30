const API="https://runguard-api.runguard-database.workers.dev";
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt=ms=>`${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,"0")}.${String(ms%1000).padStart(3,"0")}`;
const when=s=>new Date(String(s).replace(" ","T")+"Z").toLocaleString([],{dateStyle:"medium",timeStyle:"short"});
const reasons=r=>JSON.parse(r.reasons||"[]");
const TABS=[["flagged","Flagged"],["review","Review"],["unflagged","Unflagged"],["all","All"]];
const RV={pending:"Pending",confirmed_cheat:"Cheat confirmed",cleared:"Cleared"};
let token=sessionStorage.getItem("rg")||"",rows=[],tab="flagged",q="",pendOnly=false,cur=null;

async function api(path,opt={}){
  const r=await fetch(API+path,{...opt,headers:{authorization:"Bearer "+token,"content-type":"application/json"}});
  if(!r.ok)throw new Error(r.status==401?"Wrong password.":"Server error "+r.status+". Try again.");
  return r.json();
}
async function load(){
  try{rows=await api("/runs");$("login").hidden=true;$("app").hidden=false;draw();if(cur){const n=rows.find(x=>x.id==cur.id);if(n)openRun(n.id);}}
  catch(e){$("msg").textContent=e.message;$("login").hidden=false;$("app").hidden=true;}
}
function vis(){const k=q.toLowerCase();return rows.filter(r=>(tab=="all"||r.status==tab)&&(!pendOnly||r.review_state=="pending")&&(!k||[r.player_name,r.player_login,r.map_name,r.run_id,r.reasons].join(" ").toLowerCase().includes(k)));}
function runHtml(r){
  const why=reasons(r).map(x=>`<em>${esc(x)}</em>`).join("")||'<span class="ok">No issues found</span>';
  return `<div class="run ${esc(r.status)}" data-id="${r.id}" tabindex="0"><div class="who"><b>${esc(r.player_name||r.player_login)}</b><span>${esc(r.map_name)}</span></div>
  <div class="time">${fmt(r.race_time_ms||0)}<span>${esc(when(r.created_at))}</span></div><div class="why">${why}</div>
  <div class="rv ${esc(r.review_state)}">${esc(RV[r.review_state]||r.review_state)}</div></div>`;
}
function draw(){
  $("tabs").innerHTML=TABS.map(([k,l])=>`<button class="tab ${k==tab?"on":""}" data-tab="${k}">${l}<i>${k=="all"?rows.length:rows.filter(r=>r.status==k).length}</i></button>`).join("");
  const v=vis();
  $("list").innerHTML=v.length?v.map(runHtml).join(""):'<p class="empty">No runs here yet. Reports appear when a player finishes a run with upload turned on.</p>';
}
function openRun(id){
  const r=rows.find(x=>x.id==id);if(!r)return;cur=r;const j=JSON.parse(r.report);
  const m=(l,v,u="")=>`<div class="m"><span>${l}</span><b>${esc(v)}${u}</b></div>`,n=k=>Number(j[k])||0;
  const evs=(j.events||[]).map(e=>`<li class="${esc(e.severity)}"><span>${((e.real_ms||0)/1000).toFixed(1)}s</span><div><b>${esc(e.kind)}</b> ${esc(e.detail)}</div></li>`).join("")||"<li><span></span><div>No events recorded.</div></li>";
  const pl=String(j.plugins||"").split("; ").filter(Boolean).map(p=>`<em>${esc(p)}</em>`).join("")||"<em>None listed</em>";
  const why=reasons(r).map(x=>`<em>${esc(x)}</em>`).join("")||'<span class="ok">No issues found</span>';
  $("drawer").innerHTML=`<button class="btn" id="close" style="float:right">Close</button>
   <h2>${esc(r.player_name||r.player_login)}</h2><p class="sub">${esc(r.map_name)} | ${fmt(r.race_time_ms||0)} | ${esc(r.run_id)}</p>
   <div class="pills">${why}</div>
   <div class="grid">${m("Top speed",n("max_speed_kmh").toFixed(0)," km/h")}${m("Peak acceleration",n("max_accel").toFixed(0)," m/s²")}${m("Largest jump",n("max_excess_jump_m").toFixed(1)," m")}
   ${m("Respawns",n("respawns"))}${m("Gas toggles",n("max_gas_toggles_per_s")," /s")}${m("Steer presses",n("max_steer_presses_per_s")," /s")}</div>
   <div class="acts"><button class="btn red" data-mark="confirmed_cheat">Confirm cheat</button><button class="btn green" data-mark="cleared">Clear run</button><button class="btn" data-mark="pending">Reset</button></div>
   <input id="note" placeholder="Add a note" value="${esc(r.review_note)}" aria-label="Review note">
   <h3>Events</h3><ul class="ev">${evs}</ul><h3>Plugins running (plugin ${esc(r.plugin_version)}, login ${esc(r.player_login)})</h3><div class="pills">${pl}</div>
   <details><summary>Raw report</summary><pre>${esc(JSON.stringify(j,null,2))}</pre></details>`;
  $("drawer").classList.add("open");$("veil").classList.add("on");
}
function closeRun(){cur=null;$("drawer").classList.remove("open");$("veil").classList.remove("on");}
document.addEventListener("click",async e=>{
  const t=e.target,row=t.closest(".run");
  if(t.dataset.tab){tab=t.dataset.tab;draw();}
  else if(t.id=="close"||t.id=="veil")closeRun();
  else if(t.dataset.mark){
    try{await api("/review",{method:"POST",body:JSON.stringify({id:cur.id,state:t.dataset.mark,note:$("note").value})});await load();}
    catch(err){alert(err.message);}
  } else if(row)openRun(row.dataset.id);
});
document.addEventListener("keydown",e=>{if(e.key=="Escape")closeRun();if(e.key=="Enter"&&e.target.classList?.contains("run"))openRun(e.target.dataset.id);});
$("q").oninput=e=>{q=e.target.value;draw();};$("pend").onchange=e=>{pendOnly=e.target.checked;draw();};
$("refresh").onclick=load;
$("login").onsubmit=e=>{e.preventDefault();token=$("tok").value;sessionStorage.setItem("rg",token);$("msg").textContent="";load();};
$("out").onclick=()=>{sessionStorage.removeItem("rg");token="";cur=null;closeRun();$("app").hidden=true;$("login").hidden=false;};
if(token)load();
