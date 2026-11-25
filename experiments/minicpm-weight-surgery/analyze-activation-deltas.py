from __future__ import annotations
from pathlib import Path
import os,json,math
import numpy as np
root=Path(os.environ["APPDATA"])/"Relay"/"workspace"/"minicpm-surgery-weights-1125"/"activation-traces"
prompts=["resume-summary","resume-analysis","resume-substantive","synthetic-evidence"]
traces={}
for name in prompts:
 traces[name]={}
 for model in ["base","heretic"]:
  file=root/f"{name}.{model}.json"
  j=json.loads(file.read_text(encoding="utf8"))
  assert len(j["captured"])==24 and not j["missing"] and not j["failures"],f"Invalid trace {name}/{model}"
  arr=np.asarray([j["vectors"][f"l_out-{i}"]["values"] for i in range(24)],dtype=np.float64)
  assert arr.shape==(24,1024)
  traces[name][model]={"vectors":arr,"tokens":j["tokens"],"sha256":j["source_sha256"]}
 def cosine(a,b):
  den=np.linalg.norm(a,axis=-1)*np.linalg.norm(b,axis=-1)
  return np.divide(np.sum(a*b,axis=-1),den,where=den>0)
def norms(a):return np.linalg.norm(a,axis=-1)
output={"version":1,"scope":"read-only hidden-state comparison, last prompt token","modelQuantization":"Q4_K_S","sourceTextIncluded":False,"perPrompt":{},"taskDirection":{}}
for name in prompts:
 a,b=traces[name]["base"],traces[name]["heretic"]
 assert a["tokens"]==b["tokens"] and a["sha256"]==b["sha256"],f"Input mismatch {name}"
 v,w=a["vectors"],b["vectors"]
 cos=cosine(v,w)
 diff=norms(v-w)
 relative=diff/np.maximum((norms(v)+norms(w))/2,1e-6)
 layer=[{"layer":i,"cosine":round(float(cos[i]),6),"relativeL2":round(float(relative[i]),6),"baseNorm":round(float(norms(v)[i]),3),"hereticNorm":round(float(norms(w)[i]),3)} for i in range(24)]
 output["perPrompt"][name]={"tokens":a["tokens"],"promptSha256":a["sha256"],"meanCosine":round(float(np.mean(cos)),6),"meanRelativeL2":round(float(np.mean(relative)),6),"lowestCosine":min(layer,key=lambda x:x["cosine"]),"layers":layer}
for name in ["resume-analysis","resume-substantive"]:
 directions={}
 for model in ["base","heretic"]:
  cur=traces[name][model]["vectors"];ref=traces["resume-summary"][model]["vectors"]
  directions[model]=cur-ref
 cos=cosine(directions["base"],directions["heretic"])
 output["taskDirection"][name+"-vs-summary"]={"meanDeltaCosine":round(float(np.mean(cos)),6),"perLayer":[{"layer":i,"deltaCosine":round(float(cos[i]),6),"baseDeltaNorm":round(float(norms(directions["base"])[i]),3),"hereticDeltaNorm":round(float(norms(directions["heretic"])[i]),3)} for i in range(24)]}
result=root/"activation-model-comparison.json"
result.write_text(json.dumps(output,indent=2),encoding="utf8")
print(json.dumps({"saved":str(result),"models":["official base thinking Q4_K_S","Heretic Q4_K_S"],"summary":{k:{"tokens":v["tokens"],"meanCosine":v["meanCosine"],"minLayer":v["lowestCosine"]} for k,v in output["perPrompt"].items()},"taskDirection":{k:v["meanDeltaCosine"] for k,v in output["taskDirection"].items()}},indent=2))
