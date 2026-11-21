// Included in blackice-trace.cpp so the model-free fixture invokes the actual
// callback and recorder state. No copied capture implementation or model load.
static json allocator_position_fixture(uint32_t sections, llama_pos first_position,
                                       uint32_t count, uint32_t split_size, bool output_last) {
    auto check = [](bool value, const char * message) { if (!value) { throw std::runtime_error(message); } };
    check((sections == 1 || sections == 4) && count > 0 && split_size > 0, "Allocator fixture input");
    llama_vocab vocab;
    // Same context-free constructor used by pinned tests/test-batch-alloc.cpp.
    llama_batch_ext input(count, 4, 4, 4, nullptr, 1024, sections);
    json source_rows = json::array();
    for (uint32_t i = 0; i < count; ++i) {
        const auto idx = input.add_token(0);
        const llama_pos logical[4] = { first_position + static_cast<llama_pos>(i), 0, 0, 0 };
        check(idx == static_cast<int32_t>(i) && input.set_token_id(idx, 100 + i) &&
            input.set_token_pos(idx, logical) && input.set_output(idx, output_last && i + 1 == count),
            "Actual allocator token setup");
        const auto & token = input.tokens.at(i);
        source_rows.push_back({{"batchRow",i},{"serverBatchRow",i},{"slotId",0},{"taskId",42},
            {"tokenId",token.id},{"positions",{token.pos[0],token.pos[1],token.pos[2],token.pos[3]}},
            {"output",token.output},{"isPrompt",!output_last},{"embeddingRow",-1}});
    }
    llama_batch_allocr allocator(sections);
    check(allocator.init(input, vocab, false), "Actual allocator initialization");
    allocator.split_reset();
    json microbatches = json::array(); std::set<uint32_t> seen;
    for (;;) {
        const auto batch = allocator.split_simple(split_size);
        if (batch.n_tokens == 0) { break; }
        check(batch.n_pos == sections && batch.data && batch.data->batch_idxs.size() == batch.n_tokens &&
            batch.token && batch.pos && batch.n_seq_id && batch.seq_id && batch.output, "Actual split row mapping");
        json rows = json::array();
        for (uint32_t i = 0; i < batch.n_tokens; ++i) {
            const uint32_t source_index = batch.data->batch_idxs[i];
            check(source_index < count && seen.insert(source_index).second, "Actual split source index coverage");
            json positions = json::array(), sequences = json::array();
            for (uint32_t j = 0; j < batch.n_pos; ++j) { positions.push_back(batch.pos[j*batch.n_tokens+i]); }
            for (int32_t j = 0; j < batch.n_seq_id[i]; ++j) { sequences.push_back(batch.seq_id[i][j]); }
            check(!batch.type || batch.type[i] == 0, "Actual split must contain text");
            json row = {{"microRow",i},{"batchRow",source_index},{"tokenId",batch.token[i]},
                {"inputKind","token"},{"positions",positions},{"sequenceIds",sequences},{"output",bool(batch.output[i])}};
            check(text_position_row_matches(source_rows.at(source_index), row, batch.n_pos), "Actual expanded text position correspondence");
            check(sequences == json::array({0}) && row.at("output") == source_rows.at(source_index).at("output"),
                "Actual split retains sequence and output ownership");
            rows.push_back(std::move(row));
        }
        microbatches.push_back({{"nPositionSections",batch.n_pos},{"nTokens",batch.n_tokens},{"rows",rows}});
    }
    check(seen.size() == count && allocator.get_n_used() == count, "Every actual allocator source row was consumed");
    return {{"nPositionSections",sections},{"firstPosition",first_position},{"nTokens",count},
        {"splitSize",split_size},{"outputLast",output_last},{"sourceRows",source_rows},
        {"microbatches",microbatches},{"actualAllocatorAndSplit",true},{"modelStarted",false},{"passed",true}};
}

