"""Read-only llama.cpp graph callback ABI probe for installed b1b770d90 DLLs.

Runs in a separate Python process. Never opens models for writing or touches BLACKICE
processes. API structure layouts are pinned to llama.cpp b1b770d90d94cad9...
"""
from __future__ import annotations
import ctypes as C
import json, os, pathlib, sys, time, re, math
from collections import Counter

class ModelParams(C.Structure):
    _fields_=[
        ("devices",C.c_void_p),("tensor_buft_overrides",C.c_void_p),
        ("n_gpu_layers",C.c_int32),("split_mode",C.c_int32),
        ("load_mode",C.c_int32),("lazy_mode",C.c_int32),("main_gpu",C.c_int32),
        ("tensor_split",C.c_void_p),("progress_callback",C.c_void_p),
        ("progress_callback_user_data",C.c_void_p),("kv_overrides",C.c_void_p),
        ("vocab_only",C.c_bool),("check_tensors",C.c_bool),
        ("use_extra_bufts",C.c_bool),("no_host",C.c_bool),
        ("no_alloc",C.c_bool),("load_mtp",C.c_bool),
    ]
class ContextParams(C.Structure):
    _fields_=[
        ("n_ctx",C.c_uint32),("n_batch",C.c_uint32),("n_ubatch",C.c_uint32),
        ("n_seq_max",C.c_uint32),("n_rs_seq",C.c_uint32),
        ("n_outputs_max",C.c_uint32),("n_outputs_max_per_seq",C.c_uint32),
        ("n_threads",C.c_int32),("n_threads_batch",C.c_int32),
        ("ctx_type",C.c_int32),("rope_scaling_type",C.c_int32),
        ("pooling_type",C.c_int32),("attention_type",C.c_int32),
        ("flash_attn_type",C.c_int32),
        ("rope_freq_base",C.c_float),("rope_freq_scale",C.c_float),
        ("yarn_ext_factor",C.c_float),("yarn_attn_factor",C.c_float),
        ("yarn_beta_fast",C.c_float),("yarn_beta_slow",C.c_float),
        ("yarn_orig_ctx",C.c_uint32),
        ("cb_eval",C.c_void_p),("cb_eval_user_data",C.c_void_p),
        ("type_k",C.c_int32),("type_v",C.c_int32),
        ("moe_cache_size",C.c_size_t),("moe_cache_cpu_share",C.c_float),
        ("abort_callback",C.c_void_p),("abort_callback_data",C.c_void_p),
        ("embeddings",C.c_bool),("offload_kqv",C.c_bool),
        ("no_perf",C.c_bool),("op_offload",C.c_bool),
        ("swa_full",C.c_bool),("kv_unified",C.c_bool),
        ("samplers",C.c_void_p),("n_samplers",C.c_size_t),
        ("ctx_other",C.c_void_p),
    ]
class Batch(C.Structure):
    _fields_=[
        ("n_tokens",C.c_int32),("token",C.POINTER(C.c_int32)),("embd",C.POINTER(C.c_float)),
        ("pos",C.POINTER(C.c_int32)),("n_seq_id",C.POINTER(C.c_int32)),
        ("seq_id",C.POINTER(C.POINTER(C.c_int32))),("logits",C.POINTER(C.c_int8)),
    ]
base=pathlib.Path(os.environ["LOCALAPPDATA"])/"Programs"/"BLACKICE"/"resources"/"llama.cpp"/"cpu"
gguf=pathlib.Path(os.environ.get("TRACE_MODEL_FILE") or (pathlib.Path(os.environ["APPDATA"])/"Relay"/"data"/"models"/"MiniCPM-V-4.7-1B-heretic-Q4_K_S.gguf"))
if not gguf.exists(): raise RuntimeError("Local original GGUF unavailable")
dll_dir=os.add_dll_directory(str(base))
lib=C.CDLL(str(base/"llama.dll"))
ggml=C.CDLL(str(base/"ggml-base.dll"))
ggml_loader=C.CDLL(str(base/"ggml.dll"))
def setup(lib,name,return_type,arguments):
    fn=getattr(lib,name);fn.restype=return_type;fn.argtypes=arguments;return fn
backend_init=setup(lib,"llama_backend_init",None,[])
load_backends=setup(ggml_loader,"ggml_backend_load_all_from_path",None,[C.c_char_p])
backend_dev_count=setup(ggml_loader,"ggml_backend_dev_count",C.c_size_t,[])
backend_free=setup(lib,"llama_backend_free",None,[])
model_defaults=setup(lib,"llama_model_default_params",ModelParams,[])
context_defaults=setup(lib,"llama_context_default_params",ContextParams,[])
load_model=setup(lib,"llama_model_load_from_file",C.c_void_p,[C.c_char_p,ModelParams])
free_model=setup(lib,"llama_model_free",None,[C.c_void_p])
init_context=setup(lib,"llama_init_from_model",C.c_void_p,[C.c_void_p,ContextParams])
free_context=setup(lib,"llama_free",None,[C.c_void_p])
model_get_vocab=setup(lib,"llama_model_get_vocab",C.c_void_p,[C.c_void_p])
tokenize=setup(lib,"llama_tokenize",C.c_int32,[C.c_void_p,C.c_char_p,C.c_int32,C.POINTER(C.c_int32),C.c_int32,C.c_bool,C.c_bool])
batch_one=setup(lib,"llama_batch_get_one",Batch,[C.POINTER(C.c_int32),C.c_int32])
decode=setup(lib,"llama_decode",C.c_int32,[C.c_void_p,Batch])
model_layers=setup(lib,"llama_model_n_layer",C.c_int32,[C.c_void_p])
model_embd=setup(lib,"llama_model_n_embd",C.c_int32,[C.c_void_p])
tensor_name=setup(ggml,"ggml_get_name",C.c_char_p,[C.c_void_p])
tensor_bytes=setup(ggml,"ggml_nbytes",C.c_size_t,[C.c_void_p])
tensor_rows=setup(ggml,"ggml_nrows",C.c_int64,[C.c_void_p])
tensor_dims=setup(ggml,"ggml_n_dims",C.c_int,[C.c_void_p])
tensor_get=setup(ggml,"ggml_backend_tensor_get",None,[C.c_void_p,C.c_void_p,C.c_size_t,C.c_size_t])

