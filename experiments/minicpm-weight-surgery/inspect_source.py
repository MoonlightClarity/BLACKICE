from huggingface_hub import HfApi, snapshot_download
import os,json,pathlib
repo="saidutta69/MiniCPM-V-4.7-1B-heretic"
info=HfApi().model_info(repo,files_metadata=True)
files=[{"name":s.rfilename,"size":s.size} for s in info.siblings if s.rfilename in ["model.safetensors","config.json","tokenizer.json","tokenizer_config.json","generation_config.json","preprocessor_config.json","processor_config.json"]]
root=pathlib.Path(os.environ["LOCAL_WEIGHT_LAB"])/"source"
root.mkdir(parents=True,exist_ok=True)
path=snapshot_download(repo,revision=info.sha,local_dir=root,allow_patterns=["*.json","*.jinja","*.txt"],ignore_patterns=["**/reproduce/**"],max_workers=4)
config=json.loads((root/"config.json").read_text(encoding="utf-8"))
result={"repo":repo,"revision":info.sha,"files":files,"localMetadata":str(path),"architecture":config.get("architectures"),"modelType":config.get("model_type"),"textConfigKeys":list(config.get("text_config",{}).keys()),"textModelType":config.get("text_config",{}).get("model_type"),"hiddenSize":config.get("text_config",{}).get("hidden_size"),"numLayers":config.get("text_config",{}).get("num_hidden_layers")}
print(json.dumps(result,indent=2))
(pathlib.Path(os.environ["LOCAL_WEIGHT_LAB"])/"source-manifest.json").write_text(json.dumps(result,indent=2),encoding="utf-8")
