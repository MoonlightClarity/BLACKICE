import json,os,pathlib,subprocess,sys,time
root=pathlib.Path(os.environ["APPDATA"])/"Relay"/"workspace"/"minicpm-surgery-weights-1125"
trace=root/"activation-traces"
manifest=json.loads((trace/"private-prompt-manifest.json").read_text(encoding="utf-8"))
repo=pathlib.Path(os.environ["APPDATA"])/"Relay"/"workspace"/"analysis-intent-isolated-1124"
probe=repo/"experiments"/"minicpm-weight-surgery"/"gguf_callback_probe.py"
models={
 "base":root/"base-original-thinking"/"thinking"/"MiniCPM-V-4_7-1B-Q4_K_S-thinking.gguf",
 "heretic":pathlib.Path(os.environ["APPDATA"])/"Relay"/"data"/"models"/"MiniCPM-V-4.7-1B-heretic-Q4_K_S.gguf"
}
state={"version":1,"started":__import__("datetime").datetime.now().isoformat(),"runs":[]}
summary=trace/"activation-capture-status.json"
def save():summary.write_text(json.dumps(state,indent=2),encoding="utf-8")
save()
for prompt in manifest["prompts"]:
 for model in ("base","heretic"):
  inp=pathlib.Path(prompt["path"])
  out=trace/(prompt["id"]+"."+model+".json")
  if out.exists():
   j=json.loads(out.read_text(encoding="utf8"))
   if j.get("source_sha256")==prompt["sha256"] and not j.get("missing"):
    state["runs"].append({"prompt":prompt["id"],"model":model,"status":"existing-verified","tokens":j["tokens"],"layers":len(j["captured"])})
    save();continue
  stdout=trace/(prompt["id"]+"."+model+".stdout.log")
  stderr=trace/(prompt["id"]+"."+model+".stderr.log")
  env={**os.environ,"TRACE_MODEL_FILE":str(models[model]),"TRACE_INPUT_FILE":str(inp),"TRACE_OUTPUT_FILE":str(out)}
  t=time.monotonic()
  print(json.dumps({"phase":"start","prompt":prompt["id"],"model":model}),flush=True)
  try:
   with stdout.open("wb") as fo, stderr.open("wb") as fe:
    child=subprocess.run([sys.executable,"-X","faulthandler",str(probe)],cwd=str(repo),env=env,stdout=fo,stderr=fe,timeout=100)
   if child.returncode!=0:
    raise RuntimeError("probe exited "+str(child.returncode)+" (stderr in private lab)")
   j=json.loads(out.read_text(encoding="utf8"))
   if j.get("source_sha256")!=prompt["sha256"] or len(j.get("captured",[]))!=24 or j.get("failures"):
    raise RuntimeError("activation vector receipt did not pass integrity checks")
   receipt={"prompt":prompt["id"],"model":model,"status":"ok","elapsedSec":round(time.monotonic()-t,2),"tokens":j["tokens"],"layers":len(j["captured"]),"sourceSha256":j["source_sha256"]}
  except Exception as e:
   receipt={"prompt":prompt["id"],"model":model,"status":"failed","elapsedSec":round(time.monotonic()-t,2),"error":str(e)}
  state["runs"].append(receipt);save()
  print(json.dumps({"phase":"done",**receipt}),flush=True)
state["finished"]=__import__("datetime").datetime.now().isoformat()
save()