EVAL_CALLBACK=C.CFUNCTYPE(C.c_bool,C.c_void_p,C.c_bool,C.c_void_p)
seen=Counter()
observed={}
layer_vectors={}
failures=[]
current_offset=[0]
def callback(pointer,ask,user_data):
    try:
        raw=tensor_name(pointer)
        name=raw.decode("utf-8","replace") if raw else ""
        if not name:name="<unnamed>"
        if ask:
            return re.fullmatch(r"l_out-\d+",name) is not None
        if re.fullmatch(r"l_out-\d+",name):
            size=int(tensor_bytes(pointer))
            rows=int(tensor_rows(pointer))
            dims=int(tensor_dims(pointer))
            if size != rows * 1024 * 4 or rows<1:
                failures.append(f"{name}:unexpected-layout:{size}/{rows}/{dims}")
            else:
                vec=(C.c_float*1024)()
                tensor_get(pointer,vec,(rows-1)*1024*4,1024*4)
                values=list(vec)
                if not all(math.isfinite(x) for x in values): failures.append(name+":nonfinite")
                layer_vectors[name]={"last_token_index":current_offset[0]+rows-1,"values":values}
                observed[name]={"nbytes":size,"nrows":rows,"dims":dims}
        return True
    except BaseException as exc:
        if len(failures)<5:failures.append(str(exc))
        return True
cb=EVAL_CALLBACK(callback)
print(json.dumps({"phase":"layout","model_params_size":C.sizeof(ModelParams),"context_params_size":C.sizeof(ContextParams),"batch_size":C.sizeof(Batch),"context_cb_eval_offset":ContextParams.cb_eval.offset}),flush=True)
m=None;ctx=None
try:
    backend_init()
    load_backends(os.fsencode(str(base)))
    print(json.dumps({"phase":"cpu_backend_loaded","devices":backend_dev_count()}),flush=True)
    mp=model_defaults()
    print(json.dumps({"phase":"model_defaults","n_gpu_layers":mp.n_gpu_layers,"split_mode":mp.split_mode,"load_mode":mp.load_mode,"lazy_mode":mp.lazy_mode}),flush=True)
    mp.n_gpu_layers=0
    m=load_model(os.fsencode(str(gguf)),mp)
    if not m: raise RuntimeError("Could not open original model via installed llama.dll")
    print(json.dumps({"phase":"model_loaded","layers":model_layers(m),"embd":model_embd(m)}),flush=True)
    cp=context_defaults()
    print(json.dumps({"phase":"context_defaults","n_ctx":cp.n_ctx,"n_batch":cp.n_batch,"n_ubatch":cp.n_ubatch,"ctx_type":cp.ctx_type}),flush=True)
    cp.n_ctx=4096;cp.n_batch=128;cp.n_ubatch=128;cp.n_threads=6;cp.n_threads_batch=6
    cp.cb_eval=C.cast(cb,C.c_void_p).value
    ctx=init_context(m,cp)
    if not ctx: raise RuntimeError("Could not create callback-enabled context")
    vocab=model_get_vocab(m)
    prompt_path=os.environ.get("TRACE_INPUT_FILE")
    text=pathlib.Path(prompt_path).read_bytes() if prompt_path else b"<|im_start|>user\nAnalyze this observation and explain the evidence: 18 of 48 participants improved; the others did not improve.<|im_end|>\n<|im_start|>assistant\n"
    arr=(C.c_int32*4096)()
    count=tokenize(vocab,text,len(text),arr,4096,False,True)
    if count<=0:raise RuntimeError(f"Tokenization failed: {count}")
    start=time.monotonic()
    for offset in range(0,count,64):
        tokens=arr[offset:offset+64]
        buf=(C.c_int32*len(tokens))(*tokens)
        current_offset[0]=offset
        batch=batch_one(buf,len(tokens))
        status=decode(ctx,batch)
        if status!=0:raise RuntimeError(f"Decode failed: {status}, batch-start={offset}")
    expected_layers={f"l_out-{i}" for i in range(model_layers(m))}
    captured=set(layer_vectors)
    result={"version":1,"source_sha256":__import__("hashlib").sha256(text).hexdigest(),"tokens":count,"layers":model_layers(m),"hidden":model_embd(m),"elapsed_s":round(time.monotonic()-start,3),"captured":sorted(captured),"missing":sorted(expected_layers-captured),"failures":failures,"vectors":layer_vectors}
    output_path=os.environ.get("TRACE_OUTPUT_FILE")
    if output_path:pathlib.Path(output_path).write_text(json.dumps(result),encoding="utf-8")
    print(json.dumps({"phase":"decoded","tokens":count,"elapsed_s":result["elapsed_s"],"layers":model_layers(m),"captured_layers":len(captured),"missing":result["missing"],"failures":failures,"saved":output_path,"nonzero_layer_norms":{k:round(sum(x*x for x in v["values"])**.5,2) for k,v in layer_vectors.items()}}),flush=True)
finally:
    if ctx:free_context(ctx)
    if m:free_model(m)
    backend_free()
    dll_dir.close()
