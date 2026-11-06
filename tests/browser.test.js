import { buildModel, filterModel, listFolder, crumbs, parentOf, searchFiles, formatSize, diffKind, friendlyError, ancestors, treeRows, isMarkdown, relativeTime, dayLabel, groupCommits, parseDiff, inlineTokens, parseMarkdown, cloneUrl, nextRecent, apply } from "../plugin.js";
globalThis.clearTimeout ??= () => {}; globalThis.setTimeout ??= () => 0;
const O="a".repeat(64); let n=0;
const eq=(a,b,m)=>{n++;const x=JSON.stringify(a),y=JSON.stringify(b);if(x!==y)throw new Error(m+": "+x+" != "+y)};
const ok=(c,m)=>{n++;if(!c)throw new Error(m)};
const F=[{path:"README.md",hash:"1",size:10},{path:"src/app/main.rs",hash:"2",size:2048},{path:"src/lib.rs",hash:"3",size:5},{path:"Cargo.toml",hash:"4",size:20},{path:"docs/a b.md",hash:"5",size:1},{path:"src/app/ui/view.rs",hash:"6",size:7}];
const root=listFolder(F,"");
eq(root.folders.map(f=>f.name),["docs","src"],"folders"); eq(root.files.map(f=>f.name),["Cargo.toml","README.md"],"files");
eq(root.folders[1].count,3,"count nested");
const src=listFolder(F,"src"); eq(src.folders.map(f=>f.path),["src/app"],"sub"); eq(src.files.map(f=>f.path),["src/lib.rs"],"subfile");
eq(listFolder(F,"sr").files.length+listFolder(F,"sr").folders.length,0,"no prefix bleed");
eq(crumbs("a/b/c").map(c=>c.path),["a","a/b","a/b/c"],"crumbs"); eq(crumbs(""),[],"root crumbs");
eq(parentOf("a/b/c"),"a/b","parent"); eq(parentOf("a"),"","parent root");
eq(searchFiles(F,"app main").map(f=>f.path),["src/app/main.rs"],"search words"); eq(searchFiles(F,"  "),[],"blank"); 
eq(formatSize(10),"10 B","b"); eq(formatSize(2048),"2.0 KB","kb"); eq(formatSize(3*1048576),"3.0 MB","mb");
eq(["+x","-x","+++ b/x","--- a/x","@@ -1","diff --git a b"," x"].map(diffKind),["add","remove","meta","meta","meta","meta","plain"],"diff");
ok(friendlyError({status:503}).detail.includes("second try"),"503"); ok(friendlyError({kind:"denied"}).title.includes("access"),"denied"); ok(friendlyError({status:404}).title.includes("isn't"),"404"); ok(friendlyError(new Error("x")).title.length>0,"generic");
eq(ancestors("a/b/c.txt"),["a","a/b"],"ancestors"); eq(ancestors("c.txt"),[],"no ancestors");
eq(treeRows(F,new Set()).map(r=>r.name),["docs","src","Cargo.toml","README.md"],"collapsed tree");
eq(treeRows(F,new Set(["src","src/app"])).map(r=>[r.name,r.depth]),[["docs",0],["src",0],["app",1],["ui",2],["main.rs",2],["lib.rs",1],["Cargo.toml",0],["README.md",0]],"expanded tree");
ok(isMarkdown("a/B.MD")&&!isMarkdown("a.rs"),"markdown names");
const NOW=1800000000; eq(relativeTime(NOW-30,NOW),"just now","now"); eq(relativeTime(NOW-3700,NOW),"1 hour ago","hour"); eq(relativeTime(NOW-172800,NOW),"2 days ago","days");
eq(dayLabel(NOW-60,NOW),dayLabel(NOW-61,NOW),"same day"); eq(groupCommits([{date:NOW},{date:NOW-1},{date:NOW-3*86400}],NOW).map(g=>g.commits.length),[2,1],"group");
const D=parseDiff("commit abc\nAuthor: A\n\n    Subject\n\n    Body text\n\ndiff --git a/x.ts b/x.ts\nindex 1..2 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\ndiff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n");
eq(D.message,"Subject\n\nBody text","diff message"); eq(D.files.map(f=>[f.path,f.additions,f.deletions,f.binary]),[["x.ts",2,1,false],["i.png",0,0,true]],"diff files"); eq(D.files[0].lines.length,4,"header lines hidden");
eq(parseDiff("").files,[],"empty diff");
eq(inlineTokens("a `c` **b** *i* [t](https://e.com) [x](javascript:alert(1))").map(t=>t.type+":"+t.text),["text:a ","code:c","text: ","bold:b","text: ","italic:i","text: ","link:t","text: ","text:x","text:)"].filter(Boolean),"inline");
ok(!inlineTokens("[x](javascript:alert(1))").some(t=>t.type==="link"),"unsafe link dropped"); ok(!inlineTokens("![a](https://e.com/p.png)").some(t=>t.type==="link"),"image not loaded");
eq(inlineTokens("snake_case_name").length,1,"snake case untouched");
const M=parseMarkdown("# T\n\nHello <b>you</b>\nthere\n\n- a\n- b\n\n1. c\n\n```sh\nx\n```\n\n> q\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n---\n\n<!-- gone -->\n<script>bad()</script>\n");
eq(M.map(b=>b.type),["heading","paragraph","list","list","code","quote","table","rule","paragraph"],"markdown blocks");
eq(M[1].text,"Hello you there","html stripped"); eq(M[6].rows,[["1","2"]],"table rows"); ok(!JSON.stringify(M).includes("<script"),"script tag dropped");
eq(parseMarkdown("").length,0,"empty markdown");
eq(cloneUrl({owner:"o",dtag:"d",clone:[]},"https://r.example/"),"https://r.example/git/o/d.git","default clone"); eq(cloneUrl({owner:"o",dtag:"d",clone:["https://g.example/x.git"]},"https://r.example"),"https://g.example/x.git","announced clone");
eq(nextRecent(["a","b","c","d"],"c"),["c","a","b","d"],"recent move"); eq(nextRecent(["a","b","c","d"],"e").length,4,"recent cap");
// mini React: hooks by tree path, effects after render
const store=new Map(); let path="",slot=0,pending=[];
const hk=()=>{const k=path+"#"+(slot++);return k};
const React={Fragment:"frag",createElement:(type,props,...kids)=>({type,props:props||{},kids}),
 useSyncExternalStore:(s,g)=>g(),
 useMemo(f,d){const k=hk(),c=store.get(k);if(c&&JSON.stringify(c.d)===JSON.stringify(d.map(x=>typeof x==="object"?(x&&x.__id)||String(Object.keys(x||{}).length)+(x&&x.status||""):x)))return c.v;const v=f();store.set(k,{v,d:d.map(x=>typeof x==="object"?(x&&x.__id)||String(Object.keys(x||{}).length)+(x&&x.status||""):x)});return v},
 useRef(v){const k=hk();if(!store.has(k))store.set(k,{current:v});return store.get(k)},
 useState(i){const k=hk();if(!store.has(k))store.set(k,{v:typeof i==="function"?i():i});const c=store.get(k);return[c.v,x=>{c.v=typeof x==="function"?x(c.v):x}]},
 useEffect(f,d){const k=hk(),c=store.get(k),s=JSON.stringify(d.map(x=>typeof x==="object"?"o":x));if(!c||c.s!==s){pending.push(()=>{if(c&&c.clean)c.clean();const clean=f();store.set(k,{s,clean})});store.set(k,{...(c||{}),s})}}};
