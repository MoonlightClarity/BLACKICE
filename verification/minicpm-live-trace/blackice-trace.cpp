#include "blackice-trace.h"
#include "blackice-decode-error.h"
#include "blackice-runtime-snapshot.h"
#include "blackice-text-position.h"
#include "llama-batch.h"
#include "llama-context.h"
#include "llama-model.h"
#include "llama-vocab.h"
#include "llama-kv-cache.h"
#include "llama-memory-hybrid.h"
#include "../vendor/nlohmann/json.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <algorithm>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <limits>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace blackice_trace {
using json = nlohmann::ordered_json;
namespace fs = std::filesystem;
namespace {
constexpr uint64_t ERROR_RESERVE = 4096;
constexpr uint64_t MAX_TENSOR_BYTES = 64ULL * 1024 * 1024;
const std::set<std::string> supported_anchors = {"attn_norm", "attn_post_norm", "ffn_out", "l_out"};

std::string hex(const uint8_t * data, size_t size) {
    static const char digits[] = "0123456789abcdef";
    std::string out(size * 2, '0');
    for (size_t i = 0; i < size; ++i) { out[2*i] = digits[data[i] >> 4]; out[2*i+1] = digits[data[i] & 15]; }
    return out;
}

std::string sha256(const void * data, size_t size) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    auto check = [](NTSTATUS status) { if (status < 0) { throw std::runtime_error("BCrypt SHA256 failed"); } };
    try {
        check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0));
        check(BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0));
        const auto * bytes = static_cast<const uint8_t *>(data);
        size_t offset = 0;
        while (offset < size) {
            const ULONG count = static_cast<ULONG>(std::min<size_t>(size - offset, 1024 * 1024));
            check(BCryptHashData(hash, const_cast<PUCHAR>(bytes + offset), count, 0));
            offset += count;
        }
        uint8_t digest[32];
        check(BCryptFinishHash(hash, digest, sizeof(digest), 0));
        BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm, 0);
        return hex(digest, sizeof(digest));
    } catch (...) {
        if (hash) { BCryptDestroyHash(hash); }
        if (algorithm) { BCryptCloseAlgorithmProvider(algorithm, 0); }
        throw;
    }
}

std::string unique_id() {
    uint8_t bytes[16];
    if (BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) {
        throw std::runtime_error("BCrypt random ID failed");
    }
    return hex(bytes, sizeof(bytes));
}

std::string iso_time(const FILETIME & file_time) {
    SYSTEMTIME time;
    if (!FileTimeToSystemTime(&file_time, &time)) { throw std::runtime_error("FileTimeToSystemTime failed"); }
    char buffer[40];
    std::snprintf(buffer, sizeof(buffer), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
                  time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond, time.wMilliseconds);
    return buffer;
}

std::string now() { FILETIME time; GetSystemTimeAsFileTime(&time); return iso_time(time); }
std::string process_start() {
    FILETIME creation, exit, kernel, user;
    if (!GetProcessTimes(GetCurrentProcess(), &creation, &exit, &kernel, &user)) {
        throw std::runtime_error("GetProcessTimes failed");
    }
    return iso_time(creation);
}

fs::path executable_path() {
    std::vector<wchar_t> buffer(32768);
    const DWORD count = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (count == 0 || count >= buffer.size()) { throw std::runtime_error("GetModuleFileNameW failed or truncated"); }
    return fs::path(std::wstring(buffer.data(), count));
}

std::string path_utf8(const fs::path & path) {
    const auto text = path.u8string();
    return std::string(reinterpret_cast<const char *>(text.data()), text.size());
}

std::string read_bytes(const fs::path & path, uint64_t maximum) {
    const auto size = fs::file_size(path);
    if (size > maximum) { throw std::runtime_error("Trace configuration exceeds size bound"); }
    std::ifstream stream(path, std::ios::binary);
    if (!stream) { throw std::runtime_error("Cannot open trace configuration"); }
    std::string bytes(static_cast<size_t>(size), '\0');
    stream.read(bytes.data(), static_cast<std::streamsize>(size));
    if (stream.gcount() != static_cast<std::streamsize>(size)) { throw std::runtime_error("Short trace configuration read"); }
    return bytes;
}

struct config {
    bool enabled = false;
    bool activation_capture = false;
    fs::path output;
    uint64_t max_bytes = 0;
    uint64_t logit_vector_steps = 0;
    std::vector<std::string> anchors;
    json effective;
};

config parse_config(const std::string & bytes) {
    const json value = json::parse(bytes);
    const std::set<std::string> allowed = {"schema", "enabled", "activationCaptureEnabled", "outputDirectory", "tensorSelection", "maxBytes", "logitVectorSteps"};
    if (!value.is_object()) { throw std::runtime_error("Trace configuration must be an object"); }
    for (auto it = value.begin(); it != value.end(); ++it) {
        if (!allowed.count(it.key())) { throw std::runtime_error("Unknown trace configuration field: " + it.key()); }
    }
    if (value.at("schema") != "blackice.minicpm.trace-config.v1" ||
        !value.at("enabled").is_boolean() || !value.at("activationCaptureEnabled").is_boolean() ||
        !value.at("outputDirectory").is_string() || !value.at("maxBytes").is_number_unsigned() ||
        !value.at("tensorSelection").is_array()) { throw std::runtime_error("Malformed trace configuration"); }
    config result;
    result.enabled = value.at("enabled").get<bool>();
    result.activation_capture = value.at("activationCaptureEnabled").get<bool>();
    result.output = fs::u8path(value.at("outputDirectory").get<std::string>());
    result.max_bytes = value.at("maxBytes").get<uint64_t>();
    if (!result.output.is_absolute() || result.max_bytes < 65536 || result.max_bytes > 8ULL * 1024 * 1024 * 1024) {
        throw std::runtime_error("Trace output must be absolute; maxBytes must be 65536..8589934592");
    }
    std::set<std::string> seen;
    for (const auto & anchor : value.at("tensorSelection")) {
        if (!anchor.is_string()) { throw std::runtime_error("Tensor selection entries must be strings"); }
        const auto name = anchor.get<std::string>();
        if (!supported_anchors.count(name) || !seen.insert(name).second) { throw std::runtime_error("Unknown or duplicate tensor anchor"); }
        result.anchors.push_back(name);
    }
    if (result.anchors.empty()) { throw std::runtime_error("Tensor selection cannot be empty"); }
    if (value.contains("logitVectorSteps")) {
        if (!value.at("logitVectorSteps").is_number_unsigned()) { throw std::runtime_error("logitVectorSteps must be unsigned"); }
        result.logit_vector_steps = value.at("logitVectorSteps").get<uint64_t>();
    }
    if (result.logit_vector_steps > 64) { throw std::runtime_error("logitVectorSteps exceeds 64"); }
    result.effective = value;
    result.effective["logitVectorSteps"] = result.logit_vector_steps;
    result.effective["maxTensorBytes"] = MAX_TENSOR_BYTES;
    result.effective["budgetScope"] = "all recorder files in one process";
    return result;
}

