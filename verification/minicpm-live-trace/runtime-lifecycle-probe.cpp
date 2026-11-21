#include "blackice-runtime-snapshot.h"
#include "blackice-trace.h"
#include "server-queue.h"
#include "ggml.h"
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <future>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using snapshot = blackice_trace::runtime_properties_snapshot;
using trace_json = snapshot::json;
using namespace std::chrono_literals;

static trace_json properties(const std::string & id, int pid = 42) {
    const trace_json value = {{"is_sleeping", false}, {"model_alias", "synthetic-no-model-fixture"},
        {"blackice_runtime", {{"schema", "blackice.minicpm.runtime-startup.v1"},
            {"id", id}, {"startupId", id}, {"pid", pid},
            {"processStartedAt", "2026-01-01T00:00:00.000Z"}, {"complete", true}, {"droppedEvents", 0},
            {"metadataOrigin", "synthetic-no-model-fixture"}}}};
    const auto native = blackice_trace::copy_runtime_properties_json<common_json>(value);
    return blackice_trace::copy_runtime_properties_json<trace_json>(native);
}

static void require(bool value, const std::string & message) {
    if (!value) { throw std::runtime_error(message); }
}

template<class Operation> static bool rejected(Operation operation) {
    try { operation(); return false; } catch (const std::exception &) { return true; }
}

static trace_json concurrent_publication(bool fail) {
    std::mutex mutex;
    snapshot current(mutex);
    current.initialize([] { return properties("context-one"); });
    current.enter_sleep([](const trace_json &) {});
    std::promise<void> entered, release, reader_started;
    auto release_signal = release.get_future().share();
    auto entered_signal = entered.get_future();
    auto reader_signal = reader_started.get_future();
    auto writer = std::async(std::launch::async, [&] {
        return rejected([&] { current.leave_sleep([&] {
            entered.set_value(); release_signal.wait();
            if (fail) { throw std::runtime_error("injected publication failure"); }
            return properties("context-two");
        }); });
    });
    const bool publication_entered = entered_signal.wait_for(5s) == std::future_status::ready;
    if (!publication_entered) { release.set_value(); writer.wait(); throw std::runtime_error("Publication did not enter"); }
    auto reader = std::async(std::launch::async, [&] {
        reader_started.set_value();
        try { return trace_json{{"rejected", false}, {"properties", current.read()}}; }
        catch (const std::exception & error) { return trace_json{{"rejected", true}, {"error", error.what()}}; }
    });
    const bool reader_entered = reader_signal.wait_for(5s) == std::future_status::ready;
    const bool reader_blocked = reader.wait_for(75ms) == std::future_status::timeout;
    release.set_value();
    const bool writer_rejected = writer.get();
    const trace_json observed = reader.get();
    require(reader_entered && reader_blocked, "HTTP snapshot reader did not share the publication lock");
    require(writer_rejected == fail && observed.at("rejected") == fail, "Publication and reader failure disagree");
    if (!fail) {
        require(observed.at("properties").at("blackice_runtime").at("id") == "context-two", "Reader saw stale context after wake");
        require(observed.at("properties").at("blackice_runtime_state") == "awake", "Reader did not see awake snapshot");
    } else {
        require(rejected([&] { current.read(); }), "Failed publication left a readable stale snapshot");
    }
    return {{"name", fail ? "concurrent-failed-publication" : "concurrent-successful-publication"},
        {"readerBlockedDuringPublication", reader_blocked}, {"writerRejected", writer_rejected},
        {"reader", observed}, {"passed", true}};
}

