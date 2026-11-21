#pragma once

// Private benchmark instrumentation. This header is not part of llama's public ABI.
#include "llama.h"
#include <cstdint>
#include <map>
#include <string>

struct llama_ubatch;

namespace blackice_trace {
void initialize_process();
void finish_process(int exit_code);
bool enabled();
bool capture_enabled();
bool healthy();
void invalidate(const std::string & reason) noexcept;
bool eval_callback(ggml_tensor * tensor, bool ask, void * user_data);

void context_created(llama_context * ctx);
void context_destroyed(llama_context * ctx);
std::string startup(llama_context * ctx, const std::string & server_metadata);
void event(llama_context * ctx, const char * name, const std::string & payload);
void task_registered(llama_context * ctx, const std::string & payload);
void task_terminal(llama_context * ctx, int task_id, const char * outcome, const std::string & payload);
void task_released(llama_context * ctx, int task_id, int slot_id);

std::string http_begin(const void * native_request, const std::string & method,
                       const std::string & path, const std::string & body,
                       const std::map<std::string, std::string> & headers, bool body_observed = true);
void http_finish(const void * native_request, int status);
void http_generator_end(const std::string & request_id, int status, bool raw_releaser_success, bool streaming,
                        bool producer_exhausted, bool sink_done_called, bool chunk_write_failed);
std::string header_value(const std::map<std::string, std::string> & headers, const std::string & key);

void batch_begin(llama_context * ctx, const std::string & rows);
void batch_end(llama_context * ctx, int result);
void sample_logits(llama_context * ctx, int task_id, int slot_id, int batch_row, llama_token token);
void accepted_token(llama_context * ctx, int task_id, int slot_id, llama_token token);

class ubatch_guard {
public:
    ubatch_guard(llama_context * ctx, const llama_ubatch & batch, int graph_type);
    ~ubatch_guard();
    void complete(int status);
private:
    bool active = false;
};

void memory_event(llama_memory_t memory, const char * operation, int seq_id, int seq_dst,
                  int64_t p0, int64_t p1, int64_t delta, bool result);
void state_event(llama_context * ctx, const char * operation, int seq_id, uint32_t flags,
                 const uint8_t * data, size_t requested, size_t returned);
int self_test(const std::string & directory);
int empty_self_test(const std::string & directory);
} // namespace blackice_trace
