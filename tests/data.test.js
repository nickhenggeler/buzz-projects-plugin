import { buildModel, loadModel, filterModel, apply, inject } from "../plugin.js";
const O="a".repeat(64);
const ev=(kind,tags,created_at=10,content="",pubkey=O,id=kind+":"+created_at)=>({kind,tags,created_at,content,pubkey,id});
let n=0; const eq=(a,b,m)=>{n++; const x=JSON.stringify(a),y=JSON.stringify(b); if(x!==y) throw new Error(m+": "+x+" != "+y)};
const repos=[
  ev(30617,[["d","alpha"],["name","Alpha"],["buzz-channel","c1"]],10),
  ev(30617,[["d","alpha"],["name","Alpha new"],["buzz-channel","c1"]],20),
  ev(30617,[["d","beta"]],10,"desc"),
  ev(30617,[["d","gone"]],10),
  ev(30617,[["d","solo"],["description","alone"]],10)];
const projects=[ev(30621,[["d","core"],["name","Core"],["description","main"],["buzz-channel","c0"],["a",`30617:${O}:alpha`],["a",`30617:${O}:beta`],["a",`30617:${O}:gone`],["a",`30617:${O}:missing`]],10)];
const del=[ev(5,[["a",`30617:${O}:gone`]],11)];
const m=buildModel(projects,repos,del);
eq(m.projects.length,1,"projects"); eq(m.projects[0].repos.map(r=>r.name),["Alpha new","beta"],"member repos, newest head, deleted dropped");
eq(m.projects[0].missing,2,"missing count"); eq(m.unassigned.map(r=>r.dtag),["solo"],"unassigned");
eq(m.projects[0].repos[1].description,"desc","content fallback");
eq(buildModel([],[ev(30617,[["d","x"]],20)],[ev(5,[["a",`30617:${O}:x`]],10)]).unassigned.length,1,"old delete ignored");
eq(buildModel([],[ev(30617,[["d","x"]],10)],[ev(5,[["a",`30617:${O}:x`]],11,"","b".repeat(64))]).unassigned.length,1,"foreign delete ignored");
eq(filterModel(m,"bet").projects[0].repos.map(r=>r.dtag),["beta"],"filter repo"); eq(filterModel(m,"core").projects[0].repos.length,2,"filter project keeps repos"); eq(filterModel(m,"zzz").projects.length+filterModel(m,"zzz").unassigned.length,0,"filter none");
const calls=[]; const session={read:async(f)=>{calls.push(f[0]); const k=f[0].kinds[0]; return k===30621?projects:k===30617?repos:del}};
const lm=await loadModel(session); eq(lm.capped,false,"capped"); eq(lm.unassigned.length,1,"load"); eq(calls.every(c=>c.limit>=1&&c.limit<=500),true,"limits valid"); eq(calls[2].kinds,[5],"delete read");
print("PASS",n,"checks");
