#include "server-common.h"
#include <iostream>
#include <stdexcept>
#include <string>

int main() {
    try {
        if (!parse_lora_request(json::array()).empty()) { throw std::runtime_error("Empty adapter list changed"); }
        bool rejected = false;
        try { (void) parse_lora_request(json::array({{{"id", 0}, {"scale", 1.0}}})); }
        catch (const std::runtime_error & error) {
            rejected = std::string(error.what()).find("BLACKICE_IO_UNSUPPORTED_LORA") != std::string::npos;
        }
        if (!rejected) { throw std::runtime_error("Nonempty LoRA request was not explicitly rejected"); }
        std::cout << "{\"schema\":\"blackice.minicpm.io-request-probe.v1\",\"complete\":true,\"emptyListAllowed\":true,\"nonemptyListExplicitlyRejected\":true,\"modelStarted\":false}\n";
        return 0;
    } catch (const std::exception & error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