struct file_sink {
    HANDLE handle = INVALID_HANDLE_VALUE;
    fs::path path;
    uint64_t sequence = 0;
    ~file_sink() { if (handle != INVALID_HANDLE_VALUE) { CloseHandle(handle); } }
    explicit file_sink(const fs::path & name) : path(name) {
        handle = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (handle == INVALID_HANDLE_VALUE) { throw std::runtime_error("Cannot exclusively create trace file: " + path_utf8(path)); }
    }
    void write(const void * data, size_t size) {
        size_t offset = 0;
        while (offset < size) {
            const DWORD count = static_cast<DWORD>(std::min<size_t>(size-offset, 1024*1024));
            DWORD written = 0;
            if (!WriteFile(handle, static_cast<const uint8_t *>(data)+offset, count, &written, nullptr) || written != count) {
                throw std::runtime_error("Trace file short/failed write");
            }
            offset += written;
        }
    }
    void flush() { if (!FlushFileBuffers(handle)) { throw std::runtime_error("Trace file flush failed"); } }
};

struct task_state { bool terminal = false; uint64_t accepted = 0; uint64_t samples = 0; };
struct context_state {
    std::string id;
    std::shared_ptr<file_sink> file;
    json startup;
    json last_batch_rows;
    uint64_t batches = 0, microbatches = 0, samples = 0, accepted = 0, tensors = 0;
    uint64_t empty_tensors = 0, backend_reads = 0;
    bool published = false;
    uint32_t layers = 0;
    uint32_t mtp_layers = 0;
    int64_t embedding_size = 0;
    std::string architecture;
    std::map<int, task_state> tasks;
};
struct request_state { std::string id; std::string body_hash; };

struct recorder {
    config settings;
    std::string raw_config, config_sha, config_path, config_source;
    DWORD pid = GetCurrentProcessId();
    std::string started_at = process_start(), id = unique_id(), prefix;
    std::shared_ptr<file_sink> process_file;
    std::recursive_mutex mutex;
    std::map<llama_context *, std::shared_ptr<context_state>> contexts;
    std::map<llama_memory_t, llama_context *> memories;
    std::map<const void *, request_state> requests;
    uint64_t bytes = 0, sequence = 0, dropped = 0;
    std::atomic<bool> failed{false};
    bool finished = false;
    std::string failure;

    recorder(config cfg, std::string raw, std::string path, std::string source)
        : settings(std::move(cfg)), raw_config(std::move(raw)), config_path(std::move(path)), config_source(std::move(source)) {
        config_sha = sha256(raw_config.data(), raw_config.size());
        prefix = std::to_string(pid) + "-" + id;
        if (settings.enabled) {
            fs::create_directories(settings.output);
            process_file = std::make_shared<file_sink>(settings.output / (prefix + ".process.jsonl"));
            record(process_file, "process_start", {{"executablePath", path_utf8(executable_path())},
                   {"sourceCommit", "b1b770d90d94cad9e9ea5b993bdbc383a522fb28"}, {"compiler", __VERSION__},
                   {"configSource", config_source}, {"configPath", config_path}, {"configSha256", config_sha},
                   {"configBytesUtf8", raw_config}, {"effectiveConfig", settings.effective}}, true);
        }
    }

    void fail(const std::string & why) noexcept {
        std::lock_guard<std::recursive_mutex> guard(mutex);
        ++dropped;
        if (failed) { return; }
        failed = true; failure = why.substr(0, 512);
        std::fprintf(stderr, "BLACKICE_TRACE_INVALID: %s\n", failure.c_str());
        try {
            const json marker = {{"schema", "blackice.minicpm.trace-invalid.v1"}, {"pid", pid}, {"processId", id},
                                 {"processStartedAt", started_at}, {"at", now()}, {"complete", false},
                                 {"reason", failure}, {"bytesBeforeFailure", bytes}, {"droppedEvents", dropped}};
            const std::string payload = marker.dump() + "\n";
            if (payload.size() > ERROR_RESERVE) { return; }
            file_sink error(settings.output / (prefix + ".invalid.json"));
            error.write(payload.data(), payload.size()); error.flush();
        } catch (...) { /* Missing terminal and stderr still invalidate the trace if the disk is unavailable. */ }
    }

    bool account(size_t count) {
        if (failed) { ++dropped; return false; }
        if (count > settings.max_bytes - ERROR_RESERVE || bytes > settings.max_bytes - ERROR_RESERVE - count) {
            fail("Trace byte budget exceeded; capture is incomplete"); return false;
        }
        bytes += count;
        return true;
    }

    void record(const std::shared_ptr<file_sink> & file, const std::string & type, json payload, bool flush = false) {
        std::lock_guard<std::recursive_mutex> guard(mutex);
        if (!file || failed) { if (failed) { ++dropped; } return; }
        try {
            json entry = {{"schema", "blackice.minicpm.live-trace.v1"}, {"event", type}, {"at", now()},
                          {"pid", pid}, {"processId", id}, {"processStartedAt", started_at},
                          {"processSequence", ++sequence}, {"fileSequence", ++file->sequence}, {"data", std::move(payload)}};
            const std::string line = entry.dump() + "\n";
            if (!account(line.size())) { return; }
            file->write(line.data(), line.size());
            if (flush) { file->flush(); }
        } catch (const std::exception & error) { fail(error.what()); }
    }

    json artifact(const std::string & name, const void * data, size_t count) {
        if (!account(count)) { return nullptr; }
        try {
            const fs::path path = settings.output / name;
            file_sink output(path); output.write(data, count); output.flush();
            return {{"path", path_utf8(path)}, {"bytes", count}, {"sha256", sha256(data, count)}};
        } catch (const std::exception & error) { fail(error.what()); return nullptr; }
    }

    std::shared_ptr<context_state> context(llama_context * ctx) {
        const auto found = contexts.find(ctx);
        if (found == contexts.end()) { throw std::runtime_error("Unregistered live context"); }
        return found->second;
    }
};

