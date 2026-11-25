from __future__ import annotations
from gguf import GGUFReader
from pathlib import Path
import json,os,re,shutil,hashlib,time
import numpy as np
root=Path(os.environ["APPDATA"])/"Relay"/"workspace"/"minicpm-surgery-weights-1125"
base=root/"base-original-thinking"/"thinking"/"MiniCPM-V-4_7-1B-Q4_K_S-thinking.gguf"
edited=Path(os.environ["APPDATA"])/"Relay"/"data"/"models"/"MiniCPM-V-4.7-1B-heretic-Q4_K_S.gguf"
outroot=root/"rollback-experiments"
outroot.mkdir(exist_ok=True,parents=True)
start=time.monotonic()
br=GGUFReader(str(base))
hr=GGUFReader(str(edited))
b={t.name:t for t in br.tensors}
h={t.name:t for t in hr.tensors}
if set(b)!=set(h) or len(b)!=321:raise RuntimeError("Base/edited GGUF do not share exactly 321 tensor names")
changed=[]
for name in sorted(b):
 x,y=b[name],h[name]
 if x.tensor_type!=y.tensor_type or x.n_bytes!=y.n_bytes or x.shape.tolist()!=y.shape.tolist():
  raise RuntimeError(f"Incompatible quantized tensor: {name}")
 if not np.array_equal(x.data,y.data):
  changed.append(name)
print(json.dumps({"stage":"diff","changed":len(changed),"unchanged":len(b)-len(changed),"elapsedSeconds":round(time.monotonic()-start,1)}),flush=True)
def is_ffn(name):return name.endswith("ffn_down.weight")
types={
 "restore-ffn-down":[name for name in changed if is_ffn(name)],
 "restore-output-family":[name for name in changed if not is_ffn(name)],
 "restore-all-edited":[name for name in changed]
}
summary={"source":"Q4_K_S base thinking vs Heretic identical text tower layout","originalSource":str(base),"editedSource":str(edited),"variants":{},"changedTensors":len(changed),"untouchedBaseTensors":len(b)-len(changed)}
for label,names in types.items():
 filename=outroot/f"MiniCPM-1B-heretic-{label}-Q4_K_S.gguf"
 if filename.exists():raise RuntimeError("Refusing to overwrite existing isolated variant: "+str(filename))
 shutil.copyfile(edited,filename)
 with base.open("rb") as src,filename.open("r+b") as dst:
  for name in names:
   x,y=b[name],h[name]
   src.seek(x.data_offset);data=src.read(x.n_bytes)
   if len(data)!=x.n_bytes:raise RuntimeError("Truncated original source tensor "+name)
   dst.seek(y.data_offset);dst.write(data)
 checks=[]
 with filename.open("rb") as f:
  for name in names:
   f.seek(h[name].data_offset);actual=f.read(h[name].n_bytes)
   checks.append(actual==bytes(b[name].data))
 if not all(checks):raise RuntimeError("Tensor verification failed: "+label)
 cats={"ffn":sum(is_ffn(n) for n in names),"attentionOrSsm":sum(not is_ffn(n) for n in names)}
 row={"path":str(filename),"bytes":filename.stat().st_size,"restoredTensors":len(names),"categories":cats,"verification":"all selected compressed tensor bytes match unmodified base","elapsedSeconds":round(time.monotonic()-start,2)}
 summary["variants"][label]=row
 print(json.dumps({"stage":"variant","name":label,"restored":len(names),"categories":cats,"elapsedSeconds":row["elapsedSeconds"]}),flush=True)
(outroot/"rollback-variants-manifest.json").write_text(json.dumps(summary,indent=2),encoding="utf8")
print(json.dumps({"stage":"complete","manifest":str(outroot/"rollback-variants-manifest.json"),"elapsedSeconds":round(time.monotonic()-start,2)}),flush=True)
