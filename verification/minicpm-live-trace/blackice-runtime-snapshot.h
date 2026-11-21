#pragma once

#include "../vendor/nlohmann/json.hpp"
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>

namespace blackice_trace {

// The server uses common_json; the recorder uses ordered_json. Preserve JSON
// values explicitly instead of relying on either type's implicit constructors.
template<class To, class From>
inline To copy_runtime_properties_json(const From & value) {
    return To::parse(value.dump());
}

inline void require_current_runtime_capture(bool healthy, bool published) {
    if (!healthy || !published) {
        throw std::runtime_error("BLACKICE_TRACE_RUNTIME_UNAVAILABLE: current context capture is not ready");
    }
}

// The route's existing mutex_cache owns both publication and HTTP reads.
// A historical receipt is never exposed as the current sleeping/failed context.
class runtime_properties_snapshot {
public:
    using json = nlohmann::ordered_json;

    explicit runtime_properties_snapshot(std::mutex & mutex) : mutex_(mutex) {}

    template<class Factory>
    void initialize(Factory && factory) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ != state::empty) { unavailable("Duplicate initial runtime publication"); }
        publish(std::forward<Factory>(factory), false);
    }

    template<class CacheOtherResponses>
    void enter_sleep(CacheOtherResponses && cache_other_responses) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ != state::awake) { unavailable("Sleep requires an available awake runtime"); }
        try {
            json sleeping = properties_;
            sleeping["is_sleeping"] = true;
            sleeping["blackice_previous_runtime"] = runtime_;
            sleeping["blackice_runtime"] = nullptr;
            sleeping["blackice_runtime_state"] = "sleeping";
            cache_other_responses(sleeping);
            properties_ = std::move(sleeping);
            state_ = state::sleeping;
        } catch (...) {
            mark_unavailable();
            throw;
        }
    }

    template<class Factory>
    void leave_sleep(Factory && factory) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ != state::sleeping) { unavailable("Wake requires the explicit sleeping snapshot"); }
        publish(std::forward<Factory>(factory), true);
    }

    json read() const {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ != state::awake && state_ != state::sleeping) {
            throw std::runtime_error("BLACKICE_TRACE_RUNTIME_UNAVAILABLE: no current properties snapshot");
        }
        return properties_;
    }

private:
    enum class state { empty, awake, sleeping, unavailable };
    std::mutex & mutex_;
    state state_ = state::empty;
    json properties_;
    json runtime_;

    void mark_unavailable() noexcept {
        state_ = state::unavailable;
        properties_ = nullptr;
    }

    [[noreturn]] void unavailable(const char * reason) {
        mark_unavailable();
        throw std::runtime_error(std::string("BLACKICE_TRACE_RUNTIME_UNAVAILABLE: ") + reason);
    }

    static std::string context_id(const json & receipt) {
        if (!receipt.is_object() || receipt.value("schema", std::string()) != "blackice.minicpm.runtime-startup.v1" ||
            !receipt.contains("id") || !receipt.at("id").is_string() || receipt.at("id").get<std::string>().empty() ||
            !receipt.contains("startupId") || receipt.at("startupId") != receipt.at("id") ||
            !receipt.contains("complete") || receipt.at("complete") != true ||
            !receipt.contains("droppedEvents") || !receipt.at("droppedEvents").is_number_integer() || receipt.at("droppedEvents") != 0 ||
            !receipt.contains("pid") || !receipt.at("pid").is_number_integer() || receipt.at("pid").get<int64_t>() <= 0 ||
            !receipt.contains("processStartedAt") || !receipt.at("processStartedAt").is_string() ||
            receipt.at("processStartedAt").get<std::string>().empty()) {
            throw std::runtime_error("Incomplete or malformed native runtime receipt");
        }
        return receipt.at("id").get<std::string>();
    }

    template<class Factory>
    void publish(Factory && factory, bool waking) {
        try {
            json next = factory();
            if (!next.is_object() || !next.contains("is_sleeping") || next.at("is_sleeping") != false ||
                !next.contains("blackice_runtime")) {
                throw std::runtime_error("Awake properties and native runtime receipt are required");
            }
            // ordered_json can reallocate its object storage when state fields
            // are inserted below. Own this value before modifying that object.
            const json receipt = next.at("blackice_runtime");
            const auto id = context_id(receipt);
            if (waking && (id == context_id(runtime_) || receipt.at("pid") != runtime_.at("pid") ||
                           receipt.at("processStartedAt") != runtime_.at("processStartedAt"))) {
                throw std::runtime_error("Wake must publish a new context from the same actual process");
            }
            next.erase("blackice_previous_runtime");
            next["blackice_runtime_state"] = "awake";
            runtime_ = receipt;
            properties_ = std::move(next);
            state_ = state::awake;
        } catch (...) {
            mark_unavailable();
            throw;
        }
    }
};

} // namespace blackice_trace
