'use strict';
// Pure source repair: no filesystem, historical receipts, or runtime side effects.
const expected={
 'src/llama-mmap.h':'0fff03ce62bc51b1649833f6017fbd84dc0aac7fce3b38484439153fc13ba8f5',
 'src/llama-mmap.cpp':'216548a6d625ed4bc6ac2197cfa155ff9dc102851f3d43d20f7bc7e4a1362f80',
 'src/llama-model-loader.cpp':'5cce872907839dfaf90db8deafd162fae0a339d6a322add04f55f77de65b6e73',
 'src/llama.cpp':'b848662663738a41888acbf803a7c6aac641ead31070b44d9ee6d7cc9c73b597',
 'src/llama-adapter.cpp':'1b8c87dabcdfdb1f8f663ac8802e943c581e984259a0154506c068902d544498',
 'tools/server/server-common.cpp':'350dfb104d7c1ad1ffe388c35342d93e3f90b4d5c906458952e719e13f59c346',
};
function replace(text,before,after,count=1){if(text.split(before).length-1!==count)throw Error('PATCH_ANCHOR:'+before.slice(0,100));return text.split(before).join(after);}
function span(text,begin,end,replacement){const a=text.indexOf(begin),b=text.indexOf(end,a+begin.length);if(a<0||b<0||text.indexOf(begin,a+begin.length)>=0)throw Error('PATCH_SPAN:'+begin);return text.slice(0,a)+replacement+text.slice(b);}
function patch(file,input){let s=input;
 if(file==='tools/server/server-common.cpp')s=replace(s,'std::map<int, float> parse_lora_request(const json & data) {\n',
  'std::map<int, float> parse_lora_request(const json & data) {\n    if (!data.empty()) {\n        throw std::runtime_error("BLACKICE_IO_UNSUPPORTED_LORA: nonempty adapter requests are unavailable in this private qualification build");\n    }\n');
 if(file==='src/llama-mmap.h')s=replace(s,'struct llama_file;','// Private BLACKICE build: FILE objects opened here belong to the core CRT.\nFILE * llama_file_fopen(const char * fname, const char * mode);\n\nstruct llama_file;');
 if(file==='src/llama-mmap.cpp'){
  const helper=`// Private BLACKICE I/O compatibility: never return a FILE owned by the ggml DLL CRT.
FILE * llama_file_fopen(const char * fname, const char * mode) {
    if (!fname || !mode) { errno = EINVAL; return nullptr; }
#if defined(_WIN32)
    auto convert = [](const char * input, std::wstring & output) {
        const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, -1, nullptr, 0);
        if (count <= 0) { errno = EINVAL; return false; }
        output.resize(static_cast<size_t>(count));
        if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, -1, output.data(), count) != count) {
            errno = EINVAL; return false;
        }
        return true;
    };
    std::wstring wide_name, wide_mode;
    if (!convert(fname, wide_name) || !convert(mode, wide_mode)) { return nullptr; }
    return _wfopen(wide_name.c_str(), wide_mode.c_str());
#else
    return std::fopen(fname, mode);
#endif
}

`;
  s=replace(s,'// llama_file\n',helper+'// llama_file\n');
  s=replace(s,'ggml_fopen(fname.c_str(), mode)','llama_file_fopen(fname.c_str(), mode)',2);
  s=replace(s,'llama_file::llama_file(FILE * file) : pimpl(std::make_unique<impl>(file)) {}',
   'llama_file::llama_file(FILE * /*file*/) {\n    throw std::runtime_error("BLACKICE_IO_UNSUPPORTED_FILE_POINTER: use a filename in this private build");\n}');
 }
 if(file==='src/llama-model-loader.cpp'){
  s=replace(s,'ggml_fopen(fname_split, "rb")','llama_file_fopen(fname_split, "rb")');
  s=span(s,'    } else if (file != nullptr) {\n','    } else {\n        get_key(llm_kv(LLM_KV_GENERAL_ARCHITECTURE), arch_name, false);',
   '    } else if (file != nullptr) {\n        throw std::runtime_error("BLACKICE_IO_UNSUPPORTED_FILE_POINTER: use filename-based model loading");\n');
 }
 if(file==='src/llama.cpp')s=span(s,'struct llama_model * llama_model_load_from_file_ptr(FILE * file, struct llama_model_params params) {\n','\nvoid llama_model_save_to_file(',
  'struct llama_model * llama_model_load_from_file_ptr(FILE * /*file*/, struct llama_model_params /*params*/) {\n    LLAMA_LOG_ERROR("BLACKICE_IO_UNSUPPORTED_FILE_POINTER: opaque FILE* model input is unavailable in this private build; use a filename\\n");\n    return nullptr;\n}\n');
 if(file==='src/llama-adapter.cpp'){
  s=replace(s,'static void llama_adapter_lora_init_impl(llama_model & model, FILE * file, llama_adapter_lora & adapter) {',
   '#if 0 // BLACKICE private I/O build: this unqualified cross-CRT adapter implementation is excluded.\nstatic void llama_adapter_lora_init_impl(llama_model & model, FILE * file, llama_adapter_lora & adapter) {');
  s=replace(s,'int32_t llama_adapter_meta_val_str(',`#endif

llama_adapter_lora * llama_adapter_lora_init(llama_model * /*model*/, const char * /*path_lora*/) {
    LLAMA_LOG_ERROR("BLACKICE_IO_UNSUPPORTED_LORA: adapter loading is unavailable in this private qualification build\\n");
    return nullptr;
}

llama_adapter_lora * llama_adapter_lora_init_from_file_ptr(llama_model * /*model*/, FILE * /*file*/) {
    LLAMA_LOG_ERROR("BLACKICE_IO_UNSUPPORTED_LORA: opaque FILE* adapter input is unavailable in this private qualification build\\n");
    return nullptr;
}

int32_t llama_adapter_meta_val_str(`);
 }
 return s;
}
module.exports={expected,patch};