static trace_json actual_queue_lifecycle(bool fail) {
    std::mutex cache_mutex, events_mutex;
    std::condition_variable sleeping_condition;
    snapshot current(cache_mutex);
    current.initialize([] { return properties("queue-context-one"); });
    server_queue queue;
    std::vector<std::string> events;
    bool context_alive = true, sleep_observed = false;
    std::string context_id = "queue-context-one";
    std::atomic<unsigned> decode_calls{0};
    std::exception_ptr loop_error;
    auto event = [&](const std::string & value) { std::lock_guard<std::mutex> lock(events_mutex); events.push_back(value); };
    queue.on_new_task([](server_task &&, bool) { throw std::runtime_error("No model task may enter this fixture"); return false; });
    queue.on_update_slots([] {});

    // Same registration order as server_routes constructor then context init().
    queue.on_sleeping_state([&](bool sleeping) {
        if (sleeping) {
            current.enter_sleep([&](const trace_json & observed) {
                require(context_alive, "Route sleep callback ran after context destruction");
                require(observed.at("blackice_runtime").is_null(), "Sleeping snapshot exposes an active receipt");
                event("route-sleep-publication");
            });
        } else {
            try {
                current.leave_sleep([&] {
                    require(context_alive && context_id == "queue-context-two", "Route wake callback ran before reload");
                    if (fail) { throw std::runtime_error("injected queue publication failure"); }
                    event("route-wake-publication");
                    return properties(context_id);
                });
            } catch (const std::exception & error) {
                // Production takes this same invalidation path and allows the
                // queue to release waiters; admission and props then reject.
                blackice_trace::invalidate(std::string("Runtime properties lifecycle publication failed: ") + error.what());
                event("route-publication-unavailable");
            }
        }
    });
    queue.on_sleeping_state([&](bool sleeping) {
        if (sleeping) {
            context_alive = false; event("synthetic-context-destroyed");
            { std::lock_guard<std::mutex> lock(events_mutex); sleep_observed = true; }
            sleeping_condition.notify_all();
        } else {
            context_alive = true; context_id = "queue-context-two"; event("synthetic-context-reloaded");
        }
    });
    // The production CLI rejects zero and converts positive integer seconds to
    // milliseconds. Use its minimum supported interval, rather than creating
    // an immediate re-sleep race before a notified waiter can acquire the lock.
    constexpr int64_t idle_sleep_ms = 1000;
    const int64_t timer_before_queue_ms = ggml_time_ms();
    std::thread loop([&] { try { queue.start_loop(idle_sleep_ms); } catch (...) { loop_error = std::current_exception(); } });
    struct cleanup {
        server_queue & queue; std::thread & loop;
        ~cleanup() { queue.terminate(); if (loop.joinable()) { loop.join(); } }
    } cleanup_guard{queue, loop};
    {
        std::unique_lock<std::mutex> lock(events_mutex);
        require(sleeping_condition.wait_for(lock, 5s, [&] { return sleep_observed; }), "Actual queue did not enter sleep");
    }
    const int64_t timer_at_sleep_ms = ggml_time_ms();
    require(timer_at_sleep_ms - timer_before_queue_ms >= idle_sleep_ms, "GGML timer did not measure the supported idle interval");
    const auto sleeping = current.read();
    require(sleeping.at("is_sleeping") == true && sleeping.at("blackice_runtime").is_null(), "Current runtime was not absent during sleep");
    require(sleeping.at("blackice_previous_runtime").at("id") == "queue-context-one", "Historical receipt was not preserved separately");
    queue.wait_until_no_sleep();
    event("request-waiter-released");
    require(!queue.is_sleeping(), "Waiter released while queue was still sleeping");
    bool props_rejected = false, admission_rejected = false;
    trace_json awake;
    if (fail) {
        props_rejected = rejected([&] { current.read(); });
        admission_rejected = rejected([&] {
            blackice_trace::require_current_runtime_capture(blackice_trace::healthy(), false);
            ++decode_calls;
        });
        require(!blackice_trace::healthy() && props_rejected && admission_rejected && decode_calls == 0,
            "Failed wake did not reject properties and admission before decode");
    } else {
        awake = current.read();
        blackice_trace::require_current_runtime_capture(blackice_trace::healthy(), true);
        require(awake.at("blackice_runtime").at("id") == "queue-context-two", "Waiter saw the previous context");
        require(awake.at("is_sleeping") == false && awake.at("blackice_runtime_state") == "awake", "Awake runtime state mismatch");
    }
    queue.terminate(); queue.release_inflight(); loop.join();
    if (loop_error) { std::rethrow_exception(loop_error); }
    const std::vector<std::string> expected = {"route-sleep-publication", "synthetic-context-destroyed",
        "synthetic-context-reloaded", fail ? "route-publication-unavailable" : "route-wake-publication", "request-waiter-released"};
    require(events == expected, "Actual queue callback/publication order differs");
    return {{"name", fail ? "actual-queue-failed-publication" : "actual-queue-successful-wake"},
        {"events", events}, {"idleSleepMilliseconds", idle_sleep_ms},
        {"ggmlTimeBeforeQueueMilliseconds", timer_before_queue_ms}, {"ggmlTimeAtSleepMilliseconds", timer_at_sleep_ms},
        {"sleepingProperties", sleeping}, {"awakeProperties", awake},
        {"propsRejected", props_rejected}, {"requestAdmissionRejected", admission_rejected},
        {"decodeCalls", decode_calls.load()}, {"passed", true}};
}

