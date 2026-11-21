#pragma once

// Private experimental-server error routing. The server and model-free native
// fixture use this same classifier and slot cleanup implementation.
#include <stdexcept>
#include <string>

namespace blackice_trace {
inline std::string decode_error_message(int result, int batch_size, bool trace_healthy) {
    if (result == 2 && !trace_healthy) {
        return "BLACKICE_TRACE_INVALID: benchmark capture failed; request terminated.";
    }
    if (batch_size == 1 && result == 1) { return "Context size has been exceeded."; }
    if (result == -1) { return "Invalid input batch."; }
    if (result < -1) { return "Compute error."; }
    return {};
}

template <class Slots, class ErrorSink, class Logger>
void route_decode_failure(int result, int batch_size, bool trace_healthy,
                          Slots & slots, ErrorSink send_error, Logger log_error) {
    const auto message = decode_error_message(result, batch_size, trace_healthy);
    if (message.empty()) { return; }
    log_error(message);
    for (auto & slot : slots) {
        if (slot.is_processing()) {
            send_error(slot, message);
            slot.release();
            // Preserve the existing error path: partial decode state is cleared.
            slot.prompt_clear();
        }
    }
    // The caller's smaller-batch retry is unreachable for a terminal failure.
    throw std::runtime_error(message);
}
} // namespace blackice_trace
