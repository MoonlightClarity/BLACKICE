#include "common.h"
#include "server-common.h"
#include "server-http.h"
#if BLACKICE_FIXTURE_TRACE
#include "blackice-trace.h"
#endif
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>

// Uses the actual server_http_context adapter and linked server library. No
// model/context initialization is performed by this executable.
namespace {
std::mutex output_mutex;
void emit(const json & value) {
    std::lock_guard<std::mutex> lock(output_mutex);
    std::cout << value.dump() << std::endl;
}

struct stream_state {
    explicit stream_state(std::string value) : name(std::move(value)) {}
    std::string name;
    std::mutex mutex;
    std::condition_variable condition;
    unsigned calls = 0;
    bool waiting = false, released = false, timed_out = false, completed = false;
    bool returned_final = false;

    json snapshot() {
        std::lock_guard<std::mutex> lock(mutex);
        return {{"case",name},{"calls",calls},{"waiting",waiting},{"released",released},
                {"timedOut",timed_out},{"completed",completed},{"returnedFinal",returned_final}};
    }

    bool next(std::string & chunk) {
        std::unique_lock<std::mutex> lock(mutex);
        const auto call = ++calls;
        if (call == 1) { chunk = "data: {\"fixture\":\"ready\"}\n\n"; return true; }
        if (name == "final-chunk") {
            if (call != 2) { throw std::runtime_error("Unexpected final-chunk callback"); }
            chunk = "data: [DONE]\n\n"; returned_final = true; return false;
        }
        if (name == "final-empty") {
            if (call == 2) { chunk = "data: [DONE]\n\n"; return true; }
            if (call != 3) { throw std::runtime_error("Unexpected final-empty callback"); }
            chunk.clear(); returned_final = true; return false;
        }
        if (call != 2) { throw std::runtime_error("Unexpected failure-path callback"); }
        // The client observes this barrier, closes its stream with an actual
        // TCP reset, then releases it over a separate HTTP connection.
        waiting = true;
        condition.notify_all();
        if (!condition.wait_for(lock,std::chrono::seconds(6),[this] { return released; })) {
            timed_out = true;
            throw std::runtime_error("Client reset barrier timed out");
        }
        waiting = false;
        if (name == "reset-write") {
            chunk.assign(8*1024*1024,'x'); return true;
        }
        if (name == "reset-done") {
            chunk.clear(); returned_final = true; return false;
        }
        throw std::runtime_error("Unknown fixture case");
    }

    void release() {
        std::lock_guard<std::mutex> lock(mutex);
        if (!waiting || released) { throw std::runtime_error("Barrier is not awaiting release"); }
        released = true; condition.notify_all();
    }

    void finish() {
        { std::lock_guard<std::mutex> lock(mutex); completed = true; }
        emit({{"event","producer_cleanup"},{"state",snapshot()}});
    }
};

struct fixture_response : server_http_res {
    std::shared_ptr<stream_state> state;
    explicit fixture_response(std::shared_ptr<stream_state> value) : state(std::move(value)) {
        content_type = "text/event-stream";
        next = [state=state](std::string & chunk) { return state->next(chunk); };
    }
    void on_complete() override { state->finish(); }
};

server_http_res_ptr body(const json & value, int status=200) {
    auto result=std::make_unique<server_http_res>(); result->status=status;
    result->data=value.dump(); return result;
}
}

int main() {
    try {
#if BLACKICE_FIXTURE_TRACE
        blackice_trace::initialize_process();
#endif
        common_params params;
        params.hostnames={"127.0.0.1"}; params.port=0; params.n_threads_http=3;
        server_http_context server;
        if (!server.init(params)) { throw std::runtime_error("HTTP fixture initialization failed"); }
        std::mutex states_mutex;
        std::map<std::string,std::shared_ptr<stream_state>> states;
        auto lookup=[&](const std::string & name) {
            std::lock_guard<std::mutex> lock(states_mutex);
            const auto found=states.find(name);
            if (found==states.end()) { throw std::runtime_error("Unknown case state"); }
            return found->second;
        };
        server.post("/completion/fixture",[&](const server_http_req & request)->server_http_res_ptr {
            try {
                const auto name=json::parse(request.body).at("case").get<std::string>();
                if (name!="final-chunk" && name!="final-empty" && name!="reset-write" && name!="reset-done") {
                    return body({{"error","Unknown fixture case"}},400);
                }
                auto state=std::make_shared<stream_state>(name);
                { std::lock_guard<std::mutex> lock(states_mutex);
                  if (!states.emplace(name,state).second) { return body({{"error","Duplicate case"}},409); } }
                return std::make_unique<fixture_response>(std::move(state));
            } catch (const std::exception & error) { return body({{"error",error.what()}},400); }
        });
        server.get("/fixture/state",[&](const server_http_req & request) {
            try { return body(lookup(request.get_param("case"))->snapshot()); }
            catch (const std::exception & error) { return body({{"error",error.what()}},404); }
        });
        server.post("/fixture/release",[&](const server_http_req & request) {
            try { lookup(json::parse(request.body).at("case").get<std::string>())->release(); return body({{"released",true}}); }
            catch (const std::exception & error) { return body({{"error",error.what()}},409); }
        });
        server.is_ready=true;
        if (!server.start()) { throw std::runtime_error("HTTP fixture listener failed"); }
        emit({{"event","ready"},{"port",server.port},{"modelStarted",false},
              {"traceEnabled",bool(BLACKICE_FIXTURE_TRACE)}});
        std::string control;
        std::getline(std::cin,control);
        server.stop(); server.join();
        if (control!="stop") { throw std::runtime_error("Missing owned stop command"); }
        { std::lock_guard<std::mutex> lock(states_mutex);
          if (states.size()!=4) { throw std::runtime_error("Not all HTTP cases ran"); }
          for (const auto & item : states) {
              const auto state=item.second->snapshot();
              if (!state.at("completed").get<bool>() || state.at("timedOut").get<bool>()) {
                  throw std::runtime_error("HTTP case did not settle cleanly");
              }
          } }
#if BLACKICE_FIXTURE_TRACE
        blackice_trace::finish_process(0);
#endif
        emit({{"event","settled"},{"cases",4},{"modelStarted",false}});
        return 0;
    } catch (const std::exception & error) {
        std::cerr << error.what() << std::endl;
#if BLACKICE_FIXTURE_TRACE
        blackice_trace::finish_process(2);
#endif
        return 2;
    }
}