static json text_position_fixtures() {
    json allocator_cases = json::array();
    for (uint32_t sections : {1U,4U}) {
        auto prompt = allocator_position_fixture(sections,17,5,2,false);
        prompt["name"] = "prompt-sections-" + std::to_string(sections); allocator_cases.push_back(prompt);
        auto decode = allocator_position_fixture(sections,2050,1,1,true);
        decode["name"] = "decode-sections-" + std::to_string(sections); allocator_cases.push_back(decode);
    }
    const auto base = allocator_position_fixture(4,17,1,1,false);
    const json source = base.at("sourceRows").at(0);
    const json micro = base.at("microbatches").at(0).at("rows").at(0);
    json negatives = json::array();
    auto reject = [&](const std::string & name, std::function<void(json &,json &,uint32_t &)> mutate) {
        auto s = source, m = micro; uint32_t sections = 4; mutate(s,m,sections);
        if (text_position_row_matches(s,m,sections)) { throw std::runtime_error("Position fixture accepted: "+name); }
        negatives.push_back({{"name",name},{"passed",true}});
    };
    reject("logical-tail",[](auto&s,auto&,auto&){s["positions"][1]=17;});
    reject("unexpanded-core",[](auto&,auto&m,auto&){m["positions"]={17,0,0,0};});
    reject("fourth-section",[](auto&,auto&m,auto&){m["positions"][3]=17;});
    reject("first-section",[](auto&,auto&m,auto&){m["positions"][0]=18;});
    reject("two-sections",[](auto&,auto&,auto&n){n=2;});
    reject("zero-sections",[](auto&,auto&,auto&n){n=0;});
    reject("logical-length",[](auto&s,auto&,auto&){s["positions"]={17};});
    reject("core-length",[](auto&,auto&m,auto&){m["positions"]={17,17,17};});
    reject("logical-fraction",[](auto&s,auto&,auto&){s["positions"][0]=17.5;});
    reject("core-boolean",[](auto&,auto&m,auto&){m["positions"][1]=true;});
    reject("logical-overflow",[](auto&s,auto&,auto&){s["positions"][0]=int64_t(INT32_MAX)+1;});
    reject("core-underflow",[](auto&,auto&m,auto&){m["positions"][0]=int64_t(INT32_MIN)-1;});
    reject("token-mismatch",[](auto&,auto&m,auto&){m["tokenId"]=101;});
    reject("embedding-row",[](auto&s,auto&,auto&){s["embeddingRow"]=0;});
    reject("embedding-kind",[](auto&,auto&m,auto&){m["inputKind"]="embedding";});
    reject("logical-string",[](auto&s,auto&,auto&){s["positions"][0]="17";});
    reject("embedding-fraction",[](auto&s,auto&,auto&){s["embeddingRow"]=-1.5;});
    reject("null-token",[](auto&s,auto&m,auto&){s["tokenId"]=-1;m["tokenId"]=-1;});
    json boundaries = json::array();
    for (int32_t p : {INT32_MIN,INT32_MAX}) {
        auto s = source, m = micro; s["positions"]={p,0,0,0};m["positions"]={p,p,p,0};
        if (!text_position_row_matches(s,m,4)) { throw std::runtime_error("Signed position boundary rejected"); }
        boundaries.push_back({{"position",p},{"scope","pure correspondence, not model-position validity"},{"passed",true}});
    }
    return {{"schema","blackice.minicpm.text-position-fixtures.v1"},{"complete",true},{"modelStarted",false},
        {"allocatorCases",allocator_cases},{"rejectionCases",negatives},{"signedBoundaryCases",boundaries},
        {"sourcePath","src/llama-batch.cpp"},{"sourceSha256","f05699a784309200f1ee1a64857ba1f86b003cde5301275be90731b76723c9ec"}};
}

