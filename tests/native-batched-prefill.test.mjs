import test from 'node:test';
import assert from 'node:assert/strict';
import { Qwen3Reference } from '../lib/native-inference/reference-qwen3.mjs';
import { NativeBatchedMatmul, referenceBatchedMatmul } from '../lib/native-inference/batched-matmul.mjs';
import { prefillQwen3 } from '../lib/native-inference/batched-prefill.mjs';

const cfg = { model_type:'qwen3', hidden_size:8, num_hidden_layers:2,
  num_attention_heads:2, num_key_value_heads:1, head_dim:4,
  intermediate_size:13, vocab_size:25, max_position_embeddings:128,
  rms_norm_eps:1e-6, rope_theta:10000, tie_word_embeddings:true, eos_token_id:2 };

function fixture() {
  const shapes=new Map(); let seed=0x29a5;
  const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return (seed/4294967296-.5)*0.12;};
  const add=(name,shape,scale=false)=>shapes.set(name,{
    shape, data:Float32Array.from({length:shape.reduce((a,b)=>a*b,1)},()=>scale?0.8+rnd():rnd()),
  });
  const H=cfg.hidden_size,D=cfg.head_dim,Q=cfg.num_attention_heads,K=cfg.num_key_value_heads,I=cfg.intermediate_size;
  add('model.embed_tokens.weight',[cfg.vocab_size,H]);add('model.norm.weight',[H],true);
  for(let l=0;l<cfg.num_hidden_layers;l++) {
    const pre='model.layers.'+l+'.',attn=pre+'self_attn.';
    add(pre+'input_layernorm.weight',[H],true);add(pre+'post_attention_layernorm.weight',[H],true);
    add(attn+'q_norm.weight',[D],true);add(attn+'k_norm.weight',[D],true);
    add(attn+'q_proj.weight',[Q*D,H]);add(attn+'k_proj.weight',[K*D,H]);add(attn+'v_proj.weight',[K*D,H]);
    add(attn+'o_proj.weight',[H,Q*D]);add(pre+'mlp.gate_proj.weight',[I,H]);
    add(pre+'mlp.up_proj.weight',[I,H]);add(pre+'mlp.down_proj.weight',[H,I]);
  }
  return new Qwen3Reference({ config:cfg, tensors:{async tensor(name){return shapes.get(name);}},maxContext:64 });
}
function equalFloatArrays(actual,expected,epsilon=0.0001) {
  assert.equal(actual.length,expected.length);
  for(let i=0;i<actual.length;i++)assert.ok(Math.abs(actual[i]-expected[i])<epsilon,
    'Mismatch '+i+': '+actual[i]+' versus '+expected[i]);
}
function equalState(a,b,epsilon=0.0001) {
  assert.equal(a.position,b.position);
  for(let layer=0;layer<cfg.num_hidden_layers;layer++)for(const kind of ['keys','values']) {
    const left=a.cache[layer][kind],right=b.cache[layer][kind];assert.equal(left.length,right.length);
    for(let t=0;t<left.length;t++)equalFloatArrays(left[t],right[t],epsilon);
  }
}

test('batched Qwen3 prefill matches sequential native Qwen3 logits and KV cache for varied chunking',async()=>{
  const ids=[3,7,10,5,17,2,1,18,9];
  for(const blockSize of [1,2,3,4,8,16]) {
    const oracle=fixture(),batched=fixture();let logits;
    for(const id of ids)logits=await oracle.step(id);
    const output=await prefillQwen3(batched,ids,{blockSize});
    equalFloatArrays(output,logits);equalState(batched,oracle);
  }
});

test('prefill appends additional tokens without resetting a valid previous KV cache',async()=>{
  const ids=[1,3,7,11,13,5,19],oracle=fixture(),batched=fixture();let logits;
  for(const id of ids)logits=await oracle.step(id);
  await prefillQwen3(batched,ids.slice(0,3),{blockSize:2});
  const output=await prefillQwen3(batched,ids.slice(3),{blockSize:3});
  equalFloatArrays(output,logits);equalState(batched,oracle);
});

test('actual BLACKICE WASM SIMD batched projections preserve final Qwen3 logits and causal KV state',async()=>{
  const kernel=await NativeBatchedMatmul.create({tileBytes:1<<20});
  const ids=[1,3,7,11,13,5,19,2,8,14],oracle=fixture(),batched=fixture();let logits;
  for(const id of ids)logits=await oracle.step(id);
  const output=await prefillQwen3(batched,ids,{projector:kernel,blockSize:7});
  equalFloatArrays(output,logits,0.0002);equalState(batched,oracle,0.0002);
  assert.ok(kernel.snapshot().calls>0);
});

test('interrupted batched prefill commits neither the partial KV cache nor the position',async()=>{
  const model=fixture(),failure=new Error('cancelled'),ids=[3,7,2,5,6,8];let calls=0;
  const projector={project(...args){if(++calls>5)throw failure;return referenceBatchedMatmul(...args);}};
  await assert.rejects(()=>prefillQwen3(model,ids,{projector,blockSize:3}),error=>error===failure);
  assert.equal(model.position,0);
  for(const layer of model.cache)assert.equal(layer.keys.length,0);
  const logits=await prefillQwen3(model,[3,7]);
  assert.equal(logits.length,cfg.vocab_size);assert.equal(model.position,2);
});

test('out-of-context tokens or invalid block settings fail before mutation',async()=>{
  const model=fixture();model.maxContext=2;
  await assert.rejects(()=>prefillQwen3(model,[1,2,3]),/context window/);
  await assert.rejects(()=>prefillQwen3(model,[-1]),/valid token/);
  await assert.rejects(()=>prefillQwen3(model,[1],{blockSize:129}),/block size/);
  assert.equal(model.position,0);
});