std::unique_ptr<recorder> active;
struct micro_state {
    llama_context * ctx = nullptr;
    std::shared_ptr<context_state> state;
    uint64_t batch = 0, microbatch = 0;
    json rows;
    std::vector<uint32_t> output_rows;
    std::map<std::string, unsigned> observed;
    std::map<std::string, unsigned> measured, empty;
    int graph_type = -1;
    uint32_t position_sections = 0;
    bool mapping_known = false, mask_observed = false;
};
thread_local std::unique_ptr<micro_state> current_micro;
thread_local uint64_t current_batch = 0;

std::string lower(std::string value) {
    for (auto & c : value) { c = static_cast<char>(std::tolower(static_cast<unsigned char>(c))); }
    return value;
}

json stats(const float * values, size_t count) {
    uint64_t finite = 0, zeros = 0, nan = 0, positive_inf = 0, negative_inf = 0;
    long double square_sum = 0, sum = 0;
    double max_abs = 0;
    for (size_t i = 0; i < count; ++i) {
        const double value = values[i];
        if (std::isnan(value)) { ++nan; }
        else if (std::isinf(value)) { value > 0 ? ++positive_inf : ++negative_inf; }
        else {
            ++finite; zeros += value == 0; sum += value; square_sum += static_cast<long double>(value)*value;
            max_abs = std::max(max_abs, std::abs(value));
        }
    }
    json result = {{"elements", count}, {"finite", finite}, {"zero", zeros}, {"nan", nan},
                   {"positiveInfinity", positive_inf}, {"negativeInfinity", negative_inf}};
    result["finiteMean"] = finite ? json(static_cast<double>(sum/finite)) : json(nullptr);
    result["finiteRms"] = finite ? json(std::sqrt(static_cast<double>(square_sum/finite))) : json(nullptr);
    result["finiteMaxAbs"] = finite ? json(max_abs) : json(nullptr);
    return result;
}

bool selected_name(const std::string & name, std::string & anchor, uint32_t & layer) {
    if (!active) { return false; }
    for (const auto & candidate : active->settings.anchors) {
        const auto prefix = candidate + "-";
        if (name.compare(0, prefix.size(), prefix) != 0) { continue; }
        const auto suffix = name.substr(prefix.size());
        if (suffix.empty() || suffix.size() > 6 || !std::all_of(suffix.begin(), suffix.end(), [](char c) { return c >= '0' && c <= '9'; })) { return false; }
        anchor = candidate; layer = static_cast<uint32_t>(std::stoul(suffix)); return true;
    }
    return false;
}

std::vector<std::string> coverage_missing(const config & cfg, uint32_t layers, const std::map<std::string, unsigned> & observed) {
    std::vector<std::string> missing;
    for (uint32_t layer = 0; layer < layers; ++layer) {
        for (const auto & anchor : cfg.anchors) {
            const auto name = anchor + "-" + std::to_string(layer);
            const auto found = observed.find(name);
            if (found == observed.end() || found->second != 1) { missing.push_back(name); }
        }
    }
    return missing;
}

bool supported_empty_output(const ggml_tensor * tensor, const micro_state & micro,
                            const std::string & anchor, uint32_t layer) {
    const auto & state = *micro.state;
    if (state.architecture != "qwen35" || state.mtp_layers != 0 || state.layers == 0 ||
        layer != state.layers - 1 || micro.graph_type != LLM_GRAPH_TYPE_DEFAULT ||
        !state.published || micro.batch == 0 || micro.batch != state.batches ||
        !micro.mapping_known || !micro.mask_observed || micro.rows.empty() ||
        !micro.output_rows.empty() ||
        (anchor != "attn_post_norm" && anchor != "ffn_out" && anchor != "l_out")) { return false; }
    if (tensor->type != GGML_TYPE_F32 || state.embedding_size <= 0 ||
        tensor->ne[0] != state.embedding_size || tensor->ne[1] != 0 ||
        tensor->ne[2] != 1 || tensor->ne[3] != 1 ||
        tensor->nb[0] != sizeof(float) || tensor->nb[1] != size_t(state.embedding_size)*sizeof(float) ||
        tensor->nb[2] != 0 || tensor->nb[3] != 0 || ggml_nbytes(tensor) != 0) { return false; }
    // The observed all-false native mask must agree with the exact server batch,
    // including token, position and owning sequence. Missing mask is not false.
    std::set<uint32_t> seen;
    for (const auto & row : micro.rows) {
        if (!row.at("output").is_boolean() || row.at("output").get<bool>() ||
            !row.at("batchRow").is_number_integer() || row.at("batchRow").get<int64_t>() < 0 ||
            row.at("batchRow").get<int64_t>() > UINT32_MAX || row.at("inputKind") != "token") { return false; }
        const auto index = row.at("batchRow").get<uint32_t>();
        if (!seen.insert(index).second || index >= state.last_batch_rows.size()) { return false; }
        const auto & source = state.last_batch_rows.at(index);
        if (source.at("batchRow") != index || source.at("tokenId") != row.at("tokenId") ||
            !source.at("output").is_boolean() || source.at("output").get<bool>() ||
            source.at("taskId").get<int>() < 0 || source.at("embeddingRow").get<int>() >= 0) { return false; }
        if (!text_position_row_matches(source, row, micro.position_sections)) { return false; }
        const auto & sequences = row.at("sequenceIds");
        if (std::find(sequences.begin(), sequences.end(), source.at("slotId")) == sequences.end()) { return false; }
    }
    return true;
}

void end_micro(int status) noexcept {
    if (!current_micro || !active) { return; }
    try {
        std::lock_guard<std::recursive_mutex> guard(active->mutex);
        auto & micro = *current_micro;
        const auto missing = active->settings.activation_capture && status == GGML_STATUS_SUCCESS ? coverage_missing(active->settings, micro.state->layers, micro.observed) : std::vector<std::string>{};
        active->record(micro.state->file, "microbatch_end", {{"startupId", micro.state->id}, {"batchId", micro.batch},
                       {"microbatchId", micro.microbatch}, {"graphStatus", status}, {"activationCaptureEnabled", active->settings.activation_capture},
                       {"observedTensors", micro.observed}, {"missingOrDuplicateTensors", missing},
                       {"measuredTensors", micro.measured}, {"emptyTensors", micro.empty},
                       {"complete", status == GGML_STATUS_SUCCESS && missing.empty() && !active->failed}});
        if (!missing.empty()) { active->fail("Selected tensor coverage is missing or duplicated"); }
    } catch (const std::exception & error) { active->fail(error.what()); }
    current_micro.reset();
}
} // namespace

