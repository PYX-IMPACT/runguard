const api=makeApi("rg_owner");
const VIEWS=[["users","Verifiers"],["db","Raw database"],["audit","Audit log"]];
let view="users",dbT="",dbOff=0;
const show=on=>{$("lf").hidden=on;$("app").hidden=!on;};
const dt=ms=>ms?new Date(ms).toLocaleString([],{dateStyle:"medium",timeStyle:"short"}):"never";

async function start(){
  if(!sessionStorage.getItem("rg_owner"))return show(false);
  try{await api("/me");show(true);render();}catch(e){show(false);$("msg").textContent=e.message;}
}
$("lf").onsubmit=async e=>{
  e.preventDefault();$("msg").textContent="";
  try{
    const r=await fetch(API+"/owner/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:$("pw").value})});
    const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||"Login failed");
    sessionStorage.setItem("rg_owner",j.token);$("pw").value="";start();
  }catch(err){$("msg").textContent=err.message;}
};
$("out").onclick=async()=>{try{await api("/logout",{method:"POST"});}catch{}sessionStorage.removeItem("rg_owner");show(false);};

async function render(){
  $("nav").innerHTML=VIEWS.map(([k,l])=>`<button class="tab ${k==view?"on":""}" data-view="${k}">${l}</button>`).join("");
  try{await({users,db,audit}[view]());}
  catch(e){if(e.auth){show(false);$("msg").textContent=e.message;}else $("main").innerHTML=`<p class="empty">${esc(e.message)}</p>`;}
}
async function users(){
  const u=await api("/owner/users");
  const row=x=>`<tr><td><b>${esc(x.global_name||x.username||"(not logged in yet)")}</b><span class="dim">${esc(x.username||"")}</span></td>
    <td><code>${esc(x.discord_id)}</code></td><td><span class="badge ${esc(x.role)}">${esc(x.role)}</span></td><td>${esc(dt(x.last_login))}</td>
    <td class="act">${x.role!="verifier"?`<button class="btn green" data-act="verifier" data-id="${esc(x.discord_id)}">Approve</button>`:""}
    ${x.role!="blocked"?`<button class="btn red" data-act="blocked" data-id="${esc(x.discord_id)}">Block</button>`:""}
    <button class="btn" data-act="remove" data-id="${esc(x.discord_id)}">Remove</button></td></tr>`;
  $("main").innerHTML=`<section class="card"><h2>Add a verifier by Discord ID</h2>
    <p class="dim">In Discord: Settings, Advanced, turn on Developer Mode. Then right-click the person and choose Copy User ID. Or let them log in once and approve them from the list below.</p>
    <form id="addf" class="addf"><input id="aid" placeholder="Discord user ID (digits)" inputmode="numeric" aria-label="Discord user ID"><input id="alab" placeholder="Label (optional)" aria-label="Label"><button class="btn primary" type="submit">Approve as verifier</button></form><p id="addmsg" role="alert"></p></section>
    <section class="card"><h2>People (${u.length})</h2><div class="scroll"><table class="tbl"><thead><tr><th>Name</th><th>Discord ID</th><th>Status</th><th>Last login</th><th></th></tr></thead><tbody>${u.map(row).join("")||'<tr><td colspan="5" class="dim">Nobody yet.</td></tr>'}</tbody></table></div></section>`;
}
async function db(){
  const d=await api(`/owner/db?table=${encodeURIComponent(dbT)}&offset=${dbOff}`);dbT=d.table||"";
  const cols=d.rows[0]?Object.keys(d.rows[0]):[];
  const cell=v=>{const s=v==null?"":String(v);return `<td title="${esc(s)}">${esc(s.length>90?s.slice(0,90)+"…":s)}</td>`;};
  $("main").innerHTML=`<section class="card"><div class="dbbar"><select id="dbt" aria-label="Table">${d.tables.map(t=>`<option value="${esc(t.name)}" ${t.name==d.table?"selected":""}>${esc(t.name)} (${t.count})</option>`).join("")}</select>
    <span class="dim">Read-only. Rows ${d.total?d.offset+1:0}-${d.offset+d.rows.length} of ${d.total}, newest first.</span>
    <button class="btn" data-pg="-1" ${d.offset<=0?"disabled":""}>Prev</button><button class="btn" data-pg="1" ${d.offset+50>=d.total?"disabled":""}>Next</button></div>
    <div class="scroll"><table class="tbl"><thead><tr>${cols.map(c=>`<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${d.rows.map(r=>`<tr>${cols.map(c=>cell(r[c])).join("")}</tr>`).join("")}</tbody></table></div></section>`;
}
async function audit(){
  const a=await api("/owner/audit");
  $("main").innerHTML=`<section class="card"><h2>Audit log (last 200)</h2><div class="scroll"><table class="tbl"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>${a.map(x=>`<tr><td>${esc(dt(x.at))}</td><td>${esc(x.actor)}</td><td>${esc(x.action)}</td><td>${esc(x.target)}</td><td>${esc(x.detail)}</td></tr>`).join("")}</tbody></table></div></section>`;
}
async function setUser(id,role){await api("/owner/users",{method:"POST",body:JSON.stringify({discord_id:id,role})});render();}
document.addEventListener("click",async e=>{
  const t=e.target;
  try{
    if(t.dataset.view){view=t.dataset.view;render();}
    else if(t.dataset.pg){dbOff=Math.max(0,dbOff+50*Number(t.dataset.pg));render();}
    else if(t.dataset.act=="remove"){if(confirm("Remove this person completely? They can request access again by logging in."))await api("/owner/users?id="+encodeURIComponent(t.dataset.id),{method:"DELETE"}),render();}
    else if(t.dataset.act)await setUser(t.dataset.id,t.dataset.act);
  }catch(err){alert(err.message);}
});
document.addEventListener("change",e=>{if(e.target.id=="dbt"){dbT=e.target.value;dbOff=0;render();}});
document.addEventListener("submit",async e=>{
  if(e.target.id!="addf")return;e.preventDefault();
  try{await api("/owner/users",{method:"POST",body:JSON.stringify({discord_id:$("aid").value,label:$("alab").value,role:"verifier"})});render();}
  catch(err){$("addmsg").textContent=err.message;}
});
start();
