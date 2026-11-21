#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include "llama.h"
#include "llama-mmap.h"
#include "ggml.h"
#include "gguf.h"
#include "nlohmann/json.hpp"
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::ordered_json;
namespace fs = std::filesystem;

static void require(bool ok, const std::string & message) {
    if (!ok) { throw std::runtime_error(message); }
}
static std::wstring wide(const std::string & text) {
    const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.c_str(), -1, nullptr, 0);
    require(count > 0, "Invalid UTF-8 probe path");
    std::wstring out(count, L'\0');
    require(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.c_str(), -1, out.data(), count) == count, "UTF-8 conversion failed");
    out.pop_back();
    return out;
}
struct handle {
    HANDLE value = INVALID_HANDLE_VALUE;
    explicit handle(const std::string & path, bool create = false) {
        value = CreateFileW(wide(path).c_str(), create ? GENERIC_WRITE : GENERIC_READ,
                            create ? 0 : FILE_SHARE_READ, nullptr, create ? CREATE_NEW : OPEN_EXISTING,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
        require(value != INVALID_HANDLE_VALUE, "Win32 open failed: " + path);
    }
    ~handle() { if (value != INVALID_HANDLE_VALUE) { CloseHandle(value); } }
    handle(const handle &) = delete;
};
static uint64_t os_size(HANDLE file) {
    LARGE_INTEGER size;
    require(GetFileSizeEx(file, &size) && size.QuadPart >= 0, "GetFileSizeEx failed");
    return static_cast<uint64_t>(size.QuadPart);
}
static std::vector<unsigned char> os_read(HANDLE file, uint64_t offset, size_t size) {
    LARGE_INTEGER at; at.QuadPart = static_cast<LONGLONG>(offset);
    require(SetFilePointerEx(file, at, nullptr, FILE_BEGIN), "Win32 seek failed");
    std::vector<unsigned char> out(size);
    DWORD count = 0;
    require(ReadFile(file, out.data(), static_cast<DWORD>(size), &count, nullptr) && count == size, "Win32 read failed");
    return out;
}
static json check_file(const std::string & path, uint64_t expected_size) {
    handle independent(path);
    const uint64_t size = os_size(independent.value);
    require(size == expected_size, "Independent file size differs");
    llama_file file(path.c_str(), "rb");
    require(file.size() == size && file.tell() == 0, "Core file size/cursor differs from Win32");
    file.seek(0, SEEK_END);
    require(file.tell() == size, "Core end seek differs");
    file.seek(0, SEEK_SET);
    file.seek(3, SEEK_CUR);
    require(file.tell() == 3, "Core relative seek differs");
    llama_mmap mapped(&file, 0, false);
    require(mapped.size() == size && mapped.addr() != nullptr, "Core mmap extent differs");
    json reads = json::array();
    const std::array<uint64_t, 4> offsets = {0, 5, size / 2, size - std::min<uint64_t>(64, size)};
    for (const uint64_t offset : offsets) {
        const size_t count = static_cast<size_t>(std::min<uint64_t>(64, size - offset));
        const auto expected = os_read(independent.value, offset, count);
        std::vector<unsigned char> actual(count);
        file.seek(static_cast<size_t>(offset), SEEK_SET);
        file.read_raw(actual.data(), count);
        require(actual == expected, "Core file read differs from Win32");
        require(file.tell() == offset + count, "Core read cursor differs");
        require(std::memcmp(static_cast<const unsigned char *>(mapped.addr()) + offset, expected.data(), count) == 0,
                "Core mmap bytes differ from Win32");
        reads.push_back({{"offset", offset}, {"bytes", count}, {"readMatches", true}, {"mmapMatches", true}});
    }
    return {{"path", path}, {"osBytes", size}, {"coreBytes", file.size()}, {"mmapBytes", mapped.size()},
            {"endAndRelativeSeeksVerified", true}, {"reads", reads}};
}
int main(int argc, char ** argv) {
    try {
        require(argc == 4, "Usage: io-compat-probe <model-path> <expected-size> <owned-fixture-directory>");
        const std::string model_path = argv[1], directory = argv[3];
        const uint64_t expected_size = std::stoull(argv[2]);
        require(expected_size > 64 && fs::is_directory(fs::path(wide(directory))), "Owned fixture directory is absent");
        json result = {{"schema", "blackice.minicpm.io-compat-probe.v1"}, {"modelStarted", false},
                       {"modelBytesWritten", false}, {"pid", GetCurrentProcessId()}};
        result["modelFile"] = check_file(model_path, expected_size);

        ggml_context * tensors = nullptr;
        const gguf_init_params params = {true, &tensors};
        std::unique_ptr<gguf_context, decltype(&gguf_free)> metadata(gguf_init_from_file(model_path.c_str(), params), gguf_free);
        std::unique_ptr<ggml_context, decltype(&ggml_free)> tensor_owner(tensors, ggml_free);
        require(metadata && tensors, "DLL-owned filename GGUF metadata parse failed");
        const uint64_t data_offset = gguf_get_data_offset(metadata.get());
        require(data_offset < expected_size, "GGUF data offset outside file");
        json extents = json::array();
        for (ggml_tensor * tensor = ggml_get_first_tensor(tensors); tensor; tensor = ggml_get_next_tensor(tensors, tensor)) {
            const int64_t index = gguf_find_tensor(metadata.get(), ggml_get_name(tensor));
            require(index >= 0, "Tensor metadata index missing");
            const uint64_t relative = gguf_get_tensor_offset(metadata.get(), index), bytes = ggml_nbytes(tensor);
            require(relative <= expected_size - data_offset, "Tensor offset outside file");
            const uint64_t absolute = data_offset + relative;
            require(bytes <= expected_size - absolute, "Tensor extent outside file");
            extents.push_back({{"name", ggml_get_name(tensor)}, {"index", index}, {"offset", absolute}, {"bytes", bytes}, {"end", absolute + bytes}});
        }
        require(!extents.empty() && extents.size() == static_cast<size_t>(gguf_get_n_tensors(metadata.get())), "Tensor metadata coverage incomplete");
        result["gguf"] = {{"dataOffset", data_offset}, {"tensorCount", extents.size()}, {"allTensorBoundsValid", true}, {"extents", extents}};

        const std::string unicode_path = directory + "\\io-fixture-\xc3\xa9-\xe6\xa8\xa1\xe5\x9e\x8b.bin";
        const std::array<unsigned char, 137> payload = [] { std::array<unsigned char, 137> out{};
            for (size_t i = 0; i < out.size(); ++i) { out[i] = static_cast<unsigned char>((i * 17 + 3) & 255); } return out; }();
        {
            handle fixture(unicode_path, true);
            DWORD written = 0;
            require(WriteFile(fixture.value, payload.data(), payload.size(), &written, nullptr) && written == payload.size(), "Unicode fixture write failed");
            require(FlushFileBuffers(fixture.value), "Unicode fixture flush failed");
        }
        result["unicodeFixture"] = check_file(unicode_path, payload.size());
        const std::string written_path = directory + "\\core-write-\xc3\xa9.bin";
        {
            std::unique_ptr<FILE, decltype(&std::fclose)> file(llama_file_fopen(written_path.c_str(), "wb"), std::fclose);
            require(file != nullptr, "Core UTF-8 write open failed");
            require(std::fwrite(payload.data(), 1, payload.size(), file.get()) == payload.size() && std::fflush(file.get()) == 0,
                    "Core UTF-8 write failed");
        }
        handle written(written_path);
        require(os_read(written.value, 0, payload.size()) == std::vector<unsigned char>(payload.begin(), payload.end()), "Core writes differ from independent OS read");
        result["coreOwnedWriteVerified"] = true;

        FILE * opaque = reinterpret_cast<FILE *>(static_cast<uintptr_t>(1));
        bool file_rejected = false;
        try { llama_file unsafe(opaque); } catch (const std::runtime_error & error) {
            file_rejected = std::string(error.what()).find("BLACKICE_IO_UNSUPPORTED_FILE_POINTER") != std::string::npos;
        }
        require(file_rejected, "Opaque llama_file input was not explicitly rejected");
        llama_model_params model_params{};
        require(llama_model_load_from_file_ptr(opaque, model_params) == nullptr, "Opaque model input was not rejected");
        require(llama_adapter_lora_init(nullptr, "BLACKICE_MUST_NOT_OPEN_THIS_ADAPTER") == nullptr, "LoRA filename input was not rejected");
        require(llama_adapter_lora_init_from_file_ptr(nullptr, opaque) == nullptr, "LoRA FILE input was not rejected");
        result["explicitRejections"] = {"opaque-llama-file", "opaque-model-file", "lora-filename", "opaque-lora-file"};
        result["complete"] = true;
        std::cout << result.dump() << '\n';
        return 0;
    } catch (const std::exception & error) {
        std::cerr << "BLACKICE no-model I/O gate failed: " << error.what() << '\n';
        return 1;
    }
}
