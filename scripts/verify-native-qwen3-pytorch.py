#!/usr/bin/env python3
"""Independent CPU reference using Hugging Face Transformers/PyTorch.

Reads exactly the same local FP16 checkpoint BLACKICE reads. Does not download
weights or change their precision on disk; PyTorch computes float32 CPU logits
to avoid mixed-precision error conflating architectural correctness.
"""
import argparse
import hashlib
import json
import time
from pathlib import Path

import numpy as np
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(4 * 1024 * 1024):
            h.update(chunk)
    return h.hexdigest()

def save_float32(target, values):
    array = values.detach().to("cpu", dtype=torch.float32).contiguous().numpy()
    array.astype("<f4", copy=False).tofile(target)
    return {"shape": list(array.shape), "sha256": sha256(target), "count": int(array.size)}

def kv_tensors(past, layer):
    if hasattr(past, "layers"):
        layer_cache = past.layers[layer]
        keys, values = getattr(layer_cache, "keys", None), getattr(layer_cache, "values", None)
        if keys is not None and values is not None:
            return keys, values
    if hasattr(past, "key_cache"):
        return past.key_cache[layer], past.value_cache[layer]
    if isinstance(past, (tuple, list)):
        return past[layer][0], past[layer][1]
    raise TypeError(f"Unsupported Transformers KV cache: {type(past)!r}")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--prompt", default="Hello world")
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    model_dir = args.model.resolve()
    output_dir = args.output.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    started = time.perf_counter()

    tokenizer = AutoTokenizer.from_pretrained(str(model_dir), use_fast=True, local_files_only=True)
    ids = tokenizer.encode(args.prompt, add_special_tokens=False)
    if len(ids) < 2:
        raise ValueError("Use a prompt that produces at least two tokens to verify KV state.")
    model = AutoModelForCausalLM.from_pretrained(
        str(model_dir), dtype=torch.float32,
        attn_implementation="eager", local_files_only=True,
    ).eval()
    elapsed_load = time.perf_counter() - started

    with torch.inference_mode():
        output = model(torch.tensor([ids], dtype=torch.long), use_cache=True)
    elapsed_total = time.perf_counter() - started

    info = {
        "reference": "Hugging Face Transformers/PyTorch",
        "torchVersion": torch.__version__,
        "transformersVersion": __import__("transformers").__version__,
        "model": str(model_dir),
        "modelSha256": sha256(model_dir / "model.safetensors"),
        "prompt": args.prompt,
        "inputIds": ids,
        "computeDtype": "float32",
        "sourceDtype": json.loads((model_dir / "config.json").read_text(encoding="utf-8")).get("torch_dtype"),
        "elapsedLoadSeconds": round(elapsed_load, 3),
        "elapsedTotalSeconds": round(elapsed_total, 3),
        "logits": [],
        "cache": [],
    }
    # At each position, compare the next-token score vector (not just argmax).
    for position in range(len(ids)):
        filename = f"logits-{position}.f32"
        details = save_float32(output_dir / filename, output.logits[0, position])
        top_values, top_ids = torch.topk(output.logits[0, position], 10)
        info["logits"].append({
            "position": position, "filename": filename, **details,
            "top10": [{"id": int(i), "value": float(v)} for i, v in zip(top_ids, top_values)],
        })

    for layer in range(model.config.num_hidden_layers):
        keys, values = kv_tensors(output.past_key_values, layer)
        for position in range(len(ids)):
            # Convert (batch, kvHead, sequence, headDim) to
            # BLACKICE's position -> kvHead -> headDim storage order.
            for kind, tensor in (("key", keys), ("value", values)):
                filename = f"cache-layer-{layer}-{kind}-{position}.f32"
                details = save_float32(output_dir / filename, tensor[0, :, position, :])
                info["cache"].append({
                    "layer": layer, "kind": kind, "position": position,
                    "filename": filename, **details,
                })
    (output_dir / "manifest.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "inputIds": ids,
        "top10First": info["logits"][0]["top10"],
        "top10Last": info["logits"][-1]["top10"],
        "cacheTensors": len(info["cache"]),
        "elapsedTotalSeconds": info["elapsedTotalSeconds"],
        "sourceDtype": info["sourceDtype"],
        "reference": info["reference"],
    }, indent=2))

if __name__ == "__main__":
    main()