void initialize_process() {
    if (active) { throw std::runtime_error("Trace process initialized twice"); }
    fs::path path = executable_path().parent_path() / "blackice-trace.json";
    std::string source = "executable-sidecar";
    if (const wchar_t * override_path = _wgetenv(L"BLACKICE_TRACE_CONFIG")) {
        if (!*override_path) { throw std::runtime_error("Empty explicit BLACKICE_TRACE_CONFIG override"); }
        path = fs::path(override_path);
        if (!path.is_absolute()) { throw std::runtime_error("BLACKICE_TRACE_CONFIG must be absolute"); }
        source = "explicit-environment-override";
    } else if (!fs::exists(path)) {
        return; // Absent sidecar is the explicit all-recording-off mode.
    }
    const auto bytes = read_bytes(path, 1024*1024);
    active = std::make_unique<recorder>(parse_config(bytes), bytes, path_utf8(path), source);
    if (active->failed) { throw std::runtime_error(active->failure); }
    if (std::atexit([]() {
        if (!enabled()) { return; }
        std::lock_guard<std::recursive_mutex> guard(active->mutex);
        if (active->finished) { return; }
        // Upstream argument handlers call exit(). Its actual status is only observable by the parent.
        active->record(active->process_file, "process_exit_without_main_return", {{"exitCode",nullptr},
                       {"openContexts",active->contexts.size()},{"openHttpRequests",active->requests.size()},
                       {"droppedEvents",active->dropped},{"complete",false},
                       {"reason","Exit bypassed main return; host exit observation is required"}},true);
        active->finished = true;
    }) != 0) { throw std::runtime_error("Cannot register trace exit handler"); }
}

bool enabled() { return active && active->settings.enabled; }
bool capture_enabled() { return enabled() && active->settings.activation_capture; }
bool healthy() { return !enabled() || !active->failed; }
void invalidate(const std::string & reason) noexcept { if (enabled()) { active->fail(reason); } }

void finish_process(int exit_code) {
    if (!enabled()) { return; }
    std::lock_guard<std::recursive_mutex> guard(active->mutex);
    if (active->finished) { return; }
    active->record(active->process_file, "process_end", {{"exitCode", exit_code}, {"openContexts", active->contexts.size()},
                   {"openHttpRequests", active->requests.size()}, {"droppedEvents", active->dropped},
                   {"complete", exit_code == 0 && active->contexts.empty() && active->requests.empty() && !active->failed}}, true);
    active->finished = true;
}

void context_created(llama_context * ctx) {
    if (!enabled() || ctx->get_model().no_alloc()) { return; }
    std::lock_guard<std::recursive_mutex> guard(active->mutex);
    if (active->contexts.count(ctx)) { throw std::runtime_error("Duplicate context registration"); }
    auto state = std::make_shared<context_state>();
    state->id = unique_id(); state->layers = ctx->get_model().hparams.n_layer_all;
    state->architecture = llm_arch_name(ctx->get_model().arch);
    state->mtp_layers = ctx->get_model().hparams.n_layer_nextn;
    state->embedding_size = ctx->get_model().hparams.n_embd;
    state->file = std::make_shared<file_sink>(active->settings.output / (active->prefix + ".ctx-" + state->id + ".jsonl"));
    active->contexts.emplace(ctx, state);
    if (ctx->get_memory()) { active->memories.emplace(ctx->get_memory(), ctx); }
    active->record(state->file, "context_start", {{"startupId", state->id}, {"layers", state->layers},
                   {"modelArchitecture", state->architecture}, {"modelLayerCount", state->layers},
                   {"modelMtpLayerCount", state->mtp_layers}, {"modelEmbeddingSize", state->embedding_size},
                   {"configSha256", active->config_sha}, {"configBytesUtf8", active->raw_config},
                   {"effectiveConfig", active->settings.effective}}, true);
    if (active->failed) { throw std::runtime_error(active->failure); }
}

std::string startup(llama_context * ctx, const std::string & server_metadata) {
    if (!enabled()) { return "null"; }
    std::lock_guard<std::recursive_mutex> guard(active->mutex);
    auto state = active->context(ctx);
    if (state->published) { return state->startup.dump(); }
    const json meta = json::parse(server_metadata);
    const auto & model = ctx->get_model();
    const auto & cp = ctx->get_cparams();
    json runtime = {{"ctxSize", llama_n_ctx_seq(ctx)}, {"parallel", meta.at("parallel")},
                    {"threads", llama_n_threads(ctx)}, {"threadsBatch", llama_n_threads_batch(ctx)},
                    {"batch", llama_n_batch(ctx)}, {"ubatch", llama_n_ubatch(ctx)},
                    {"flashAttention", cp.flash_attn}, {"cacheK", nullptr}, {"cacheV", nullptr}, {"gpuLayers", nullptr}};
    json sources;
    for (const auto & field : std::vector<std::pair<std::string,std::string>>{{"ctxSize","llama_n_ctx_seq(ctx)"}, {"threads","llama_n_threads(ctx)"},
           {"threadsBatch","llama_n_threads_batch(ctx)"}, {"batch","llama_n_batch(ctx)"}, {"ubatch","llama_n_ubatch(ctx)"}}) {
        sources[field.first] = {{"kind","runtime-getter"},{"detail",field.second}};
    }
    sources["parallel"] = {{"kind","runtime-internal"},{"detail","server_context_impl::slots.size() after initialization"}};
    sources["flashAttention"] = {{"kind","runtime-internal"},{"detail","llama_context::get_cparams().flash_attn after sched_reserve resolution"}};
    llama_kv_cache * kv = dynamic_cast<llama_kv_cache *>(ctx->get_memory());
    std::string memory_source = "llama_kv_cache";
    if (auto * hybrid = dynamic_cast<llama_memory_hybrid *>(ctx->get_memory())) {
        kv = hybrid->get_mem_attn(); memory_source = "llama_memory_hybrid::get_mem_attn()";
    }
    if (kv) {
        runtime["cacheK"] = ggml_type_name(kv->type_k()); runtime["cacheV"] = ggml_type_name(kv->type_v());
        sources["cacheK"] = {{"kind","runtime-getter"},{"detail",memory_source + "->type_k()"}};
        sources["cacheV"] = {{"kind","runtime-getter"},{"detail",memory_source + "->type_v()"}};
    }
    json placement = json::array();
    bool known_placement = true;
    uint32_t gpu_layers = 0;
    for (uint32_t index = 0; index <= model.hparams.n_layer_all; ++index) {
        const auto device = index == model.hparams.n_layer_all ? model.dev_output() : model.dev_layer(index);
        if (!device) { known_placement = false; placement.push_back(nullptr); continue; }
        const auto type = ggml_backend_dev_type(device);
        const bool gpu = type == GGML_BACKEND_DEVICE_TYPE_GPU || type == GGML_BACKEND_DEVICE_TYPE_IGPU;
        if (type == GGML_BACKEND_DEVICE_TYPE_META) { known_placement = false; }
        gpu_layers += gpu;
        placement.push_back({{"layer",index},{"role",index == model.hparams.n_layer_all ? "output" : "transformer"},
                             {"device",ggml_backend_dev_name(device)},{"type",static_cast<int>(type)},{"gpu",gpu}});
    }
    if (known_placement) {
        runtime["gpuLayers"] = gpu_layers;
        sources["gpuLayers"] = {{"kind","runtime-internal"},{"detail","Count of actual model.dev_layer(i)/dev_output() with GPU or IGPU device type; output layer included"}};
    }
    state->startup = {{"schema","blackice.minicpm.runtime-startup.v1"},{"id",state->id},{"startupId",state->id},
                      {"at",now()},{"pid",active->pid},{"processStartedAt",active->started_at},
                      {"modelId",meta.at("modelId")},{"modelPath",meta.at("modelPath")},{"build",meta.at("build")},
                      {"modelArchitecture",state->architecture},{"modelLayerCount",state->layers},
                      {"modelMtpLayerCount",state->mtp_layers},{"modelEmbeddingSize",state->embedding_size},
                      {"modelFieldSources", {
                          {"modelArchitecture",{{"kind","runtime-internal"},{"detail","llm_arch_name(ctx->get_model().arch)"}}},
                          {"modelLayerCount",{{"kind","runtime-internal"},{"detail","ctx->get_model().hparams.n_layer_all"}}},
                          {"modelMtpLayerCount",{{"kind","runtime-internal"},{"detail","ctx->get_model().hparams.n_layer_nextn"}}},
                          {"modelEmbeddingSize",{{"kind","runtime-internal"},{"detail","ctx->get_model().hparams.n_embd"}}},
                      }},
                      {"runtime",runtime},{"fieldSources",sources},{"totalContextSize",llama_n_ctx(ctx)},
                      {"projector",meta.at("projector")},{"layerPlacement",placement},
                      {"configSha256",active->config_sha},{"traceFile",path_utf8(state->file->path)},
                      {"droppedEvents",active->dropped},{"complete",kv != nullptr && known_placement && !active->failed}};
    const auto bytes = state->startup.dump(2) + "\n";
    const auto receipt = active->artifact(active->prefix + ".ctx-" + state->id + ".startup.json", bytes.data(), bytes.size());
    active->record(state->file, "runtime_startup", {{"startupId",state->id},{"receipt",receipt},{"runtime",state->startup}}, true);
    state->published = true;
    if (active->failed) { throw std::runtime_error(active->failure); }
    return state->startup.dump();
}

