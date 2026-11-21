'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const commit = 'b1b770d90d94cad9e9ea5b993bdbc383a522fb28';
const expected = {
  'src/CMakeLists.txt': '3ad358fcd78137c551bdcd0b79698881d1515026ff2585693e898e3b85b3bec3',
  'src/llama-context.cpp': '6b2a143eee8d53cdb559eb18b5612028bdf8545ab832cfdca2c2fd87c9c00309',
  'tools/server/main.cpp': '7ec684588e04538c5f9d44cda54e67780cf68b19c3c2660699df632f5c55fe4c',
  'tools/server/server-context.h': '81d17768d3cdff0775cc38f601db0214be4b348921f50c81db95551e404595c2',
  'tools/server/server-context.cpp': '9b632c3aedb0acfea3ef44308e4f04be1f5fad10110329b05ea737fcb7bb83ef',
  'tools/server/server-http.h': '29c53f7ffde226edf3e6f48463e4807f7e554ca12e476099f90e0ff18142978d',
  'tools/server/server-http.cpp': '87fdb0dd70145b1f8daa5d9fdfe4451842adc2fcc7ef078498d4bcb54cf1ac47',
  'tools/server/server-models.cpp': 'ec8192b1af8cda89917f6fd1fb7a9b4767e1914c8eef4697a3c9eec2da36a2b4',
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function replace(text, before, after, count = 1) {
  const found = text.split(before).length - 1;
  if (found !== count) throw Error(`Patch anchor count ${found}, expected ${count}: ${before.slice(0,120)}`);
  return text.split(before).join(after);
}
function patch(file, input) {
  let s = input;
  const include = '#include "../../src/blackice-trace.h"\n';
  if (file === 'src/CMakeLists.txt') {
    s = replace(s, 'set(LLAMA_CORE_SOURCES\n', 'set(LLAMA_CORE_SOURCES\n    blackice-trace.cpp\n');
    s = replace(s, 'target_link_libraries(llama PUBLIC ggml PRIVATE Threads::Threads)',
      'target_link_libraries(llama PUBLIC ggml PRIVATE Threads::Threads)\nif (WIN32)\n    target_link_libraries(llama PRIVATE bcrypt)\nendif()');
  } else if (file === 'src/llama-context.cpp') {
    s = '#include "blackice-trace.h"\n' + s;
    s = replace(s, '\n}\n\nllama_context::~llama_context() {', '\n    blackice_trace::context_created(this);\n}\n\nllama_context::~llama_context() {');
    s = replace(s, '    // wait for any pending asynchronous copies into the output buffers before they are freed\n    synchronize();',
      '    // wait for any pending asynchronous copies into the output buffers before they are freed\n    synchronize();\n    blackice_trace::context_destroyed(this);');
    s = replace(s, 'llm_graph_result * llama_context::process_ubatch(const llama_ubatch & ubatch, llm_graph_type gtype, llama_memory_context_i * mctx, ggml_status & ret) {',
      'llm_graph_result * llama_context::process_ubatch(const llama_ubatch & ubatch, llm_graph_type gtype, llama_memory_context_i * mctx, ggml_status & ret) {\n    blackice_trace::ubatch_guard trace_scope(this, ubatch, static_cast<int>(gtype));\n    if (!blackice_trace::healthy()) { ret = GGML_STATUS_ABORTED; return nullptr; }');
    s = replace(s, '    const auto status = graph_compute(res->get_gf(), ubatch.n_tokens > 1);\n    if (status != GGML_STATUS_SUCCESS) {',
      '    auto status = graph_compute(res->get_gf(), ubatch.n_tokens > 1);\n    if (blackice_trace::capture_enabled()) { ggml_backend_sched_synchronize(sched.get()); }\n    if (!blackice_trace::healthy()) { status = GGML_STATUS_ABORTED; }\n    trace_scope.complete(status);\n    if (!blackice_trace::healthy()) { status = GGML_STATUS_ABORTED; }\n    if (status != GGML_STATUS_SUCCESS) {');
    s = replace(s, '        const auto mctx = memory->init_update(this, optimize);', '        const auto mctx = memory->init_update(this, optimize);\n        blackice_trace::memory_event(memory.get(), "maintenance_prepare", -1, -1, mctx->get_status(), -1, optimize, true);');
    s = replace(s, '        if (!mctx->apply()) {\n            LLAMA_LOG_ERROR("%s: failed to apply memory update\\n", __func__);', '        const bool applied = mctx->apply();\n        blackice_trace::memory_event(memory.get(), "maintenance_apply", -1, -1, -1, -1, optimize, applied);\n        if (!applied) {\n            LLAMA_LOG_ERROR("%s: failed to apply memory update\\n", __func__);');
    s = replace(s, '    mem->clear(data);', '    mem->clear(data);\n    blackice_trace::memory_event(mem, "clear", -1, -1, -1, -1, data, true);');
    s = replace(s, '    return mem->seq_rm(seq_id, p0, p1);', '    const bool result = mem->seq_rm(seq_id, p0, p1);\n    blackice_trace::memory_event(mem, "seq_rm", seq_id, -1, p0, p1, 0, result);\n    return result;');
    s = replace(s, '    mem->seq_cp(seq_id_src, seq_id_dst, p0, p1);', '    mem->seq_cp(seq_id_src, seq_id_dst, p0, p1);\n    blackice_trace::memory_event(mem, "seq_cp", seq_id_src, seq_id_dst, p0, p1, 0, true);');
    s = replace(s, '    mem->seq_keep(seq_id);', '    mem->seq_keep(seq_id);\n    blackice_trace::memory_event(mem, "seq_keep", seq_id, -1, -1, -1, 0, true);');
    s = replace(s, '    mem->seq_add(seq_id, p0, p1, delta);', '    mem->seq_add(seq_id, p0, p1, delta);\n    blackice_trace::memory_event(mem, "seq_add", seq_id, -1, p0, p1, delta, true);');
    s = replace(s, '    mem->seq_div(seq_id, p0, p1, d);', '    mem->seq_div(seq_id, p0, p1, d);\n    blackice_trace::memory_event(mem, "seq_div", seq_id, -1, p0, p1, d, true);');
    for (const [call, operation, sequence, flags, data] of [
      ['ctx->state_get_data(dst, size)', 'state_save', '-1', '0', 'dst'],
      ['ctx->state_set_data(src, size)', 'state_restore', '-1', '0', 'src'],
      ['ctx->state_seq_get_data(seq_id, dst, size, flags)', 'sequence_save', 'seq_id', 'flags', 'dst'],
      ['ctx->state_seq_set_data(seq_id, src, size, flags)', 'sequence_restore', 'seq_id', 'flags', 'src'],
    ]) s = replace(s, `    return ${call};`, `    const size_t result = ${call};\n    blackice_trace::state_event(ctx, "${operation}", ${sequence}, ${flags}, ${data}, size, result);\n    return result;`);
    for (const call of ['ctx->state_load_file(path_session, tokens_out, n_token_capacity, n_token_count_out)',
                       'ctx->state_save_file(path_session, tokens, n_token_count)',
                       'ctx->state_seq_save_file(seq_id, filepath, tokens, n_token_count)',
                       'ctx->state_seq_load_file(dest_seq_id, filepath, tokens_out, n_token_capacity, n_token_count_out)']) {
      s = replace(s, `        return ${call};`, `        if (blackice_trace::enabled()) {\n            blackice_trace::invalidate("External session state files are outside this trace contract");\n            return 0;\n        }\n        return ${call};`);
    }
  } else if (file === 'tools/server/main.cpp') {
    s = `${include}#include <cstdio>\n#include <cstring>\n#include <exception>\n\nint llama_server(int argc, char ** argv);\n\nint main(int argc, char ** argv) {\n    if (argc == 3 && std::strcmp(argv[1], "--blackice-trace-self-test") == 0) {\n        return blackice_trace::self_test(argv[2]);\n    }\n    try {\n        blackice_trace::initialize_process();\n        const int result = llama_server(argc, argv);\n        blackice_trace::finish_process(result);\n        return result;\n    } catch (const std::exception & error) {\n        std::fprintf(stderr, "BLACKICE experimental server failed: %s\\n", error.what());\n        blackice_trace::finish_process(2);\n        return 2;\n    }\n}\n`;
  } else if (file === 'tools/server/server-context.h') {
    s = '#include "../../src/blackice-runtime-snapshot.h"\n' + s;
    s = replace(s, '    std::string model_ftype;\n', '    std::string model_ftype;\n    std::string blackice_runtime; // immutable receipt for the current context initialization\n');
    s = replace(s, `    void update_meta(const server_context & ctx_server) {
        this->meta = std::make_unique<server_context_meta>(ctx_server.get_meta());
    }`, '    void update_meta(const server_context & ctx_server);');
    s = replace(s, '    std::mutex     mutex_cache;\n',
      '    std::mutex     mutex_cache;\n    blackice_trace::runtime_properties_snapshot trace_runtime_properties{mutex_cache};\n');
  } else if (file === 'tools/server/server-context.cpp') {
    s = include + '#include "../../src/blackice-decode-error.h"\n' + s;
    s = replace(s, '    server_metrics get_metrics() const {', `    // Initial metadata is built before HTTP readiness. Wake calls this from the
    // route callback after reload, before the queue releases waiting requests.
    std::string trace_runtime_startup() const {
        return blackice_trace::startup(ctx_tgt, json {
            {"modelId", model_name}, {"modelPath", params_base.model.path},
            {"build", std::string(llama_build_info())}, {"parallel", slots.size()},
            {"projector", json {{"loaded", mctx != nullptr}, {"path", params_base.mmproj.path},
                               {"placementKnown", false}, {"vision", chat_params.allow_image},
                               {"audio", chat_params.allow_audio}, {"video", chat_params.allow_video}}},
        }.dump());
    }

    // Caller holds the existing response awake guard. This only writes locked trace metadata.
    void record_trace_task(const std::string & payload) const {
        blackice_trace::task_registered(ctx_tgt, payload);
    }

    server_metrics get_metrics() const {`);
    s = replace(s, '        llama_init = common_init_from_params(params_base);', `        if (blackice_trace::capture_enabled()) {
            if (params_base.cb_eval && params_base.cb_eval != blackice_trace::eval_callback) {
                throw std::runtime_error("A different eval callback is already configured");
            }
            params_base.cb_eval = blackice_trace::eval_callback;
            params_base.cb_eval_user_data = nullptr;
        }
        llama_init = common_init_from_params(params_base);`);
    s = replace(s, '        /* model_ftype             */ ftype_name,', `        /* model_ftype             */ ftype_name,
        /* blackice_runtime        */ impl->trace_runtime_startup(),`);
    s = replace(s, '        { "is_sleeping",                 is_sleeping },', '        { "is_sleeping",                 is_sleeping },\n        { "blackice_runtime",             json::parse(meta.blackice_runtime) },');
    s = replace(s, 'void server_routes::init_routes() {', `void server_routes::update_meta(const server_context & server) {
    // This remains initial-only: do not replace immutable route metadata on wake.
    this->meta = std::make_unique<server_context_meta>(server.get_meta());
    if (blackice_trace::enabled()) {
        try {
            trace_runtime_properties.initialize([this]() {
                return blackice_trace::copy_runtime_properties_json<blackice_trace::runtime_properties_snapshot::json>(get_res_props(*meta, params, false));
            });
        } catch (const std::exception & error) {
            blackice_trace::invalidate(std::string("Initial runtime properties publication failed: ") + error.what());
            throw;
        }
    }
}

void server_routes::init_routes() {`);
    s = replace(s, `    this->get_props = [this](const server_http_req &) {
        auto res = create_response(true);`, `    this->get_props = [this](const server_http_req &) {
        auto res = create_response(true);
        if (blackice_trace::enabled()) {
            // The same locked publication/access helper is exercised by the
            // no-model lifecycle fixture. No live context access during sleep.
            res->ok(blackice_trace::copy_runtime_properties_json<json>(trace_runtime_properties.read()));
            return res;
        }`);
    s = replace(s, `void server_routes::update_cached_responses(bool is_sleeping) {
    // caller is task_queue, so ctx_server can be accessed without holding locks`, `void server_routes::update_cached_responses(bool is_sleeping) {
    // Queue wake callbacks run in reverse order: reload has completed, while
    // mutex_tasks still prevents waiting requests from entering the new context.
    if (blackice_trace::enabled()) {
        try {
            if (is_sleeping) {
                trace_runtime_properties.enter_sleep([this](const blackice_trace::runtime_properties_snapshot::json & sleeping_props) {
                    cached_models = get_res_models(*meta);
                    cached_props = blackice_trace::copy_runtime_properties_json<json>(sleeping_props);
                    cached_metrics = ctx_server.get_metrics();
                    should_reset_buckets = false;
                });
            } else {
                trace_runtime_properties.leave_sleep([this]() {
                    json properties = get_res_props(*meta, params, false);
                    properties["blackice_runtime"] = json::parse(ctx_server.trace_runtime_startup());
                    if (should_reset_buckets) { ctx_server.reset_metrics_bucket(); }
                    should_reset_buckets = false;
                    return blackice_trace::copy_runtime_properties_json<blackice_trace::runtime_properties_snapshot::json>(properties);
                });
            }
        } catch (const std::exception & error) {
            blackice_trace::invalidate(std::string("Runtime properties lifecycle publication failed: ") + error.what());
            // The helper is unavailable. Let the queue release its sleep barrier:
            // props now errors and task registration rejects the unhealthy capture.
            // Throwing here would strand wait_until_no_sleep() callers, whose
            // predicate only watches the queue's sleeping flag.
        }
        return;
    }
    // caller is task_queue, so ctx_server can be accessed without holding locks`);
    s = replace(s, '            task.params.oaicompat_model   = meta->model_name;\n\n            // prepare child tasks', `            task.params.oaicompat_model   = meta->model_name;
            if (blackice_trace::enabled()) {
                const auto prompt_ids = task.tokens.get_text_tokens();
                ctx_server.record_trace_task(json {
                    {"taskId", task.id}, {"completionId", completion_id}, {"serverRequestId", req.blackice_request_id},
                    {"requestedSlotId", task.id_slot}, {"promptTokenIds", prompt_ids}, {"nPromptPositions", task.n_tokens()},
                    {"allPromptPositionsAreText", prompt_ids.size() == static_cast<size_t>(task.n_tokens())},
                    {"renderedPrompt", prompt}, {"generationParams", task.params.to_json(true)},
                }.dump());
                if (task.params.n_cmpl != 1 || prompt_ids.size() != static_cast<size_t>(task.n_tokens())) {
                    blackice_trace::invalidate("Multiple completions or multimodal embedding inputs are outside this text benchmark trace contract");
                }
            }

            // prepare child tasks`);
    s = replace(s, '        slot.task = std::make_unique<const server_task>(std::move(task));', `        slot.task = std::make_unique<const server_task>(std::move(task));
        if (blackice_trace::enabled()) {
            blackice_trace::event(ctx_tgt, "task_slot_assigned", json {
                {"taskId", slot.task->id}, {"slotId", slot.id}, {"nPredictMax", slot.n_predict_max},
                {"samplerSeed", slot.smpl ? json(common_sampler_get_seed(slot.smpl.get())) : json(nullptr)},
                {"samplerChain", slot.smpl ? common_sampler_print(slot.smpl.get()) : std::string()},
            }.dump());
        }`);
    s = replace(s, '                        slot.stats.n_prompt_cached    = n_past;', `                        if (blackice_trace::enabled()) {
                            blackice_trace::event(ctx_tgt, "prompt_cache_prefix", json {
                                {"taskId", slot.task->id}, {"slotId", slot.id}, {"cachedPositions", n_past},
                                {"promptPositions", slot.task->n_tokens()},
                            }.dump());
                        }
                        slot.stats.n_prompt_cached    = n_past;`);
    s = replace(s, '        queue_tasks.yield_to_queue([&]() {\n            ret = llama_process(ctx_tgt, LLAMA_PROCESS_TYPE_DECODE, batch.view.get());', `        queue_tasks.yield_to_queue([&]() {
            if (blackice_trace::enabled()) {
                json rows = json::array();
                for (int i = off; i < off + batch.view.size(); ++i) {
                    const auto & token = batch.tokens[i];
                    const auto & slot = slots[token.id_slot];
                    rows.push_back(json {{"batchRow", i-off}, {"serverBatchRow", i}, {"slotId", token.id_slot},
                        {"taskId", slot.task ? slot.task->id : -1}, {"tokenId", token.token},
                        {"positions", json::array({token.pos[0],token.pos[1],token.pos[2],token.pos[3]})},
                        {"output", token.output}, {"isPrompt", token.is_prompt}, {"embeddingRow", token.i_embd}});
                }
                blackice_trace::batch_begin(ctx_tgt, rows.dump());
            }
            ret = llama_process(ctx_tgt, LLAMA_PROCESS_TYPE_DECODE, batch.view.get());`);
    s = replace(s, '            if (ret == 0 && has_output) {\n                llama_synchronize(ctx_tgt);\n            }\n        });', `            if (ret == 0 && has_output) {
                llama_synchronize(ctx_tgt);
            }
            blackice_trace::batch_end(ctx_tgt, ret);
        });`);
    s = replace(s, '                id = common_sampler_sample(slot.smpl.get(), slot.ctx_tgt, tok_idx);', '                id = common_sampler_sample(slot.smpl.get(), slot.ctx_tgt, tok_idx);\n                blackice_trace::sample_logits(slot.ctx_tgt, slot.task->id, slot.id, tok_idx, id);');
    s = replace(s, '        slot.sampled = result.tok;', '        slot.sampled = result.tok;\n        blackice_trace::accepted_token(slot.ctx_tgt, slot.task->id, slot.id, result.tok);');
    s = replace(s, '        res->generation_params = slot.task->params; // copy the parameters', `        res->generation_params = slot.task->params; // copy the parameters
        if (blackice_trace::enabled()) {
            blackice_trace::task_terminal(ctx_tgt, slot.task->id, "completed", json {
                {"slotId", slot.id}, {"completionId", slot.task->params.oaicompat_cmpl_id},
                {"nDecoded", slot.stats.n_gen}, {"nPromptPositions", slot.task->n_tokens()},
                {"nPromptCached", slot.stats.n_prompt_cached}, {"stopType", static_cast<int>(slot.stop)},
                {"truncated", slot.truncated},
            }.dump());
        }`);
    s = replace(s, '        SRV_ERR("task id = %d, error: %s\\n", id_task, error.c_str());', `        SRV_ERR("task id = %d, error: %s\\n", id_task, error.c_str());
        if (blackice_trace::enabled()) {
            blackice_trace::task_terminal(ctx_tgt, id_task, "error", json {{"message",error},{"errorType",static_cast<int>(type)}}.dump());
        }`);
    s = replace(s, '            SLT_INF(*this, "stop processing: n_tokens = %d, truncated = %d\\n", prompt.n_tokens(), truncated);', '            SLT_INF(*this, "stop processing: n_tokens = %d, truncated = %d\\n", prompt.n_tokens(), truncated);\n            blackice_trace::task_released(ctx_tgt, task->id, id);');
    s = replace(s, `            {
                std::string err;

                if (n_batch == 1 && ret == 1) {
                    // TODO: try to terminate only the largest active slot/sequence and continue with the rest
                    //       need to remove the tokens from the current batch too
                    err = "Context size has been exceeded.";
                }

                if (ret == -1) {
                    err = "Invalid input batch.";
                }

                if (ret < -1) {
                    // TODO: update slot state based on llama_memory_seq_pos_min() and llama_memory_seq_pos_max()
                    err = "Compute error.";
                }

                // TODO: handle ret == 2 (abort) when we start aborting

                if (!err.empty()) {
                    SRV_ERR("%s off = %d, n_batch = %d, ret = %d\\n", err.c_str(), off, n_batch, ret);

                    for (auto & slot : slots) {
                        if (slot.is_processing()) {
                            send_error(slot, err);
                            slot.release();

                            // note: it's complicated to keep track of how much of the current batch has been
                            //       processed before the error occurred, so we simply clear the entire context
                            slot.prompt_clear();
                        }
                    }

                    // stop, do not retry with smaller batch size
                    throw std::runtime_error(err);
                }
            }
`, `            blackice_trace::route_decode_failure(ret, n_batch, blackice_trace::healthy(), slots,
                [this](auto & slot, const std::string & error) { send_error(slot, error); },
                [&](const std::string & error) {
                    SRV_ERR("%s off = %d, n_batch = %d, ret = %d\\n", error.c_str(), off, n_batch, ret);
                });
`);
  } else if (file === 'tools/server/server-http.h') {
    s = replace(s, '    const std::function<bool()> & should_stop;', '    const std::function<bool()> & should_stop;\n    std::string blackice_request_id; // assigned from the actual HTTP request, never model-controlled');
  } else if (file === 'tools/server/server-http.cpp') {
    s = include + s;
    s = replace(s, '        const auto chunked_content_provider = [response = r_ptr](size_t, httplib::DataSink & sink) -> bool {', `        struct stream_observation {
            bool producer_exhausted = false;
            bool sink_done_called = false;
            bool chunk_write_failed = false;
        };
        const auto observed = std::make_shared<stream_observation>();
        const auto chunked_content_provider = [response = r_ptr, observed](size_t, httplib::DataSink & sink) -> bool {`);
    s = replace(s, '            const bool has_next = response->next(chunk);', '            const bool has_next = response->next(chunk);\n            observed->producer_exhausted = !has_next;');
    s = replace(s, '                if (!sink.write(chunk.data(), chunk.size())) {\n                    return false;', '                if (!sink.write(chunk.data(), chunk.size())) {\n                    observed->chunk_write_failed = true;\n                    return false;');
    s = replace(s, '            if (!has_next) {\n                sink.done();', '            if (!has_next) {\n                observed->sink_done_called = true;\n                sink.done();');
    s = replace(s, '            return has_next;\n        };\n        const auto on_complete =', '            // true means this provider invocation succeeded, including normal EOF.\n            // httplib separately checks writes performed by the void sink.done().\n            return true;\n        };\n        const auto on_complete =');
    s = replace(s, '    // srv->set_logger(log_server_request); // TODO @ngxson : this is too spamy, no very useful; improve it in the future', `    if (blackice_trace::enabled()) {
        srv->set_logger([](const httplib::Request & req, const httplib::Response & res) {
            try {
                std::map<std::string,std::string> headers(req.headers.begin(),req.headers.end());
                // Rejections in pre-routing may not have read an entity body. Preserve this gap explicitly.
                blackice_trace::http_begin(&req, req.method, req.path, req.body, headers, false);
                blackice_trace::http_finish(&req, res.status);
            } catch (const std::exception & error) { blackice_trace::invalidate(error.what()); }
        });
    }`);
    s = replace(s, '        server_http_res_ptr response = handler(*request);\n        process_handler_response(std::move(request), response, res);', `        request->blackice_request_id = blackice_trace::http_begin(&req, req.method, req.path, req.body, request->headers);
        server_http_res_ptr response = handler(*request);
        if (!request->blackice_request_id.empty()) {
            const auto child = response->headers.find("X-Blackice-Server-Request-Id");
            if (child != response->headers.end()) { response->headers["X-Blackice-Child-Server-Request-Id"] = child->second; }
            response->headers["X-Blackice-Server-Request-Id"] = request->blackice_request_id;
            const auto attempt = blackice_trace::header_value(request->headers,"X-Blackice-Attempt-Id");
            if (!attempt.empty()) { response->headers["X-Blackice-Attempt-Id"] = attempt; }
        }
        process_handler_response(std::move(request), response, res);`, 3);
    s = replace(s, '        const auto on_complete = [request = q_ptr, response = r_ptr](bool) mutable {\n            response->on_complete();', '        const auto on_complete = [request = q_ptr, response = r_ptr, observed](bool success) mutable {\n            blackice_trace::http_generator_end(request->blackice_request_id, response->status, success, true,\n                observed->producer_exhausted, observed->sink_done_called, observed->chunk_write_failed);\n            response->on_complete();');
    s = replace(s, '        res.set_content(response->data, response->content_type);\n        response->on_complete();', '        res.set_content(response->data, response->content_type);\n        blackice_trace::http_generator_end(request->blackice_request_id, response->status, true, false, false, false, false);\n        response->on_complete();');
  } else if (file === 'tools/server/server-models.cpp') {
    s = include + s;
    s = replace(s, '    auto proxy = std::make_unique<server_http_proxy>(\n            method,', `    auto forwarded_headers = child_request_headers(req.headers);
    if (!req.blackice_request_id.empty()) { forwarded_headers["X-Blackice-Router-Request-Id"] = req.blackice_request_id; }
    auto proxy = std::make_unique<server_http_proxy>(
            method,`);
    s = replace(s, '            proxy_path,\n            child_request_headers(req.headers),', '            proxy_path,\n            forwarded_headers,');
  } else throw Error(`No patch for ${file}`);
  if (file === 'tools/server/main.cpp') {
    s = replace(s, '    try {\n        blackice_trace::initialize_process();',
      '    if (argc == 3 && std::strcmp(argv[1], "--blackice-trace-empty-self-test") == 0) {\n        return blackice_trace::empty_self_test(argv[2]);\n    }\n    try {\n        blackice_trace::initialize_process();');
  }
  return s;
}
function writeAtomic(file, bytes) {
  if (fs.existsSync(file) && sha(fs.readFileSync(file)) === sha(bytes)) return;
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temporary = `${file}.write-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const fd = fs.openSync(temporary, 'wx');
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary,file);
  if (sha(fs.readFileSync(file)) !== sha(bytes)) throw Error(`Readback mismatch: ${file}`);
}
function apply(root) {
  if (!path.isAbsolute(root)) throw Error('An absolute owned trace root is required');
  const source = path.join(root,'source',`llama.cpp-${commit}`);
  const receiptFile = path.join(root,'receipts','instrumentation-applied.json');
  const prior = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile,'utf8')) : null;
  const baseline = JSON.parse(fs.readFileSync(path.join(root,'baseline','manifest.json'),'utf8'));
  if (baseline.sourceModified || baseline.sourceCommit !== commit || baseline.files.find(f=>f.name==='llama-server.exe')?.sha256 !== 'dbe74057c20e1dd8fc0588a647bd28f4d7c7bb86d11562e6597dcc580fe024d5') throw Error('Qualified baseline is absent or differs');
  const pending = [];
  for (const [relative, digest] of Object.entries(expected)) {
    const file = path.join(source,relative), saved = path.join(root,'upstream-files',relative);
    const bytes = fs.readFileSync(fs.existsSync(saved) ? saved : file);
    if (sha(bytes) !== digest) throw Error(`Pinned upstream input differs: ${relative}`);
    const current = sha(fs.readFileSync(file));
    if (current !== digest && current !== prior?.files.find(f=>f.path===relative)?.sha256) throw Error(`Unowned source change: ${relative}`);
    pending.push({relative,file,upstream:bytes,saved,bytes:Buffer.from(patch(relative,bytes.toString('utf8'))),beforeSha256:current});
  }
  for (const name of ['blackice-trace.h','blackice-trace.cpp','blackice-decode-error.h','blackice-empty-self-test.inc','blackice-runtime-snapshot.h','blackice-text-position.h']) {
    const relative = `src/${name}`, file = path.join(source,relative), bytes = fs.readFileSync(path.join(__dirname,name));
    if (fs.existsSync(file) && sha(fs.readFileSync(file)) !== prior?.files.find(f=>f.path===relative)?.sha256) throw Error(`Unowned instrumentation source: ${relative}`);
    pending.push({relative,file,bytes,beforeSha256:fs.existsSync(file)?sha(fs.readFileSync(file)):null});
  }
  for (const item of pending) {
    if (item.saved && !fs.existsSync(item.saved)) { fs.mkdirSync(path.dirname(item.saved),{recursive:true}); fs.writeFileSync(item.saved,item.upstream,{flag:'wx'}); }
    writeAtomic(item.file,item.bytes);
  }
  const receipt = {schema:'blackice.minicpm.instrumentation-applied.v1',at:new Date().toISOString(),sourceCommit:commit,
    patchScriptSha256:sha(fs.readFileSync(__filename)),files:pending.map(p=>({path:p.relative,beforeSha256:p.beforeSha256,sha256:sha(p.bytes),bytes:p.bytes.length})),
    modelStarted:false,nativeCompileVerified:false,parityVerified:false};
  writeAtomic(receiptFile,Buffer.from(JSON.stringify(receipt,null,2)+'\n'));
  console.log(JSON.stringify({receipt:receiptFile,files:receipt.files,modelStarted:false}));
}
if (require.main === module) {
  try { apply(process.argv[2]); } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
module.exports = {patch,expected,sha};
