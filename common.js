const API="https://runguard-api.runguard-database.workers.dev";
if(window.top!==window.self)document.documentElement.innerHTML=""; // refuse to be framed
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt=ms=>`${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,"0")}.${String(ms%1000).padStart(3,"0")}`;
const when=s=>new Date(String(s).replace(" ","T")+"Z").toLocaleString([],{dateStyle:"medium",timeStyle:"short"});
function makeApi(key){
  return async(path,opt={})=>{
    const r=await fetch(API+path,{...opt,headers:{authorization:"Bearer "+(sessionStorage.getItem(key)||""),"content-type":"application/json"}});
    if(r.status===401){sessionStorage.removeItem(key);throw Object.assign(new Error("Session expired. Please log in again."),{auth:true});}
    if(!r.ok){let m="";try{m=(await r.json()).error}catch{}throw new Error(m||"Server error "+r.status+". Try again.");}
    return r.json();
  };
}