void event(llama_context * ctx, const char * name, const std::string & payload) {
    if (!enabled()) { return; }
    std::lock_guard<std::recursive_mutex> guard(active->mutex);
    auto state = active->context(ctx); auto data = json::parse(payload); data["startupId"] = state->id;
    active->record(state->file, name, data);
}

void task_registered(llama_context * ctx, const std::string & payload) {
    if (!enabled()) { return; }
    std::lock_guard<std::recursive_mutex> guard(active->mutex);
    auto state = active->context(ctx); auto data = json::parse(payload); const int id = data.at("taskId");
    try { require_current_runtime_capture(!active->failed, state->published); }
    catch (...) {
        if (!active->failed) { active->fail("Task registered before current runtime startup publication"); }
        throw;
    }
    if (!state->tasks.emplace(id, task_state{}).second) { active->fail("Duplicate native task ID"); }
    data["startupId"] = state->id; active->record(state->file, "task_registered", data, true);
    if (data.at("serverRequestId").get<std::string>().empty()) { active->fail("Task lacks observed HTTP request binding"); }
}

void task_terminal(llama_context * ctx, int task_id, const char * outcome, const std::string & payload) {
    if (!enabled()) { return; }
    std::lock_guard<std::recursive_mutex> guard(active->mutex);
    auto state = active->context(ctx); auto & task = state->tasks[task_id];
    auto data = json::parse(payload); data["startupId"] = state->id; data["taskId"] = task_id; data["outcome"] = outcome;
    data["sampleLogitEvents"] = task.samples; data["acceptedTokenEvents"] = task.accepted;
    data["traceComplete"] = !active->failed && task.samples == task.accepted && !task.terminal;
    data["droppedEvents"] = active->dropped;
    active->record(state->file, "task_terminal", data, true); task.terminal = true;
    if (task.samples != task.accepted) { active->fail("Sample/logit and accepted token coverage differ"); }
}

void task_released(llama_context * ctx, int task_id, int slot_id) {
    if (!enabled()) { return; }
    std::lock_guard<std::recursive_mutex> guard(active->mutex);
    auto state = active->context(ctx); const auto found = state->tasks.find(task_id);
    active->record(state->file, "slot_release", {{"startupId",state->id},{"taskId",task_id},{"slotId",slot_id},
                   {"hadTaskTerminal",found != state->tasks.end() && found->second.terminal}}, true);
    if (found == state->tasks.end() || !found->second.terminal) { active->fail("Slot released without a recorded task terminal; cancellation or unsupported path"); }
}

void context_destroyed(llama_context * ctx) {
    if (!enabled()) { return; }
    std::lock_guard<std::recursive_mutex> guard(active->mutex);
    const auto found = active->contexts.find(ctx); if (found == active->contexts.end()) { return; }
    auto state = found->second;
    bool tasks_closed = true; for (const auto & task : state->tasks) { tasks_closed &= task.second.terminal; }
    active->record(state->file, "context_end", {{"startupId",state->id},{"batches",state->batches},{"microbatches",state->microbatches},
                   {"sampleLogitEvents",state->samples},{"acceptedTokenEvents",state->accepted},{"tensorEvents",state->tensors},
                   {"emptyTensorEvents",state->empty_tensors},{"tensorBackendReadCalls",state->backend_reads},
                   {"droppedEvents",active->dropped},{"complete",tasks_closed && !active->failed}}, true);
    active->memories.erase(ctx->get_memory()); active->contexts.erase(found);
}

std::string header_value(const std::map<std::string,std::string> & headers, const std::string & key) {
    std::string result; bool found = false;
    for (const auto & item : headers) {
        if (lower(item.first) == lower(key)) {
            if (found) { throw std::runtime_error("Duplicate case-insensitive correlation header"); }
            result = item.second; found = true;
        }
    }
    return result;
}