function walk(node,p,out){ if(node==null||node===false||node===true)return; if(Array.isArray(node)){node.forEach((c,i)=>walk(c,p+"."+(c&&c.props&&c.props.key||i),out));return}
 if(typeof node!=="object"){out.text.push(String(node));return}
 if(typeof node.type==="function"){const q=p+"/"+(node.type.name||"c")+(node.props.key||"");const sp=path,ss=slot;path=q;slot=0;const r=node.type(node.props);path=sp;slot=ss;walk(r,q,out);return}
 if(node.type==="button")out.buttons.push(node); if(node.type==="input")out.inputs.push(node); walk(node.kids,p+"/"+node.type,out)}
const label=(b)=>{const o={text:[],buttons:[],inputs:[]};walk(b.kids,"x",o);return o.text.join("")};
const reads=[]; let failNext=0;
const repoEvents=[{kind:30617,id:"r",pubkey:O,created_at:1,content:"",tags:[["d","demo"],["name","Demo"],["description","d"]]}];
const projEvents=[{kind:30621,id:"p",pubkey:O,created_at:1,content:"",tags:[["d","core"],["name","Core"],["a",`30617:${O}:demo`]]}];
const snap=(i)=>({head:"h",commits:[{hash:"c".repeat(40),author:"author",date:1790000000,subject:"fix thing"}],files:F,readme:"Hello readme",file:i.path?{path:i.path,content:i.path.endsWith(".png")?null:"line1\nline2\n",size:12}:null,diff:i.commit?"diff --git a b\n+added\n-removed":null});
const conn={status:"ready",origin:"https://relay.example.com",viewer:O,scope:"s",generation:1,session:{
 read:async f=>{const k=f[0].kinds[0];return k===30621?projEvents:k===30617?repoEvents:[]},
 channels:{ensureList(){},subscribeList(){return()=>{}},list:()=>({channels:[]})},
 projectGit:{read:async(i,sig)=>{reads.push(i);ok(sig&&"aborted"in sig,"signal");if(failNext-->0)throw Object.assign(new Error("x"),{status:503});return snap(i)}}}};