int main() {
    try {
        // Normal llama_backend_init does this before the real queue starts.
        // This no-model fixture needs only the documented Windows timer setup.
        ggml_time_init();
        blackice_trace::initialize_process();
        require(blackice_trace::enabled() && !blackice_trace::capture_enabled(), "Owned metadata-only fixture configuration is required");
        trace_json cases = trace_json::array();
        {
            std::mutex mutex; snapshot current(mutex);
            require(rejected([&] { current.read(); }), "Unpublished snapshot was readable");
            bool forced_growth = false;
            size_t capacity_before = 0, capacity_after = 0;
            const trace_json expected_receipt = properties("context-one").at("blackice_runtime");
            current.initialize([&] {
                auto value = properties("context-one");
                value["bridgeFixture"] = {{"escaped", "quote\" newline\n Unicode \u03bb"},
                    {"values", trace_json::array({nullptr, true, false, 0, -7, 1.25, 9007199254740991ULL})}};
                const auto native = blackice_trace::copy_runtime_properties_json<common_json>(value);
                auto roundtrip = blackice_trace::copy_runtime_properties_json<trace_json>(native);
                require(roundtrip == value, "common_json factory conversion changed JSON values");
                auto & object = roundtrip.get_ref<trace_json::object_t &>();
                object.shrink_to_fit();
                require(object.size() == object.capacity(), "Publication input must have no spare object capacity");
                auto growth_probe = roundtrip;
                auto & probe_object = growth_probe.get_ref<trace_json::object_t &>();
                probe_object.shrink_to_fit();
                capacity_before = probe_object.capacity();
                growth_probe["blackice_runtime_state"] = "awake";
                capacity_after = probe_object.capacity();
                forced_growth = capacity_after > capacity_before;
                require(forced_growth, "Fixture did not force ordered object growth across the production insertion");
                return roundtrip;
            });
            const auto native_response = blackice_trace::copy_runtime_properties_json<common_json>(current.read());
            require(blackice_trace::copy_runtime_properties_json<trace_json>(native_response) == current.read(),
                "common_json GET response conversion changed the current snapshot");
            require(current.read().at("blackice_runtime") == expected_receipt,
                "Publication changed the complete current receipt during ordered object growth");
            auto copy = current.read(); copy["blackice_runtime"]["id"] = "modified-copy";
            require(current.read().at("blackice_runtime").at("id") == "context-one", "HTTP reads can mutate stored receipt");
            common_json native_sleeping;
            current.enter_sleep([&](const trace_json & sleeping) {
                native_sleeping = blackice_trace::copy_runtime_properties_json<common_json>(sleeping);
            });
            const auto asleep = current.read();
            require(blackice_trace::copy_runtime_properties_json<trace_json>(native_sleeping) == asleep,
                "common_json sleeping cache conversion changed the properties");
            require(asleep.at("blackice_runtime").is_null() && asleep.at("blackice_previous_runtime").at("id") == "context-one", "Historical/current receipt separation failed");
            require(asleep.at("blackice_previous_runtime") == expected_receipt,
                "Stored receipt was invalidated by ordered object growth before sleep");
            current.leave_sleep([] { return properties("context-two"); });
            const auto awake = current.read();
            require(awake.at("blackice_runtime").at("id") == "context-two" && !awake.contains("blackice_previous_runtime"), "Fresh awake context did not replace history");
            cases.push_back({{"name", "initial-sleep-wake-and-copy-isolation"}, {"commonJsonBoundaryExercised", true},
                {"forcedOrderedObjectGrowth", forced_growth}, {"capacityBeforeInsertion", capacity_before},
                {"capacityAfterInsertion", capacity_after}, {"publishedReceiptExact", true},
                {"historicalReceiptExact", true}, {"passed", true}});
        }
        for (const auto & kind : {"same-context", "different-process", "incomplete-receipt", "missing-receipt", "factory-throws"}) {
            std::mutex mutex; snapshot current(mutex);
            current.initialize([] { return properties("context-one"); });
            current.enter_sleep([](const trace_json &) {});
            const bool failed = rejected([&] { current.leave_sleep([&] {
                const std::string name(kind);
                if (name == "factory-throws") { throw std::runtime_error("injected failure"); }
                trace_json value = properties(name == "same-context" ? "context-one" : "context-two", name == "different-process" ? 43 : 42);
                if (name == "incomplete-receipt") { value["blackice_runtime"]["complete"] = false; }
                if (name == "missing-receipt") { value["blackice_runtime"] = nullptr; }
                return value;
            }); });
            require(failed && rejected([&] { current.read(); }), std::string(kind) + " retained stale awake properties");
            cases.push_back({{"name", kind}, {"passed", true}, {"unavailableAfterFailure", true}});
        }
        cases.push_back(concurrent_publication(false));
        cases.push_back(concurrent_publication(true));
        cases.push_back(actual_queue_lifecycle(false));
        cases.push_back(actual_queue_lifecycle(true));
        blackice_trace::finish_process(0);
        std::cout << trace_json{{"schema", "blackice.minicpm.runtime-lifecycle-self-test.v1"}, {"complete", true},
            {"cases", cases}, {"modelStarted", false}, {"actualServerQueue", true}, {"commonJsonBoundaryExercised", true},
            {"ggmlTimerInitialized", true},
            {"scope", "Production common_json boundary and runtime snapshot/admission helpers, actual server_queue ordering; synthetic receipt/context metadata, no model load. Failed queue publication invokes the actual recorder invalidation path."}}.dump() << '\n';
        return 0;
    } catch (const std::exception & error) {
        std::cerr << "Runtime lifecycle fixture failed: " << error.what() << '\n';
        return 1;
    }
}