std::string http_begin(const void * native_request, const std::string & method, const std::string & path,
                       const std::string & body, const std::map<std::string,std::string> & headers, bool body_observed) {
    if (!enabled() || method != "POST" || (path.find("completion") == std::string::npos && header_value(headers,"X-Blackice-Attempt-Id").empty())) { return ""; }
    std::lock_guard<std::recursive_mutex> guard(active->mutex);
    const auto prior = active->requests.find(native_request); if (prior != active->requests.end()) { return prior->second.id; }
    const std::string id = unique_id(), hash = body_observed ? sha256(body.data(),body.size()) : "";
    const auto exchange = header_value(headers,"X-Blackice-Exchange-Id");
    const auto attempt = header_value(headers,"X-Blackice-Attempt-Id");
    const auto expected = header_value(headers,"X-Blackice-Request-Sha256");
    const bool bound = body_observed && !exchange.empty() && !attempt.empty() && expected == hash;
    const bool any_binding = !exchange.empty() || !attempt.empty() || !expected.empty();
    active->requests.emplace(native_request, request_state{id,hash});
    const auto artifact = body_observed ? active->artifact(active->prefix + ".request-" + id + ".body.bin",body.data(),body.size()) : json(nullptr);
    active->record(active->process_file,"http_request",{{"serverRequestId",id},{"method",method},{"path",path},
                   {"body",artifact},{"bodySha256",body_observed ? json(hash) : json(nullptr)},
                   {"bodyBytes",body_observed ? json(body.size()) : json(nullptr)},{"bodyObserved",body_observed},
                   {"exchangeId",exchange},{"attemptId",attempt},{"hostRequestSha256",expected},
                   {"parentServerRequestId",header_value(headers,"X-Blackice-Router-Request-Id")},
                   {"binding",bound ? "host-headers-and-body-hash" : any_binding ? (body_observed ? "invalid-host-binding" : "host-headers-only-body-unobserved") : "unbound"}},true);
    if (body_observed && any_binding && !bound) { active->fail("Host request SHA or correlation headers mismatch"); }
    if (active->failed) { throw std::runtime_error(active->failure); }
    return id;
}

void http_finish(const void * native_request, int status) {
    if (!enabled()) { return; }
    std::lock_guard<std::recursive_mutex> guard(active->mutex);
    const auto found = active->requests.find(native_request); if (found == active->requests.end()) { return; }
    active->record(active->process_file,"http_response_observed",{{"serverRequestId",found->second.id},{"status",status},
                   {"meaning","httplib prepared response metadata before header/body writes; this does not prove transport, client receipt or semantic completion"}},true);
    active->requests.erase(found);
}

void http_generator_end(const std::string & request_id, int status, bool raw_releaser_success, bool streaming,
                        bool producer_exhausted, bool sink_done_called, bool chunk_write_failed) {
    if (!enabled() || request_id.empty()) { return; }
    const bool complete = raw_releaser_success && !active->failed &&
                          (!streaming || (producer_exhausted && sink_done_called && !chunk_write_failed));
    active->record(active->process_file,"http_generator_end",{{"serverRequestId",request_id},{"status",status},
                   {"streaming",streaming},{"transportProviderSuccess",streaming ? json(raw_releaser_success) : json(nullptr)},
                   {"producerExhausted",streaming ? json(producer_exhausted) : json(nullptr)},
                   {"sinkDoneCalled",streaming ? json(sink_done_called) : json(nullptr)},
                   {"chunkWriteFailed",streaming ? json(chunk_write_failed) : json(nullptr)},
                   {"complete",complete},
                   {"scope",streaming ? "Observed producer exhaustion, done invocation and raw httplib resource-releaser outcome; client receipt and semantic success require independent host evidence"
                                      : "Nonstream response content prepared; transport and client receipt are not observed by this generator hook"}},true);
}

void batch_begin(llama_context * ctx, const std::string & rows) {
    if (!enabled()) { return; }
    std::lock_guard<std::recursive_mutex> guard(active->mutex); auto state = active->context(ctx);
    if (current_batch != 0) { active->fail("Nested server batch"); }
    current_batch = ++state->batches; state->last_batch_rows = json::parse(rows);
    active->record(state->file,"server_batch_begin",{{"startupId",state->id},{"batchId",current_batch},{"rows",state->last_batch_rows}});
}

void batch_end(llama_context * ctx, int result) {
    if (!enabled()) { return; }
    std::lock_guard<std::recursive_mutex> guard(active->mutex); auto state = active->context(ctx);
    active->record(state->file,"server_batch_end",{{"startupId",state->id},{"batchId",current_batch},{"result",result},{"complete",result == 0 && !active->failed}});
    current_batch = 0;
}

ubatch_guard::ubatch_guard(llama_context * ctx, const llama_ubatch & batch, int graph_type) {
    if (!enabled() || ctx->get_model().no_alloc()) { return; }
    std::lock_guard<std::recursive_mutex> guard(blackice_trace::active->mutex);
    if (current_micro) { blackice_trace::active->fail("Nested core microbatch"); return; }
    auto state = blackice_trace::active->context(ctx);
    current_micro = std::make_unique<micro_state>();
    auto & micro = *current_micro; micro.ctx = ctx; micro.state = state; micro.batch = current_batch; micro.microbatch = ++state->microbatches;
    micro.graph_type = graph_type; micro.mask_observed = batch.output != nullptr;
    micro.position_sections = batch.n_pos;
    micro.rows = json::array();
    bool mapping_known = batch.data && batch.data->batch_idxs.size() == batch.n_tokens;
    for (uint32_t i = 0; i < batch.n_tokens; ++i) {
        json position = json::array(), sequences = json::array();
        for (uint32_t section = 0; section < batch.n_pos; ++section) { position.push_back(batch.pos ? json(batch.pos[i + section*batch.n_tokens]) : json(nullptr)); }
        if (batch.n_seq_id && batch.seq_id) { for (int j = 0; j < batch.n_seq_id[i]; ++j) { sequences.push_back(batch.seq_id[i][j]); } }
        else { mapping_known = false; }
        const bool is_embedding = (batch.type && batch.type[i] != 0) || !batch.token;
        json row = {{"microRow",i},{"batchRow",mapping_known ? json(batch.data->batch_idxs[i]) : json(nullptr)},
                    {"tokenId",is_embedding ? json(nullptr) : json(batch.token[i])},{"inputKind",is_embedding ? "embedding" : "token"},
                    {"positions",position},{"sequenceIds",sequences},{"output",batch.output ? bool(batch.output[i]) : false}};
        micro.rows.push_back(row);
        if (batch.output && batch.output[i]) { micro.output_rows.push_back(i); }
    }
    micro.mapping_known = mapping_known;
    blackice_trace::active->record(state->file,"microbatch_begin",{{"startupId",state->id},{"batchId",micro.batch},{"microbatchId",micro.microbatch},
        {"phase",state->published ? "request" : "initialization"},{"graphType",graph_type},{"nTokens",batch.n_tokens},
        {"nSequences",batch.n_seqs},{"nPositionSections",batch.n_pos},{"sourceMappingComplete",mapping_known},
        {"outputMaskObserved",micro.mask_observed},{"rows",micro.rows}});
    if (!mapping_known) { blackice_trace::active->fail("Microbatch original-index/sequence correspondence unavailable"); }
    active = true;
}

