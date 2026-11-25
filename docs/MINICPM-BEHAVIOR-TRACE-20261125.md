# MiniCPM behavioral tracing — 25 November 2026

## Scope

Read-only testing of the exact MiniCPM-V-4.7-1B-heretic-Q4_K_S GGUF used by BLACKICE, in an isolated branch and separate local llama.cpp server. No source résumé, installed application, model weights, or existing provider configuration was modified. This is diagnostic evidence, not semantic certification.

## Short evidence tests versus analysis

The eight-pair, 16-case synthetic short-source benchmark with normal reasoning returned 16/16 evidence-consistent answers. The contrasts covered attribution, quantities, causal evidence, personal code authorship, direct reports, source-linked project relationships, and headline versus job entry.

Using the same Q4 model with reasoning disabled and a grammar-restricted binary answer, the answer-position token trace returned 25/32 evidence-consistent decisions. Three source-order changes flipped the A/B preference: repository presence, partial improvement counts, and formal management. The restricted first-token result is not comparable to an unconstrained answer.

With reasoning enabled, the separate chat test got 9/10 on five difficult cases in both source orders; in one error the explanation supported Yes while the answer began No. A native completion trace located the final choice token after the reasoning finalizer and got 8/8 on four selected pairs. These use different response transports and do not prove that more reasoning will repair the longer task.

## Full two-page source trace

The isolated BLACKICE compact prompt was captured exactly and run with the full source and normal BLACKICE execution instructions. It used about 1,893 input tokens and 1,202 output tokens with reasoning enabled; 4,264 visible reasoning characters preceded a 1,870-character final response. It finished normally after about 35.8 seconds. With reasoning disabled, it returned about 1,194 characters in 5.2 seconds.

The reasoning text rehearsed source extraction, role inventories, and generic strengths, then repeated these as the final assessment. It did not actually compare competing interpretations or evaluate the evidentiary strength of technical and leadership claims. There was no context overflow, empty response, or premature truncation. This is a genuine behavioral-analysis failure.

## Complete-source factual counterfactuals

Four reversible prompt-only changes each substituted one material source statement, keeping the rest of the original document intact. Explicit personal production-code authorship was reflected as coding experience; an explicit statement that others wrote the implementation reduced that claim. Explicit management responsibility for 20 direct reports was reflected as formal management, while explicit external quality review remained quality review. All four runs still produced formulaic positive summaries and overclaimed general technical and analytical competence. The model can follow clear changed facts but tends to promote uncertain claims into positive outcomes.

The private source text and full model outputs are retained only in untracked local receipts, not committed to Git.

## Source genre and task wording

A synthetic onboarding report with an explicit decision question caused MiniCPM to identify confounding factors, distinguish observed activation changes from causal proof, and suggest further investigation. With the decision question omitted and only a general analysis request, the response shifted toward a section-by-section breakdown and incorrectly stated that 1,800 minus 1,400 was 200 rather than 400. It still recognized the confounders.

On the unchanged original résumé:
- Analyze the résumé led to a detailed role-by-role inventory rather than substantive evaluation.
- Analyze the source did essentially the same despite changing the word résumé to source.
- Evaluate the résumé switched to a generic strengths, improvements, and verdict format, including recommendations to add evidence already present.
- Analyze as an employer produced a strengths-and-fit template rather than a serious analysis of source-supported implications.

The failure cannot be attributed solely to the word analyze, the employer persona, or an inability to read the source. The dominant failure appears to be a learned response pattern for professional profiles and a failure to select consequential analytical questions when claims are ambiguous.

## Trace infrastructure and weight-edit limits

The isolated scripts gguf-counterfactual-trace.mjs and gguf-reasoning-transition.mjs collect unmasked answer-position token log probabilities on the unchanged GGUF. They validate that the final answer token is outside the reasoning section, record forced-probe probabilities separately, and label all results not semantically verified. No model weights were modified.

The installed llama.dll exposes final-token logits and embedding APIs but not a llama_set_eval_callback function. The ggml-base.dll scheduler callback is exported, but the public llama context does not provide the scheduler pointer needed for layer-by-layer capture. Reliable internal activation traces therefore require a separate instrumentation build or an equivalent model-loading framework. Layer-level localization has not been done.

The local machine has a Quadro RTX 3000 with 6 GB VRAM and about 32 GB system memory. The active GGUF is approximately 648 MB. The matching BF16 checkpoint was identified and its metadata downloaded; the full BF16 tensor file was not downloaded, dequantized, or edited.

## Next discriminating experiment

Trace the quantized model internally at the transition from source comprehension to evaluating claims, comparing the same source framed as an analytical task versus résumé evaluation. Identify and test candidate layers/directions on held-out evidence tasks, long-source synthesis, arithmetic, code reasoning, and vision. Only after a credible causal direction is isolated should a small reversible weight edit be attempted. Avoid generic refusal or anti-praise surgery, which would optimize a superficial proxy and could damage useful reasoning or legitimate agreement.

Current conclusion: behavioral failure is real and pronounced in the long résumé task; local evidence understanding often works. Neither Heretic nor direct surgery has yet been demonstrated to repair the actual analytical behavior.
