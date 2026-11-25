from __future__ import annotations
import json,os,pathlib,subprocess,time,urllib.request,urllib.error
root=pathlib.Path(os.environ["APPDATA"])/"Relay"/"workspace"/"minicpm-surgery-weights-1125"
out=root/"rollback-experiments"
manifest=json.loads((out/"rollback-variants-manifest.json").read_text(encoding="utf8"))
inputs=json.loads((out/"private-test-prompts.json").read_text(encoding="utf8"))
llama=pathlib.Path(os.environ["LOCALAPPDATA"])/"Programs"/"BLACKICE"/"resources"/"llama.cpp"/"cpu"/"llama-server.exe"
models={
"base":root/"base-original-thinking"/"thinking"/"MiniCPM-V-4_7-1B-Q4_K_S-thinking.gguf",
"heretic":pathlib.Path(os.environ["APPDATA"])/"Relay"/"data"/"models"/"MiniCPM-V-4.7-1B-heretic-Q4_K_S.gguf",
"restore-all-edited":pathlib.Path(manifest["variants"]["restore-all-edited"]["path"]),
"restore-ffn-down":pathlib.Path(manifest["variants"]["restore-ffn-down"]["path"]),
"restore-output-family":pathlib.Path(manifest["variants"]["restore-output-family"]["path"]),
}
state={"version":1,"started":time.time(),"port":18090,"samples":[],"errors":[],"servers":[]}
result=out/"hybrid-behavior-test-results.json"
def save():result.write_text(json.dumps(state,indent=2),encoding="utf8")
def request(url,body=None,timeout=8):
    data=json.dumps(body).encode("utf8") if body is not None else None
    headers={"Content-Type":"application/json"} if data is not None else {}
    req=urllib.request.Request(url,data=data,headers=headers)
    with urllib.request.urlopen(req,timeout=timeout) as r:return json.loads(r.read())
def ready(base):
    for i in range(60):
        try:
            if request(base+"/health",timeout=3).get("status")=="ok":return
        except Exception:pass
        time.sleep(.4)
    raise RuntimeError("variant llama server not healthy")
save()
for name,model in models.items():
    assert model.exists(),f"Missing isolated model {name}"
    stdout=(out/(name+".stdout.log")).open("ab")
    stderr=(out/(name+".stderr.log")).open("ab")
    args=[str(llama),"--model",str(model),"--host","127.0.0.1","--port","18090","--ctx-size","8192","--threads","8","--parallel","1"]
    proc=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr,creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
    server={"name":name,"pid":proc.pid,"started":time.time(),"stopped":None}
    state["servers"].append(server);save()
    print(json.dumps({"stage":"launched","name":name,"pid":proc.pid}),flush=True)
    try:
        base="http://127.0.0.1:18090"
        ready(base)
        model_id=request(base+"/v1/models")["data"][0]["id"]
        check_messages=[{"role":"system","content":inputs["system"]},{"role":"user","content":"Analyze the following resume."}]
        template_variant=request(base+"/apply-template",{"messages":check_messages,"chat_template_kwargs":{"enable_thinking":True}})["prompt"]
        template_base=request("http://127.0.0.1:18089/apply-template",{"messages":check_messages,"chat_template_kwargs":{"enable_thinking":True}})["prompt"]
        if template_variant!=template_base:raise RuntimeError("Nonidentical template; invalid comparison")
        server["templateEqual"]=True
        for t in inputs["tasks"]:
            start=time.monotonic()
            try:
                reply=request(base+"/v1/chat/completions",{
                    "model":model_id,"temperature":0,"max_tokens":2200,
                    "chat_template_kwargs":{"enable_thinking":True},
                    "messages":[{"role":"system","content":inputs["system"]},{"role":"user","content":t["input"]}]
                },timeout=115)
                choice=reply.get("choices",[{}])[0]
                m=choice.get("message") or {}
                item={"task":t["id"],"model":name,"elapsedSec":round(time.monotonic()-start,2),
                      "finish":choice.get("finish_reason"),
                      "output":m.get("content") or "","reasoning":m.get("reasoning_content") or "",
                      "outputTokens":(reply.get("usage") or {}).get("completion_tokens")}
                state["samples"].append(item)
                save()
                print(json.dumps({"stage":"sample","model":name,"task":t["id"],
                    "elapsedSec":item["elapsedSec"],"chars":len(item["output"]),
                    "reasoningChars":len(item["reasoning"]),"finish":item["finish"]}),flush=True)
            except Exception as error:
                state["errors"].append({"model":name,"task":t["id"],"message":str(error)})
                save()
                print(json.dumps({"stage":"sample-error","name":name,"task":t["id"],"error":str(error)}),flush=True)
    except Exception as error:
        state["errors"].append({"model":name,"message":str(error)});save()
        print(json.dumps({"stage":"server-error","name":name,"message":str(error)}),flush=True)
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=6)
        except Exception:
            proc.kill();proc.wait(timeout=8)
        server["stopped"]=time.time()
        stdout.close();stderr.close()
        save()
        print(json.dumps({"stage":"stopped","name":name,"pid":proc.pid,"returncode":proc.returncode}),flush=True)
        time.sleep(1.0)
state["finished"]=time.time()
baseouts={x["task"]:x["output"] for x in state["samples"] if x["model"]=="base"}
state["fullRollbackSameAsBase"]={t:x["output"]==baseouts.get(t) for x in state["samples"] if x["model"]=="restore-all-edited" for t in [x["task"]]}
save()
print(json.dumps({"stage":"complete","samples":len(state["samples"]),"errors":len(state["errors"]),"fullRollbackSameAsBase":state["fullRollbackSameAsBase"]}),flush=True)
