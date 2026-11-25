import pathlib,os,json,time,re,hashlib
import numpy as np
from gguf import GGUFReader
root=pathlib.Path(os.environ["APPDATA"])/"Relay"/"workspace"/"minicpm-surgery-weights-1125"
models={
 "base":root/"base-original"/"MiniCPM-V-4_7-1B-Q4_K_S.gguf",
 "base_thinking":root/"base-original-thinking"/"thinking"/"MiniCPM-V-4_7-1B-Q4_K_S-thinking.gguf",
 "heretic":pathlib.Path(os.environ["APPDATA"])/"Relay"/"data"/"models"/"MiniCPM-V-4.7-1B-heretic-Q4_K_S.gguf"
}
t=time.monotonic()
readers={}
for name,p in models.items():
 print(json.dumps({"stage":"opening","name":name,"bytes":p.stat().st_size}),flush=True)
 r=GGUFReader(str(p))
 readers[name]={x.name:x for x in r.tensors}
 print(json.dumps({"stage":"reader","name":name,"tensors":len(r.tensors),"metadataFields":len(r.fields),"elapsedSec":round(time.monotonic()-t,1)}),flush=True)
results={}
for a,b in [("base","base_thinking"),("base_thinking","heretic"),("base","heretic")]:
 sa,sb=readers[a],readers[b]
 union=sorted(set(sa)|set(sb))
 diff=[];same=[]
 total=0;changed=0;groups={}
 for key in union:
  x,y=sa.get(key),sb.get(key)
  if x is None or y is None:
   diff.append({"name":key,"reason":"missing","side":"a" if y is None else "b"});continue
  if x.tensor_type!=y.tensor_type or x.data.shape!=y.data.shape:
   diff.append({"name":key,"reason":"type-or-shape"});continue
  n=x.data.nbytes;total+=n
  mismatched=int(np.count_nonzero(x.data!=y.data))
  changed+=mismatched
  group=re.search(r"blk\.(\d+)\.",key)
  group=group.group(1) if group else "non-block"
  acc=groups.setdefault(group,{"bytes":0,"bytesChanged":0,"tensors":0,"tensorsChanged":0,"top":[]})
  acc["bytes"]+=n;acc["bytesChanged"]+=mismatched;acc["tensors"]+=1
  if mismatched:
   acc["tensorsChanged"]+=1
   acc["top"].append({"name":key,"changedFraction":round(mismatched/n,5),"bytes":n})
   diff.append({"name":key,"changedFraction":round(mismatched/n,5),"bytes":n})
  else:same.append(key)
 for g in groups.values():
  g["bytesChangedFraction"]=round(g["bytesChanged"]/max(g["bytes"],1),6)
  g["top"]=sorted(g["top"],key=lambda x:-x["bytes"]*x["changedFraction"])[:7]
 result={"files":[a,b],"tensorsTotal":len(union),"tensorsIdentical":len(same),"tensorsDifferent":len(diff),"totalTensorBytes":total,"differentBytes":changed,"differentFraction":round(changed/max(total,1),6),"perLayer":groups,"topDifferent":sorted(diff,key=lambda x:-(x.get("bytes",0)*x.get("changedFraction",0)))[:15]}
 results[a+"__vs__"+b]=result
 print(json.dumps({"stage":"compared","pair":a+" / "+b,"tensorsIdentical":len(same),"tensorsDifferent":len(diff),"differentFraction":result["differentFraction"],"elapsed":round(time.monotonic()-t,1)}),flush=True)
out=root/"base-comparison"/"gguf-tensor-byte-differences.json"
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps({"comparisons":results,"method":"raw quantized tensor byte equality, not a causal effect estimate","elapsed":round(time.monotonic()-t,1)},indent=2),encoding="utf8")
print(json.dumps({"stage":"saved","path":str(out)}),flush=True)
