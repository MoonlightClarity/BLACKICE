import test from 'node:test';
import assert from 'node:assert/strict';
import { Qwen3Reference } from '../lib/native-inference/reference-qwen3.mjs';
import { NativeBatchedMatmul } from '../lib/native-inference/batched-matmul.mjs';
import { generateQwen3Batched } from '../lib/native-inference/batched-generation.mjs';

const config={model_type:'qwen3',hidden_size:4,num_hidden_layers:2,num_attention_heads:2,
 num_key_value_heads:1,head_dim:2,intermediate_size:7,vocab_size:13,max_position_embeddings:64,
 rms_norm_eps:1e-6,rope_theta:10000,tie_word_embeddings:true,eos_token_id:12};
function fixture() {
 let seed=317;
 const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return (seed/4294967296-.5)*.26;};
 const T=new Map();
 const add=(name,shape,positive=false)=>T.set(name,{shape,
   data:Float32Array.from({length:shape.reduce((a,b)=>a*b,1)},()=>positive?1+next():next())});
 const H=config.hidden_size,D=config.head_dim,Q=config.num_attention_heads,
   K=config.num_key_value_heads,I=config.intermediate_size;
 add('model.embed_tokens.weight',[config.vocab_size,H]);add('model.norm.weight',[H],true);
 for(let layer=0;layer<config.num_hidden_layers;layer++) {
  const prefix='model.layers.'+layer+'.',attn=prefix+'self_attn.';
  add(prefix+'input_layernorm.weight',[H],true);add(prefix+'post_attention_layernorm.weight',[H],true);
  add(attn+'q_norm.weight',[D],true);add(attn+'k_norm.weight',[D],true);
  add(attn+'q_proj.weight',[Q*D,H]);add(attn+'k_proj.weight',[K*D,H]);
  add(attn+'v_proj.weight',[K*D,H]);add(attn+'o_proj.weight',[H,Q*D]);
  add(prefix+'mlp.gate_proj.weight',[I,H]);add(prefix+'mlp.up_proj.weight',[I,H]);
  add(prefix+'mlp.down_proj.weight',[H,I]);
 }
 return new Qwen3Reference({config,tensors:{async tensor(name){return T.get(name);}},maxContext:64});
}
async function oracleGenerate(model,ids,count) {
 model.reset();let logits;
 for(const id of ids)logits=await model.step(id);
 const out=[];
 for(let i=0;i<count;i++) {
   let next=0;for(let j=1;j<logits.length;j++)if(logits[j]>logits[next])next=j;
   out.push(next);
   if(next===config.eos_token_id)break;
   if(i<count-1)logits=await model.step(next);
 }
 return out;
}
const almostEqual=(actual,expected)=>{
 assert.equal(actual.length,expected.length);
 for(let i=0;i<actual.length;i++)assert.ok(Math.abs(actual[i]-expected[i])<0.0002);
};

test('batched prompt prefill followed by autoregressive decode matches sequential reference', async()=>{
 const ids=[3,2,5,7,4,11,9],expected=fixture(),actual=fixture();
 const oracle=await oracleGenerate(expected,ids,4),received=[];
 const tokens=await generateQwen3Batched(actual,ids,{blockSize:3,maxNewTokens:4,onToken:id=>received.push(id)});
 assert.deepEqual(tokens,oracle);assert.deepEqual(received,tokens);
 assert.equal(actual.position,expected.position);
 for(let layer=0;layer<config.num_hidden_layers;layer++) {
  for(const name of ['keys','values']) {
   assert.equal(actual.cache[layer][name].length,expected.cache[layer][name].length);
   for(let t=0;t<actual.cache[layer][name].length;t++)
     almostEqual(actual.cache[layer][name][t],expected.cache[layer][name][t]);
  }
 }
});

test('batched WASM SIMD prefill supports native generation without third-party inference',async()=>{
 const kernel=await NativeBatchedMatmul.create({tileBytes:1<<20});
 const ids=[1,2,3,4,5,6,7],oracle=await oracleGenerate(fixture(),ids,3);
 const output=await generateQwen3Batched(fixture(),ids,{projector:kernel,blockSize:4,maxNewTokens:3});
 assert.deepEqual(output,oracle);assert.ok(kernel.snapshot().calls>0);
});

test('aborted prompt generation cannot emit a successful token',async()=>{
 const model=fixture(),controller=new AbortController();controller.abort();let emitted=0;
 await assert.rejects(()=>generateQwen3Batched(model,[1,3,4],{
   signal:controller.signal,onToken:()=>emitted++,
 }),/abort/i);
 assert.equal(emitted,0);
});