ubatch_guard::~ubatch_guard() { if (active) { end_micro(GGML_STATUS_FAILED); } }
void ubatch_guard::complete(int status) { if (active) { end_micro(status); active = false; } }

bool eval_callback(ggml_tensor * tensor, bool ask, void *) {
    if (!capture_enabled()) { return ask ? false : true; }
    try {
        std::string anchor; uint32_t layer = 0;
        const std::string name = ggml_get_name(tensor);
        const bool selected = selected_name(name,anchor,layer);
        if (ask) { return selected; }
        if (!selected) { return true; }
        std::lock_guard<std::recursive_mutex> guard(active->mutex);
        if (active->failed) { return false; }
        if (!current_micro) { active->fail("Selected tensor callback outside a core microbatch"); return false; }
        auto & micro = *current_micro;
        json meta = {{"startupId",micro.state->id},{"batchId",micro.batch},{"microbatchId",micro.microbatch},{"name",name},
                     {"anchor",anchor},{"layer",layer},{"type",ggml_type_name(tensor->type)},
                     {"shape",{tensor->ne[0],tensor->ne[1],tensor->ne[2],tensor->ne[3]}},
                     {"strides",{tensor->nb[0],tensor->nb[1],tensor->nb[2],tensor->nb[3]}}};
        const auto bytes = ggml_nbytes(tensor);
        if (bytes == 0 && supported_empty_output(tensor,micro,anchor,layer)) {
            meta["bytes"] = 0; meta["elementCount"] = 0; meta["phase"] = "request";
            meta["modelArchitecture"] = micro.state->architecture; meta["modelLayerCount"] = micro.state->layers;
            meta["modelMtpLayerCount"] = micro.state->mtp_layers; meta["modelEmbeddingSize"] = micro.state->embedding_size;
            meta["graphType"] = micro.graph_type; meta["disposition"] = "output-mask-empty";
            meta["sourceMicrobatchRows"] = micro.rows.size(); meta["sourceOutputRows"] = 0;
            meta["sourceOutputMaskObserved"] = true; meta["sourceMappingComplete"] = true;
            meta["complete"] = true;
            ++micro.observed[name]; ++micro.empty[name]; ++micro.state->empty_tensors;
            active->record(micro.state->file,"tensor_empty",meta);
            return !active->failed;
        }
        if (tensor->type != GGML_TYPE_F32 || !ggml_is_contiguous(tensor) || tensor->ne[0] <= 0 || tensor->ne[1] <= 0 ||
            tensor->ne[2] != 1 || tensor->ne[3] != 1 || bytes > MAX_TENSOR_BYTES || bytes != uint64_t(tensor->ne[0])*uint64_t(tensor->ne[1])*sizeof(float)) {
            meta["complete"] = false; meta["reason"] = "Unsupported tensor type/layout/size";
            active->record(micro.state->file,"tensor_rejected",meta); active->fail("Selected tensor has unsupported type/layout/size"); return false;
        }
        const size_t columns = static_cast<size_t>(tensor->ne[1]);
        std::vector<uint32_t> rows;
        if (columns == micro.rows.size()) { for (uint32_t i = 0; i < columns; ++i) { rows.push_back(i); } }
        else if (columns == micro.output_rows.size()) { rows = micro.output_rows; }
        else { active->fail("Selected tensor columns cannot be mapped to actual microbatch rows"); return false; }
        std::vector<float> values(bytes/sizeof(float));
        ++micro.state->backend_reads;
        ggml_backend_tensor_get(tensor,values.data(),0,bytes);
        json summaries = json::array();
        const size_t width = static_cast<size_t>(tensor->ne[0]);
        for (size_t column = 0; column < columns; ++column) {
            auto summary = stats(values.data()+column*width,width); summary["microRow"] = rows[column]; summaries.push_back(summary);
        }
        meta["bytes"] = bytes; meta["rawFloat32Sha256"] = sha256(values.data(),bytes); meta["perToken"] = summaries;
        meta["coverage"] = "every element in selected float32 tensor contributes to per-token statistics; individual neuron values are not stored";
        meta["complete"] = true;
        ++micro.observed[name]; ++micro.measured[name]; ++micro.state->tensors;
        active->record(micro.state->file,"tensor_statistics",meta);
        return !active->failed;
    } catch (const std::exception & error) { active->fail(error.what()); return false; }
}

void sample_logits(llama_context * ctx, int task_id, int slot_id, int batch_row, llama_token token) {
    if (!enabled()) { return; }
    std::lock_guard<std::recursive_mutex> guard(active->mutex); auto state = active->context(ctx);
    const uint64_t sample_id = ++state->samples; ++state->tasks[task_id].samples;
    json data = {{"startupId",state->id},{"sampleId",sample_id},{"taskId",task_id},{"slotId",slot_id},
                 {"batchId",state->batches},{"batchRow",batch_row},{"sampledTokenId",token}};
    const int n_vocab = ctx->get_model().vocab.n_tokens();
    const float * logits = llama_get_logits_ith(ctx,batch_row);
    if (!logits || n_vocab <= 0) { data["logitsAvailable"] = false; active->record(state->file,"sample_logits",data); active->fail("Full raw logits unavailable for a sampled token"); return; }
    const size_t bytes = size_t(n_vocab)*sizeof(float);
    data["logitsAvailable"] = true; data["vocabularySize"] = n_vocab; data["rawFloat32Sha256"] = sha256(logits,bytes);
    data["statistics"] = stats(logits,n_vocab);
    if (token >= 0 && token < n_vocab && std::isfinite(logits[token])) { data["selectedRawLogit"] = logits[token]; }
    else { data["selectedRawLogit"] = nullptr; }
    if (sample_id <= active->settings.logit_vector_steps) {
        data["rawFloat32Vector"] = active->artifact(active->prefix + ".ctx-" + state->id + ".sample-" + std::to_string(sample_id) + ".f32",logits,bytes);
        data["vectorEncoding"] = "IEEE754 float32 little-endian, vocabulary token ID order";
    }
    active->record(state->file,"sample_logits",data);
}