int empty_self_test(const std::string & directory) {
    try {
        const fs::path root = fs::u8path(directory);
        if (!root.is_absolute() || fs::exists(root) || active || current_micro) {
            throw std::runtime_error("Empty-output self-test needs a new absolute directory and fresh process");
        }
        fs::create_directories(root);
        unsigned passed = 0;
        auto require = [&passed](bool value, const std::string & label) {
            if (!value) { throw std::runtime_error(label); }
            ++passed;
        };
        auto rows_from = [](const fs::path & file) {
            std::ifstream input(file, std::ios::binary);
            std::vector<json> rows; std::string line;
            while (std::getline(input, line)) { if (!line.empty()) { rows.push_back(json::parse(line)); } }
            return rows;
        };
        const auto position_fixtures = text_position_fixtures();
        const auto prompt_fixture = allocator_position_fixture(4,17,11,11,false);
        auto begin_case = [&](const std::string & name) {
            const auto dir = root / name;
            json config_json = {{"schema","blackice.minicpm.trace-config.v1"},{"enabled",true},
                {"activationCaptureEnabled",true},{"outputDirectory",path_utf8(dir)},
                {"maxBytes",uint64_t(16*1024*1024)},
                {"tensorSelection",{"attn_norm","attn_post_norm","ffn_out","l_out"}},
                {"logitVectorSteps",uint64_t(0)}};
            active = std::make_unique<recorder>(parse_config(config_json.dump()),config_json.dump(),"fixture","empty-output-self-test");
            auto state = std::make_shared<context_state>();
            state->id = unique_id(); state->published = true; state->layers = 24;
            state->architecture = "qwen35"; state->mtp_layers = 0; state->embedding_size = 1024;
            state->batches = 1; state->microbatches = 1;
            state->file = std::make_shared<file_sink>(dir / "context.jsonl");
            state->last_batch_rows = json::array();
            current_micro = std::make_unique<micro_state>();
            auto & micro = *current_micro;
            micro.state = state; micro.batch = 1; micro.microbatch = 1;
            micro.graph_type = LLM_GRAPH_TYPE_DEFAULT; micro.mask_observed = true; micro.mapping_known = true;
            micro.position_sections = prompt_fixture.at("nPositionSections");
            micro.rows = prompt_fixture.at("microbatches").at(0).at("rows");
            state->last_batch_rows = prompt_fixture.at("sourceRows");
            return state;
        };
        auto record_fixture = [&]() {
            const auto & micro = *current_micro; const auto & state = *micro.state;
            active->record(state.file,"context_start",{{"startupId",state.id},{"layers",state.layers},
                {"modelArchitecture",state.architecture},{"modelLayerCount",state.layers},
                {"modelMtpLayerCount",state.mtp_layers},{"modelEmbeddingSize",state.embedding_size},
                {"metadataOrigin","synthetic-no-model-fixture"}});
            active->record(state.file,"server_batch_begin",{{"startupId",state.id},{"batchId",micro.batch},{"rows",state.last_batch_rows}});
            active->record(state.file,"microbatch_begin",{{"startupId",state.id},{"batchId",micro.batch},
                {"microbatchId",micro.microbatch},{"graphType",micro.graph_type},
                {"phase",state.published ? "request" : "initialization"},
                {"nTokens",micro.rows.size()},{"rows",micro.rows},{"sourceMappingComplete",micro.mapping_known},
                {"nPositionSections",micro.position_sections},
                {"outputMaskObserved",micro.mask_observed}});
        };
        json cases = json::array();
        struct descriptor_case {
            std::string name, anchor = "attn_post_norm";
            int layer = 23;
            ggml_type type = GGML_TYPE_F32;
            int64_t width = 1024, rows = 0, depth = 1;
            bool accepted = false;
            std::function<void(micro_state &)> mutate;
            bool bad_stride = false;
        };
        std::vector<descriptor_case> descriptors;
        for (const auto & anchor : {"attn_post_norm","ffn_out","l_out"}) {
            descriptor_case item; item.name = std::string("empty-")+anchor;
            item.anchor = anchor; item.accepted = true; descriptors.push_back(item);
        }
        auto reject = [&](const std::string & name, std::function<void(descriptor_case &)> alter) {
            descriptor_case item; item.name = name; alter(item); descriptors.push_back(std::move(item));
        };
        reject("reject-pre-crop",[](auto & x){x.anchor="attn_norm";});
        reject("reject-other-layer",[](auto & x){x.layer=22;});
        reject("reject-other-architecture",[](auto & x){x.mutate=[](auto & m){m.state->architecture="qwen3";};});
        reject("reject-extra-mtp",[](auto & x){x.mutate=[](auto & m){m.state->mtp_layers=1;};});
        reject("reject-other-graph",[](auto & x){x.mutate=[](auto & m){m.graph_type=LLM_GRAPH_TYPE_DECODER_MTP;};});
        reject("reject-batch-zero",[](auto & x){x.mutate=[](auto & m){m.batch=0;};});
        reject("reject-unpublished-context",[](auto & x){x.mutate=[](auto & m){m.state->published=false;};});
        reject("reject-missing-mapping",[](auto & x){x.mutate=[](auto & m){m.mapping_known=false;};});
        reject("reject-missing-mask",[](auto & x){x.mutate=[](auto & m){m.mask_observed=false;};});
        reject("reject-selected-output",[](auto & x){x.mutate=[](auto & m){m.rows[0]["output"]=true;m.output_rows={0};m.state->last_batch_rows[0]["output"]=true;};});
        reject("reject-hidden-true-mask",[](auto & x){x.mutate=[](auto & m){m.rows[0]["output"]=true;};});
        reject("reject-empty-source",[](auto & x){x.mutate=[](auto & m){m.rows=json::array();};});
        reject("reject-server-token-mismatch",[](auto & x){x.mutate=[](auto & m){m.state->last_batch_rows[0]["tokenId"]=999;};});
        reject("reject-server-output-mismatch",[](auto & x){x.mutate=[](auto & m){m.state->last_batch_rows[0]["output"]=true;};});
        reject("reject-duplicate-source-row",[](auto & x){x.mutate=[](auto & m){m.rows[1]=m.rows[0];};});
        reject("reject-unexpanded-text-core",[](auto & x){x.mutate=[](auto & m){m.rows[1]["positions"]={18,0,0,0};};});
        reject("reject-fourth-position-section",[](auto & x){x.mutate=[](auto & m){m.rows[1]["positions"][3]=18;};});
        reject("reject-logical-position-tail",[](auto & x){x.mutate=[](auto & m){m.state->last_batch_rows[1]["positions"][1]=18;};});
        reject("reject-position-section-count",[](auto & x){x.mutate=[](auto & m){m.position_sections=2;};});
        reject("reject-first-position-section",[](auto & x){x.mutate=[](auto & m){m.rows[1]["positions"][0]=19;};});
        reject("reject-server-slot-mismatch",[](auto & x){x.mutate=[](auto & m){m.state->last_batch_rows[0]["slotId"]=1;};});
        reject("reject-server-embedding-row",[](auto & x){x.mutate=[](auto & m){m.state->last_batch_rows[0]["embeddingRow"]=0;};});
        reject("reject-non-f32",[](auto & x){x.type=GGML_TYPE_F16;});
        reject("reject-wrong-width",[](auto & x){x.width=512;});
        reject("reject-wrong-depth",[](auto & x){x.depth=2;});
        reject("reject-zero-width",[](auto & x){x.width=0;});
        reject("reject-wrong-stride",[](auto & x){x.bad_stride=true;});
        for (const auto & item : descriptors) {
            auto state = begin_case(item.name);
            if (item.mutate) { item.mutate(*current_micro); }
            record_fixture();
            std::unique_ptr<ggml_context,decltype(&ggml_free)> tensors(
                ggml_init({ggml_tensor_overhead()*8,nullptr,true}),ggml_free);
            require(bool(tensors),item.name+": GGML metadata allocation");
            auto * tensor = ggml_new_tensor_3d(tensors.get(),item.type,item.width,item.rows,item.depth);
            const auto name = item.anchor+"-"+std::to_string(item.layer);
            ggml_set_name(tensor,name.c_str());
            if (item.bad_stride) { tensor->nb[1] += sizeof(float); }
            require(tensor->buffer==nullptr && tensor->data==nullptr,item.name+": no backend allocation");
            require(eval_callback(tensor,true,nullptr),item.name+": callback selection");
            const bool accepted = eval_callback(tensor,false,nullptr);
            require(accepted==item.accepted,item.name+": actual callback outcome");
            require(state->backend_reads==0 && state->tensors==0,item.name+": no backend read or measured activation");
            require(state->empty_tensors==(item.accepted?1U:0U),item.name+": separate empty count");
            require(active->failed==!item.accepted,item.name+": invalid-capture state");
            state->file->flush();
            auto events=rows_from(state->file->path); json observed;
            for(const auto & row:events)if(row.at("event")== (item.accepted?"tensor_empty":"tensor_rejected"))observed=row.at("data");
            require(!observed.is_null(),item.name+": saved disposition");
            if(item.accepted){
                require(observed.at("bytes")==0 && observed.at("elementCount")==0,item.name+": zero extent");
                require(!observed.contains("perToken") && !observed.contains("statistics") && !observed.contains("rawFloat32Sha256"),item.name+": no fabricated metrics");
                require(current_micro->measured.empty() && current_micro->empty.at(name)==1 && current_micro->observed.at(name)==1,item.name+": anchor disposition counters");
            }
            cases.push_back({{"name",item.name},{"expectedAccepted",item.accepted},{"accepted",accepted},
                {"backendReadCalls",state->backend_reads},{"measuredTensorEvents",state->tensors},
                {"emptyTensorEvents",state->empty_tensors},{"observation",observed},
                {"traceFile",path_utf8(state->file->path)},{"passed",true}});
            current_micro.reset(); active.reset();
        }

        // A full 24-layer selected-anchor fixture measures real CPU-buffer bytes
        // for 93 anchors and records only the three final post-crop anchors empty.
        {
            auto state=begin_case("full-anchor-coverage"); record_fixture();
            ggml_backend_load_all();
            const auto cpu=ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
            require(cpu!=nullptr,"CPU buffer device available");
            std::unique_ptr<ggml_context,decltype(&ggml_free)> tensors(
                ggml_init({ggml_tensor_overhead()*8,nullptr,true}),ggml_free);
            require(bool(tensors),"Coverage GGML metadata allocation");
            auto * measured=ggml_new_tensor_2d(tensors.get(),GGML_TYPE_F32,1024,11);
            auto * empty=ggml_new_tensor_2d(tensors.get(),GGML_TYPE_F32,1024,0);
            struct buffer_owner { ggml_backend_buffer_t value; ~buffer_owner(){ggml_backend_buffer_free(value);} };
            buffer_owner buffer{ggml_backend_buft_alloc_buffer(ggml_backend_dev_buffer_type(cpu),ggml_nbytes(measured))};
            require(buffer.value!=nullptr,"Actual CPU buffer allocation");
            require(ggml_backend_tensor_alloc(buffer.value,measured,ggml_backend_buffer_get_base(buffer.value))==GGML_STATUS_SUCCESS,"Actual CPU tensor placement");
            const std::vector<float> values(1024*11,1.0f);
            ggml_backend_tensor_set(measured,values.data(),0,values.size()*sizeof(float));
            for(uint32_t layer=0;layer<24;++layer)for(const auto & anchor:active->settings.anchors){
                const bool no_values=layer==23&&anchor!="attn_norm";
                auto * tensor=no_values?empty:measured;
                const auto name=anchor+"-"+std::to_string(layer);ggml_set_name(tensor,name.c_str());
                require(eval_callback(tensor,true,nullptr)&&eval_callback(tensor,false,nullptr),"Actual selected anchor callback: "+name);
            }
            require(state->tensors==93&&state->backend_reads==93&&state->empty_tensors==3,"Measured and empty counters stay separate");
            end_micro(GGML_STATUS_SUCCESS);state->file->flush();
            const auto events=rows_from(state->file->path);json terminal;unsigned measured_count=0,empty_count=0;
            for(const auto & row:events){
                if(row.at("event")=="tensor_statistics"){
                    ++measured_count;const auto & per_token=row.at("data").at("perToken");
                    require(per_token.size()==11,"Measured source rows retained");
                    for(const auto & value:per_token)require(value.at("elements")==1024&&value.at("finiteMean")==1.0&&value.at("finiteRms")==1.0,"Actual CPU values measured");
                }else if(row.at("event")=="tensor_empty"){++empty_count;}
                else if(row.at("event")=="microbatch_end"){terminal=row.at("data");}
            }
            require(measured_count==93&&empty_count==3&&terminal.at("complete")==true,"Saved complete anchor coverage");
            require(terminal.at("measuredTensors").size()==93&&terminal.at("emptyTensors").size()==3&&terminal.at("observedTensors").size()==96,"Exact disposition maps");
            cases.push_back({{"name","full-anchor-coverage"},{"measuredTensorEvents",state->tensors},
                {"emptyTensorEvents",state->empty_tensors},{"backendReadCalls",state->backend_reads},
                {"traceFile",path_utf8(state->file->path)},{"terminal",terminal},{"passed",true}});
            active.reset();
        }

        json routes=json::array();
        struct counted_slot {
            int id;bool processing;std::vector<std::string> * calls;
            bool is_processing()const{return processing;}
            void release(){calls->push_back("release:"+std::to_string(id));processing=false;}
            void prompt_clear(){if(processing)throw std::runtime_error("Clear before release");calls->push_back("clear:"+std::to_string(id));}
        };
        for(const auto & input:std::vector<json>{
            {{"name","trace-abort"},{"ret",2},{"batch",2048},{"healthy",false},{"terminal",true}},
            {{"name","kv-retry"},{"ret",1},{"batch",2048},{"healthy",true},{"terminal",false}},
            {{"name","context-terminal"},{"ret",1},{"batch",1},{"healthy",true},{"terminal",true}},
            {{"name","invalid-input"},{"ret",-1},{"batch",32},{"healthy",true},{"terminal",true}},
            {{"name","compute-error"},{"ret",-3},{"batch",32},{"healthy",true},{"terminal",true}},
            {{"name","unrelated-abort-unchanged"},{"ret",2},{"batch",32},{"healthy",true},{"terminal",false}}}){
            std::vector<std::string> calls;std::vector<counted_slot> slots={{0,true,&calls},{1,false,&calls},{2,true,&calls}};
            bool threw=false;int retry_count=0;std::string message;
            try{
                route_decode_failure(input.at("ret"),input.at("batch"),input.at("healthy"),slots,
                    [&](auto & slot,const std::string & error){message=error;calls.push_back("error:"+std::to_string(slot.id));},
                    [&](const std::string & error){message=error;calls.push_back("log");});
                ++retry_count;
            }catch(const std::runtime_error & error){threw=true;message=error.what();}
            const bool terminal=input.at("terminal");
            require(threw==terminal&&retry_count==(terminal?0:1),input.at("name").get<std::string>()+": terminal versus retry");
            if(terminal)require(calls==std::vector<std::string>{"log","error:0","release:0","clear:0","error:2","release:2","clear:2"},"Actual error/release/clear route order");
            else require(calls.empty(),"Retry does not terminate slots");
            if(input.at("name")=="trace-abort")require(message.rfind("BLACKICE_TRACE_INVALID:",0)==0,"Explicit trace error reaches client error sink");
            routes.push_back({{"input",input},{"calls",calls},{"threw",threw},{"retryCount",retry_count},{"message",message},{"passed",true}});
        }
        const json result={{"schema","blackice.minicpm.empty-output-self-test.v1"},{"passedChecks",passed},
            {"cases",cases},{"decodeRoutes",routes},{"positionCorrespondence",position_fixtures},
            {"callbackRowSource",prompt_fixture},{"modelStarted",false},{"complete",true},
            {"scope","Actual GGML tensor objects, CPU-buffer reads and production capture callback; synthetic model metadata. The server's actual decode routing helper is exercised with counted slots."}};
        const auto bytes=result.dump(2)+"\n";file_sink output(root/"result.json");output.write(bytes.data(),bytes.size());output.flush();
        std::printf("%s\n",json{{"complete",true},{"passedChecks",passed},{"tensorCases",cases.size()},{"routeCases",routes.size()},{"modelStarted",false}}.dump().c_str());
        return 0;
    }catch(const std::exception & error){
        current_micro.reset();active.reset();
        std::fprintf(stderr,"Empty-output self-test failed: %s\n",error.what());return 1;
    }
}
