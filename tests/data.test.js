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
// render with a tiny React stand-in
const hooks=[]; let hi=0;
const React={Fragment:"frag",createElement:(type,props,...kids)=>({type,props:props||{},kids:kids.flat(Infinity)}),
 useSyncExternalStore:(s,g)=>g(), useEffect:()=>{}, useMemo:(f)=>f(), useRef:(v)=>({current:v}), useState:(i)=>{const k=hi++; if(!(k in hooks))hooks[k]=typeof i==="function"?i():i; return [hooks[k],v=>{hooks[k]=typeof v==="function"?v(hooks[k]):v}]}};
const reg=[],opened=[];
const conn={status:"ready",origin:"https://relay.example.com",viewer:O,scope:"s",generation:1,session:{read:session.read,channels:{ensureList(){},subscribeList(){return()=>{}},list:()=>({channels:[{id:"c1",name:"demo-channel"}]})}}};
apply({react:React,relay:{subscribe(){return()=>{}},snapshot:()=>conn},pages:{register:p=>reg.push(p)},navigation:{open:t=>opened.push(t)}});
eq(reg[0].primary,true,"primary"); eq(reg[0].icon.startsWith("data:image/svg+xml;base64,"),true,"icon"); eq(inject,["react","pages","relay","navigation"],"inject");
const render=(n)=>{ if(n==null||typeof n!=="object")return n==null||n===false?"":String(n); if(typeof n.type==="function"){return render(n.type(n.props))} return (n.kids||[]).map(render).join(" ")};
const clicks=[]; const walk=(n)=>{ if(!n||typeof n!=="object")return; if(typeof n.type==="function")return walk(n.type(n.props)); if(n.type==="button")clicks.push(n); (n.kids||[]).forEach(walk)};
const root=reg[0].component({}); const feature=root; 
hi=0; hooks[0]={status:"ready",model:lm};
const tree=feature.type(feature.props); const text=render(tree);
for(const s of ["Projects","Core","Alpha new","beta","demo-channel","Linked channel","Other repositories","2 repository links unavailable"]) { hi=0; eq(text.includes(s),true,"renders "+s); }
hi=0; walk(feature.type(feature.props));
clicks.find(b=>(b.kids||[]).includes("demo-channel")).props.onClick();
eq(opened[0].kind,"conversation","channel target"); eq(opened[0].channelId,"c1","channel id");
print("PASS",n,"checks");