void accepted_token(llama_context * ctx, int task_id, int slot_id, llama_token token) {
    if (!enabled()) { return; }
    std::lock_guard<std::recursive_mutex> guard(active->mutex); auto state = active->context(ctx);
    ++state->accepted; ++state->tasks[task_id].accepted;
    active->record(state->file,"accepted_token",{{"startupId",state->id},{"taskId",task_id},{"slotId",slot_id},
                   {"ordinal",state->tasks[task_id].accepted},{"tokenId",token},
                   {"meaning","Token passed to server process_token; terminal tokens need not appear in any later decode batch"}});
}

void memory_event(llama_memory_t memory, const char * operation, int seq_id, int seq_dst, int64_t p0, int64_t p1, int64_t delta, bool result) {
    if (!enabled()) { return; }
    std::lock_guard<std::recursive_mutex> guard(active->mutex);
    const auto owner = active->memories.find(memory); if (owner == active->memories.end()) { return; }
    auto state = active->context(owner->second);
    active->record(state->file,"memory_operation",{{"startupId",state->id},{"operation",operation},{"sequenceId",seq_id},
                   {"destinationSequenceId",seq_dst},{"p0",p0},{"p1",p1},{"delta",delta},{"result",result},
                   {"meaning","Actual public llama memory operation on this context; recurrent and KV storage are both affected where implemented"}});
}

void state_event(llama_context * ctx, const char * operation, int seq_id, uint32_t flags, const uint8_t * data, size_t requested, size_t returned) {
    if (!enabled()) { return; }
    std::lock_guard<std::recursive_mutex> guard(active->mutex); auto state = active->context(ctx);
    const bool valid = data && returned > 0 && returned <= requested;
    active->record(state->file,"state_transfer",{{"startupId",state->id},{"operation",operation},{"sequenceId",seq_id},{"flags",flags},
                   {"requestedBytes",requested},{"returnedBytes",returned},{"sha256",valid ? json(sha256(data,returned)) : json(nullptr)},
                   {"complete",valid},{"meaning","Hash of actual saved/restored state bytes; state payload is not stored"}});
}

int self_test(const std::string & directory) {
    try {
        const fs::path root = fs::u8path(directory);
        if (!root.is_absolute() || fs::exists(root)) { throw std::runtime_error("Self-test needs a new absolute output directory"); }
        fs::create_directories(root);
        unsigned passed = 0;
        auto require = [&passed](bool condition,const char * name) { if (!condition) { throw std::runtime_error(name); } ++passed; };
        require(sha256("abc",3) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA256 known vector");
        const float values[] = {0,3,4,std::numeric_limits<float>::quiet_NaN(),std::numeric_limits<float>::infinity(),-std::numeric_limits<float>::infinity()};
        const auto summary = stats(values,6);
        require(summary.at("finite") == 3 && summary.at("zero") == 1 && summary.at("nan") == 1 && summary.at("positiveInfinity") == 1 && summary.at("negativeInfinity") == 1,"Nonfinite accounting");
        require(std::abs(summary.at("finiteRms").get<double>() - std::sqrt(25.0/3)) < 1e-12,"Finite RMS");
        json valid = {{"schema","blackice.minicpm.trace-config.v1"},{"enabled",true},{"activationCaptureEnabled",true},
                      {"outputDirectory",path_utf8(root)},{"maxBytes",uint64_t(65536)},{"tensorSelection",{"attn_norm","l_out"}},{"logitVectorSteps",uint64_t(2)}};
        const auto cfg = parse_config(valid.dump());
        require(cfg.enabled && cfg.activation_capture && cfg.logit_vector_steps == 2,"Valid config");
        auto rejects = [&require](json value,const char * name) { bool rejected = false; try { parse_config(value.dump()); } catch (...) { rejected = true; } require(rejected,name); };
        auto bad = valid; bad["unknown"] = 1; rejects(bad,"Unknown fields rejected");
        bad = valid; bad.erase("enabled"); rejects(bad,"Missing field rejected");
        bad = valid; bad["outputDirectory"] = "relative"; rejects(bad,"Relative path rejected");
        bad = valid; bad["maxBytes"] = 4096; rejects(bad,"Undersized budget rejected");
        bad = valid; bad["tensorSelection"] = {"attn_norm","attn_norm"}; rejects(bad,"Duplicate anchor rejected");
        bad = valid; bad["tensorSelection"] = {"unknown"}; rejects(bad,"Unknown anchor rejected");
        bad = valid; bad["logitVectorSteps"] = 65; rejects(bad,"Logit bound rejected");
        require(header_value({{"x-bLaCkIcE-aTtEmPt-Id","A"}},"X-Blackice-Attempt-Id") == "A","Header case");
        bool duplicate = false; try { header_value({{"X-A","1"},{"x-a","2"}},"x-a"); } catch (...) { duplicate = true; }
        require(duplicate,"Duplicate case header rejected");
        require(coverage_missing(cfg,1,{{"attn_norm-0",1},{"l_out-0",1}}).empty(),"Exact tensor coverage");
        require(coverage_missing(cfg,1,{{"attn_norm-0",2},{"l_out-0",1}}).size() == 1,"Duplicate tensor coverage");
        require(coverage_missing(cfg,2,{{"attn_norm-0",1},{"l_out-0",1}}).size() == 2,"Missing layer coverage");
        recorder trial(cfg,valid.dump(),"fixture","self-test");
        const auto sample = trial.artifact("exclusive.bin","abc",3);
        require(!sample.is_null() && sample.at("sha256") == sha256("abc",3),"Saved bytes hash");
        bool collision = false; try { file_sink again(root / "exclusive.bin"); } catch (...) { collision = true; }
        require(collision,"Exclusive creation");
        trial.record(trial.process_file,"oversized",{{"payload",std::string(65536,'x')}});
        require(trial.failed && trial.dropped > 0 && fs::exists(root / (trial.prefix + ".invalid.json")),"Overflow visibly invalidates");
        const json result = {{"schema","blackice.minicpm.trace-self-test.v1"},{"passed",passed},{"modelStarted",false},{"complete",true}};
        const std::string bytes = result.dump(2)+"\n"; file_sink output(root / "result.json"); output.write(bytes.data(),bytes.size()); output.flush();
        std::printf("%s\n",result.dump().c_str()); return 0;
    } catch (const std::exception & error) { std::fprintf(stderr,"Trace self-test failed: %s\n",error.what()); return 1; }
}
#include "blackice-empty-self-test.inc"
} // namespace blackice_trace
