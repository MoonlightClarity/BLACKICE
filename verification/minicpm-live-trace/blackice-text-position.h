#pragma once

#include "../vendor/nlohmann/json.hpp"
#include <cstdint>
#include <limits>

namespace blackice_trace {

inline bool text_position_i32(const nlohmann::ordered_json & value) {
    if (!value.is_number_integer()) { return false; }
    if (value.is_number_unsigned()) {
        return value.get<uint64_t>() <= uint64_t(std::numeric_limits<int32_t>::max());
    }
    const auto number = value.get<int64_t>();
    return number >= std::numeric_limits<int32_t>::min() && number <= std::numeric_limits<int32_t>::max();
}

// Pinned llama.cpp b1b770d90, src/llama-batch.cpp, llama_batch_allocr::init:
// token IDs use their scalar position; each section j is j < 3 ? p : 0.
// Server text rows retain [p,0,0,0]. These are distinct observed representations.
// This helper never changes either array or establishes task/slot ownership.
inline bool text_position_row_matches(const nlohmann::ordered_json & source,
                                      const nlohmann::ordered_json & micro,
                                      uint32_t sections) {
    try {
        if ((sections != 1 && sections != 4) || !source.is_object() || !micro.is_object() ||
            micro.at("inputKind") != "token" ||
            !text_position_i32(source.at("embeddingRow")) || source.at("embeddingRow").get<int32_t>() >= 0 ||
            !text_position_i32(source.at("tokenId")) || source.at("tokenId").get<int32_t>() < 0 ||
            !text_position_i32(micro.at("tokenId")) || source.at("tokenId") != micro.at("tokenId")) { return false; }
        const auto & logical = source.at("positions");
        const auto & observed = micro.at("positions");
        if (!logical.is_array() || logical.size() != 4 || !observed.is_array() || observed.size() != sections) { return false; }
        for (size_t i = 0; i < logical.size(); ++i) {
            if (!text_position_i32(logical.at(i)) || (i != 0 && logical.at(i).get<int32_t>() != 0)) { return false; }
        }
        const auto position = logical.at(0).get<int32_t>();
        for (uint32_t i = 0; i < sections; ++i) {
            if (!text_position_i32(observed.at(i)) || observed.at(i).get<int32_t>() != (i < 3 ? position : 0)) { return false; }
        }
        return true;
    } catch (const nlohmann::json::exception &) {
        return false;
    }
}

} // namespace blackice_trace