if(typeof AbortController==="undefined")globalThis.AbortController=class{constructor(){this.signal={aborted:false}}abort(){this.signal.aborted=true}};
const reg=[],opened=[];
apply({react:React,relay:{subscribe(){return()=>{}},snapshot:()=>conn},pages:{register:p=>reg.push(p)},navigation:{open:t=>opened.push(t)}});
async function frame(){let o;for(let i=0;i<8;i++){pending=[];o={text:[],buttons:[],inputs:[]};walk({type:reg[0].component,props:{},kids:[]},"root",o);const p=pending;p.forEach(f=>f());await new Promise(r=>r());await new Promise(r=>r());await new Promise(r=>r());}return o}
const click=async(o,t)=>{const b=o.buttons.find(b=>label(b).includes(t));if(!b)throw new Error("no button "+t+" in "+o.buttons.map(label));b.props.onClick();return frame()};
const has=(o,t)=>o.text.join(" ").includes(t);
let o=await frame(); ok(has(o,"Core"),"project shown");
failNext=4; o=await click(o,"Demo"); ok(has(o,"second try"),"error shown after failed read");
failNext=0; o=await click(o,"Try again"); ok(has(o,"src")&&has(o,"Hello readme"),"retry loads root + readme");
ok(!has(o,"src/app/main.rs"),"root is not flat"); const r1=reads.length;
o=await click(o,"src"); ok(has(o,"app")&&has(o,"lib.rs")&&!has(o,"Cargo.toml"),"inside src"); eq(reads.length,r1,"folders need no read");
o=await click(o,"app"); ok(has(o,"main.rs")&&has(o,"ui"),"nested"); eq(reads.length,r1,"still no read");
o=await click(o,"main.rs"); ok(has(o,"line1")&&has(o,"1\n2")&&has(o,"2 lines"),"file + line numbers"); eq(reads[reads.length-1].path,"src/app/main.rs","file read");
const r2=reads.length; o=await click(o,"src"); ok(has(o,"lib.rs"),"breadcrumb back");
o=await click(o,"app"); o=await click(o,"main.rs"); eq(reads.length,r2,"file cached");
o=await click(o,"Commits"); o=await click(o,"Files"); ok(has(o,"line1"),"tab switch keeps your file");
o=await click(o,"Demo"); ok(has(o,"Cargo.toml"),"crumb to root");
o.inputs[0].props.onChange({target:{value:"view"}}); o=await frame(); ok(has(o,"view.rs")&&has(o,"src/app/ui"),"search shows name and folder");
o.inputs[0].props.onChange({target:{value:""}}); o=await frame();
o=await click(o,"Commits"); ok(has(o,"fix thing"),"commits"); o=await click(o,"fix thing"); ok(has(o,"+added")&&has(o,"-removed")&&has(o,"file changed"),"diff");
o=await click(o,"← Commits"); o=await click(o,"Issues"); eq(opened[0].route.params,{type:"repo",owner:O,dtag:"demo",tab:"issues"},"issues link");
const r3=reads.length; o=await click(o,"Refresh"); ok(reads.length>r3,"refresh re-reads");
o=await click(o,"← Projects"); ok(has(o,"Core")&&has(o,"Recently opened"),"back with recents");
print("PASS",n,"checks");
