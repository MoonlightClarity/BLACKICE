import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export const LLAMA_BUNDLE_VERSION = 'v1.0.0 (b12359)';
export const LLAMA_RUNTIME_ID = 'blackice-b12359-qwen3-action-schema-io-v2';
export const LLAMA_RUNTIME_COMMIT = 'b1b770d90d94cad9e9ea5b993bdbc383a522fb28';
// Root must qualify QX3 and its portable archive before a production bundle can run.
// No environment variable, installed manifest, or user setting can supply this trust anchor.
export const LLAMA_RUNTIME_REPAIR_PIN = Object.freeze({
  "runtimeId": "blackice-b12359-qwen3-action-schema-io-v2",
  "sourceCommit": "b1b770d90d94cad9e9ea5b993bdbc383a522fb28",
  "release": "b12359",
  "sourceArchive": {
    "size": 38905965,
    "sha256": "ae8556670b17c25931cd39eb7c95617650eaf6091bbcff206750583ddde1acb4"
  },
  "buildManifest": {
    "schema": "blackice.minicpm.qx3.bundle.v1",
    "size": 4953,
    "sha256": "c8bb47ab079c5489ddcc9a844cc7fa7ed7537782757157527d22caf9900ee3bd"
  },
  "executable": {
    "size": 18896547,
    "sha256": "2b614e1439fbdf5e16e94268077e8a356886ca1c219062ef85353a1c1f334d7d"
  },
  "repairArchive": {
    "name": "blackice-b12359-qwen3-action-schema-io-v2.zip",
    "url": "https://github.com/MoonlightClarity/BLACKICE/releases/download/runtime-blackice-b12359-qwen3-action-schema-io-v2/blackice-b12359-qwen3-action-schema-io-v2.zip",
    "size": 83771892,
    "sha256": "b5d289d1c5dff15892c8ca44e38e22e3ebd4b7f5207564a469ad1ee72235202e"
  },
  "archives": {
    "cpu": {
      "name": "llama-b12359-bin-win-cpu-x64.zip",
      "size": 25097509,
      "sha256": "837c1655e87df3b66989f4be33a792a1399c785bf259038dc75c900096683e69"
    },
    "vulkan": {
      "name": "llama-b12359-bin-win-vulkan-x64.zip",
      "size": 38090643,
      "sha256": "e8d18c6e4210cca87e7307c2ea78363ac8d158e4e1397358ec96ab70b53a0d5e"
    }
  },
  "patches": [
    {
      "name": "llama-qwen3-object-schema.patch",
      "size": 11999,
      "sha256": "a6fff69ceb855441099a9bedc59c4e00aacbfa0b169d2a305e23a0eb3dfae088"
    },
    {
      "name": "llama-qwen3-io-compat.patch",
      "size": 5782,
      "sha256": "4f8dff442a969b24901c5dc47882a782f3407d1e927b510430a3fcbf209188f9"
    },
    {
      "name": "llama-qwen3-action-schema.patch",
      "size": 28852,
      "sha256": "11ca5c95dca4ad276c43a65a9a83e14b047739a94ba74e3e4dc53c540fa8b62b"
    }
  ],
  "repairFiles": [
    {
      "path": "bin/ggml-base.dll",
      "size": 832000,
      "sha256": "20e4986ec6fd88eb61630433ff172e08885f8fecfbd0c1960a5d55c8854019e3"
    },
    {
      "path": "bin/ggml-cpu-alderlake.dll",
      "size": 1459200,
      "sha256": "f4bd2a5bd4c99669a5efcbc0edf5326c6f51cf556c3301ae5c8fc2994b913440"
    },
    {
      "path": "bin/ggml-cpu-cannonlake.dll",
      "size": 1692160,
      "sha256": "b6a69981682c6e9dfb5fefcfc3677b9e17c112c3c33fc9d59405daa618e63304"
    },
    {
      "path": "bin/ggml-cpu-cascadelake.dll",
      "size": 1666048,
      "sha256": "488337fb896ac54ec8a74a5e8163b48d8ec4c8e082da4bbb62ebe52139d3b3d8"
    },
    {
      "path": "bin/ggml-cpu-cooperlake.dll",
      "size": 1675264,
      "sha256": "7d30660f15d288d6da7c1d99ae8418c46f61d1d5036e0082aad6fbf4e461d2bb"
    },
    {
      "path": "bin/ggml-cpu-haswell.dll",
      "size": 1464320,
      "sha256": "26dbcf80225fe3c56aa750501247cebdc99b791f323c33d0d8fcd2ed7c4bafcb"
    },
    {
      "path": "bin/ggml-cpu-icelake.dll",
      "size": 1672192,
      "sha256": "0a35f7a655bb74ce2d64cbb64e6817b17f62964b060c6a503d3267b2133199bc"
    },
    {
      "path": "bin/ggml-cpu-ivybridge.dll",
      "size": 1345536,
      "sha256": "2e83b2aa5ad108445a599fcdd46fafcb227a3d2d66743994434b0bcaacb5a714"
    },
    {
      "path": "bin/ggml-cpu-piledriver.dll",
      "size": 1338880,
      "sha256": "851474816a574847b264e018de02410f5905359934c2fa2411f7ff3d7706620c"
    },
    {
      "path": "bin/ggml-cpu-sandybridge.dll",
      "size": 1314304,
      "sha256": "86b1c9114249492b8d39a1a3d9f9717c8969334a4bd12c279b91248a553cb254"
    },
    {
      "path": "bin/ggml-cpu-sapphirerapids.dll",
      "size": 1952256,
      "sha256": "b049b5672c3c246bb320ec011c735981628a9369687cfd64a4628c5bad238b3b"
    },
    {
      "path": "bin/ggml-cpu-skylakex.dll",
      "size": 1686016,
      "sha256": "183413744426f596c67fb206daf2cab17d666e22076e4a6b9a25d301de871d85"
    },
    {
      "path": "bin/ggml-cpu-sse42.dll",
      "size": 937472,
      "sha256": "5b2f04b3ab1e76b09d887c496eb61b09a0ee4fc77b28c0602e45411906946ccd"
    },
    {
      "path": "bin/ggml-cpu-x64.dll",
      "size": 930304,
      "sha256": "375434294cb7d22de0bf5da68fe67569fb5f8ca2c11e925850c8be3f52d052fe"
    },
    {
      "path": "bin/ggml-cpu-zen4.dll",
      "size": 1681920,
      "sha256": "dae5d12772f0213b6d70a3c4db032146b504dea32b1b35bbcc9dff769edf57f7"
    },
    {
      "path": "bin/ggml-rpc.dll",
      "size": 234496,
      "sha256": "2e23f2c0782f5e61428dcc98b905d80fd28c3b9b70304b75c53490c13e1b76d4"
    },
    {
      "path": "bin/ggml-vulkan.dll",
      "size": 42138624,
      "sha256": "9cc0d9416bf032caa58af66fc7fe700e35a476b74cab94fcb45e08f4eca8213c"
    },
    {
      "path": "bin/ggml.dll",
      "size": 78848,
      "sha256": "92b081cfb031e2efe5cd2a8c71c872e8a92cb1d4a43619ad6614dc30ad357b80"
    },
    {
      "path": "bin/libomp.dll",
      "size": 768000,
      "sha256": "a12116ba72d1d6820407cf30be23da04ce79d6bb8a71a5ee71759c5a1faa6f1c"
    },
    {
      "path": "bin/llama-server.exe",
      "size": 18896547,
      "sha256": "2b614e1439fbdf5e16e94268077e8a356886ca1c219062ef85353a1c1f334d7d"
    }
  ],
  "files": [
    {
      "path": "LICENSE",
      "size": 1078,
      "sha256": "94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d"
    },
    {
      "path": "cpu/LICENSE-LLVM-OpenMP",
      "size": 19741,
      "sha256": "fdad1758a9e1f9d5a81e18879b3406772115edc92c24bfa36b70c654f325e8e4"
    },
    {
      "path": "cpu/ggml-base.dll",
      "size": 832000,
      "sha256": "20e4986ec6fd88eb61630433ff172e08885f8fecfbd0c1960a5d55c8854019e3"
    },
    {
      "path": "cpu/ggml-cpu-alderlake.dll",
      "size": 1459200,
      "sha256": "f4bd2a5bd4c99669a5efcbc0edf5326c6f51cf556c3301ae5c8fc2994b913440"
    },
    {
      "path": "cpu/ggml-cpu-cannonlake.dll",
      "size": 1692160,
      "sha256": "b6a69981682c6e9dfb5fefcfc3677b9e17c112c3c33fc9d59405daa618e63304"
    },
    {
      "path": "cpu/ggml-cpu-cascadelake.dll",
      "size": 1666048,
      "sha256": "488337fb896ac54ec8a74a5e8163b48d8ec4c8e082da4bbb62ebe52139d3b3d8"
    },
    {
      "path": "cpu/ggml-cpu-cooperlake.dll",
      "size": 1675264,
      "sha256": "7d30660f15d288d6da7c1d99ae8418c46f61d1d5036e0082aad6fbf4e461d2bb"
    },
    {
      "path": "cpu/ggml-cpu-haswell.dll",
      "size": 1464320,
      "sha256": "26dbcf80225fe3c56aa750501247cebdc99b791f323c33d0d8fcd2ed7c4bafcb"
    },
    {
      "path": "cpu/ggml-cpu-icelake.dll",
      "size": 1672192,
      "sha256": "0a35f7a655bb74ce2d64cbb64e6817b17f62964b060c6a503d3267b2133199bc"
    },
    {
      "path": "cpu/ggml-cpu-ivybridge.dll",
      "size": 1345536,
      "sha256": "2e83b2aa5ad108445a599fcdd46fafcb227a3d2d66743994434b0bcaacb5a714"
    },
    {
      "path": "cpu/ggml-cpu-piledriver.dll",
      "size": 1338880,
      "sha256": "851474816a574847b264e018de02410f5905359934c2fa2411f7ff3d7706620c"
    },
    {
      "path": "cpu/ggml-cpu-sandybridge.dll",
      "size": 1314304,
      "sha256": "86b1c9114249492b8d39a1a3d9f9717c8969334a4bd12c279b91248a553cb254"
    },
    {
      "path": "cpu/ggml-cpu-sapphirerapids.dll",
      "size": 1952256,
      "sha256": "b049b5672c3c246bb320ec011c735981628a9369687cfd64a4628c5bad238b3b"
    },
    {
      "path": "cpu/ggml-cpu-skylakex.dll",
      "size": 1686016,
      "sha256": "183413744426f596c67fb206daf2cab17d666e22076e4a6b9a25d301de871d85"
    },
    {
      "path": "cpu/ggml-cpu-sse42.dll",
      "size": 937472,
      "sha256": "5b2f04b3ab1e76b09d887c496eb61b09a0ee4fc77b28c0602e45411906946ccd"
    },
    {
      "path": "cpu/ggml-cpu-x64.dll",
      "size": 930304,
      "sha256": "375434294cb7d22de0bf5da68fe67569fb5f8ca2c11e925850c8be3f52d052fe"
    },
    {
      "path": "cpu/ggml-cpu-zen4.dll",
      "size": 1681920,
      "sha256": "dae5d12772f0213b6d70a3c4db032146b504dea32b1b35bbcc9dff769edf57f7"
    },
    {
      "path": "cpu/ggml-rpc.dll",
      "size": 234496,
      "sha256": "2e23f2c0782f5e61428dcc98b905d80fd28c3b9b70304b75c53490c13e1b76d4"
    },
    {
      "path": "cpu/ggml.dll",
      "size": 78848,
      "sha256": "92b081cfb031e2efe5cd2a8c71c872e8a92cb1d4a43619ad6614dc30ad357b80"
    },
    {
      "path": "cpu/libomp.dll",
      "size": 768000,
      "sha256": "a12116ba72d1d6820407cf30be23da04ce79d6bb8a71a5ee71759c5a1faa6f1c"
    },
    {
      "path": "cpu/llama-batched-bench-impl.dll",
      "size": 62464,
      "sha256": "85d22b25ca93b0cb313d69a05b945bf7775940d1074adff45bd0103cc4e070d7"
    },
    {
      "path": "cpu/llama-bench-impl.dll",
      "size": 406016,
      "sha256": "a95e01d0445dfeea1ecc64633adeba15189b02a6a1b6f04e003a654d4b7c6a31"
    },
    {
      "path": "cpu/llama-cli-impl.dll",
      "size": 3398656,
      "sha256": "67ede23b0e9abd29bbfdd5440df5085c55727344f77d1b8959bcec26fa67f813"
    },
    {
      "path": "cpu/llama-common.dll",
      "size": 8507904,
      "sha256": "a0e0b993dede7c95eb1ca79cdcc2a003f2f79ff59fc129cb46ec5daac80fd057"
    },
    {
      "path": "cpu/llama-completion-impl.dll",
      "size": 139264,
      "sha256": "f81f830e1e862a955cccbcc64bb24239794251a548b8d0a6147d33db16f25463"
    },
    {
      "path": "cpu/llama-fit-params-impl.dll",
      "size": 48128,
      "sha256": "b2f8f12f59f7176adc0269a94dde0bc42209ad8d8ea853917695a304dfbf99f1"
    },
    {
      "path": "cpu/llama-perplexity-impl.dll",
      "size": 198144,
      "sha256": "14862a589913098cb341c7588783cba38053f774f2ec9933374f5609a542dd07"
    },
    {
      "path": "cpu/llama-quantize-impl.dll",
      "size": 141312,
      "sha256": "4007bb641487b7baa431ba120eefb6240d0c7c1930c3908aa4587c8f4fdb6fa3"
    },
    {
      "path": "cpu/llama-server-impl.dll",
      "size": 10343424,
      "sha256": "c81c23738405831cacda737e64ce8f08870d4f44beb63e3aa9515b3ad2e4286e"
    },
    {
      "path": "cpu/llama-server.exe",
      "size": 18896547,
      "sha256": "2b614e1439fbdf5e16e94268077e8a356886ca1c219062ef85353a1c1f334d7d"
    },
    {
      "path": "cpu/llama.dll",
      "size": 3868672,
      "sha256": "17b0063b06c4561f46929a809a60bf60c857783bb22f593528145cc1e1108d7d"
    },
    {
      "path": "cpu/mtmd.dll",
      "size": 2244096,
      "sha256": "558d7c41475cc6f54d6da41eea23876cd35cfd2e9d8f2b3e637b8c49c9928ed5"
    },
    {
      "path": "patches/llama-qwen3-action-schema.patch",
      "size": 28852,
      "sha256": "11ca5c95dca4ad276c43a65a9a83e14b047739a94ba74e3e4dc53c540fa8b62b"
    },
    {
      "path": "patches/llama-qwen3-io-compat.patch",
      "size": 5782,
      "sha256": "4f8dff442a969b24901c5dc47882a782f3407d1e927b510430a3fcbf209188f9"
    },
    {
      "path": "patches/llama-qwen3-object-schema.patch",
      "size": 11999,
      "sha256": "a6fff69ceb855441099a9bedc59c4e00aacbfa0b169d2a305e23a0eb3dfae088"
    },
    {
      "path": "vulkan/LICENSE-LLVM-OpenMP",
      "size": 19741,
      "sha256": "fdad1758a9e1f9d5a81e18879b3406772115edc92c24bfa36b70c654f325e8e4"
    },
    {
      "path": "vulkan/ggml-base.dll",
      "size": 832000,
      "sha256": "20e4986ec6fd88eb61630433ff172e08885f8fecfbd0c1960a5d55c8854019e3"
    },
    {
      "path": "vulkan/ggml-cpu-alderlake.dll",
      "size": 1459200,
      "sha256": "f4bd2a5bd4c99669a5efcbc0edf5326c6f51cf556c3301ae5c8fc2994b913440"
    },
    {
      "path": "vulkan/ggml-cpu-cannonlake.dll",
      "size": 1692160,
      "sha256": "b6a69981682c6e9dfb5fefcfc3677b9e17c112c3c33fc9d59405daa618e63304"
    },
    {
      "path": "vulkan/ggml-cpu-cascadelake.dll",
      "size": 1666048,
      "sha256": "488337fb896ac54ec8a74a5e8163b48d8ec4c8e082da4bbb62ebe52139d3b3d8"
    },
    {
      "path": "vulkan/ggml-cpu-cooperlake.dll",
      "size": 1675264,
      "sha256": "7d30660f15d288d6da7c1d99ae8418c46f61d1d5036e0082aad6fbf4e461d2bb"
    },
    {
      "path": "vulkan/ggml-cpu-haswell.dll",
      "size": 1464320,
      "sha256": "26dbcf80225fe3c56aa750501247cebdc99b791f323c33d0d8fcd2ed7c4bafcb"
    },
    {
      "path": "vulkan/ggml-cpu-icelake.dll",
      "size": 1672192,
      "sha256": "0a35f7a655bb74ce2d64cbb64e6817b17f62964b060c6a503d3267b2133199bc"
    },
    {
      "path": "vulkan/ggml-cpu-ivybridge.dll",
      "size": 1345536,
      "sha256": "2e83b2aa5ad108445a599fcdd46fafcb227a3d2d66743994434b0bcaacb5a714"
    },
    {
      "path": "vulkan/ggml-cpu-piledriver.dll",
      "size": 1338880,
      "sha256": "851474816a574847b264e018de02410f5905359934c2fa2411f7ff3d7706620c"
    },
    {
      "path": "vulkan/ggml-cpu-sandybridge.dll",
      "size": 1314304,
      "sha256": "86b1c9114249492b8d39a1a3d9f9717c8969334a4bd12c279b91248a553cb254"
    },
    {
      "path": "vulkan/ggml-cpu-sapphirerapids.dll",
      "size": 1952256,
      "sha256": "b049b5672c3c246bb320ec011c735981628a9369687cfd64a4628c5bad238b3b"
    },
    {
      "path": "vulkan/ggml-cpu-skylakex.dll",
      "size": 1686016,
      "sha256": "183413744426f596c67fb206daf2cab17d666e22076e4a6b9a25d301de871d85"
    },
    {
      "path": "vulkan/ggml-cpu-sse42.dll",
      "size": 937472,
      "sha256": "5b2f04b3ab1e76b09d887c496eb61b09a0ee4fc77b28c0602e45411906946ccd"
    },
    {
      "path": "vulkan/ggml-cpu-x64.dll",
      "size": 930304,
      "sha256": "375434294cb7d22de0bf5da68fe67569fb5f8ca2c11e925850c8be3f52d052fe"
    },
    {
      "path": "vulkan/ggml-cpu-zen4.dll",
      "size": 1681920,
      "sha256": "dae5d12772f0213b6d70a3c4db032146b504dea32b1b35bbcc9dff769edf57f7"
    },
    {
      "path": "vulkan/ggml-rpc.dll",
      "size": 234496,
      "sha256": "2e23f2c0782f5e61428dcc98b905d80fd28c3b9b70304b75c53490c13e1b76d4"
    },
    {
      "path": "vulkan/ggml-vulkan.dll",
      "size": 42138624,
      "sha256": "9cc0d9416bf032caa58af66fc7fe700e35a476b74cab94fcb45e08f4eca8213c"
    },
    {
      "path": "vulkan/ggml.dll",
      "size": 78848,
      "sha256": "92b081cfb031e2efe5cd2a8c71c872e8a92cb1d4a43619ad6614dc30ad357b80"
    },
    {
      "path": "vulkan/libomp.dll",
      "size": 768000,
      "sha256": "a12116ba72d1d6820407cf30be23da04ce79d6bb8a71a5ee71759c5a1faa6f1c"
    },
    {
      "path": "vulkan/llama-batched-bench-impl.dll",
      "size": 62464,
      "sha256": "85d22b25ca93b0cb313d69a05b945bf7775940d1074adff45bd0103cc4e070d7"
    },
    {
      "path": "vulkan/llama-bench-impl.dll",
      "size": 406016,
      "sha256": "a95e01d0445dfeea1ecc64633adeba15189b02a6a1b6f04e003a654d4b7c6a31"
    },
    {
      "path": "vulkan/llama-cli-impl.dll",
      "size": 3398656,
      "sha256": "67ede23b0e9abd29bbfdd5440df5085c55727344f77d1b8959bcec26fa67f813"
    },
    {
      "path": "vulkan/llama-common.dll",
      "size": 8507904,
      "sha256": "a0e0b993dede7c95eb1ca79cdcc2a003f2f79ff59fc129cb46ec5daac80fd057"
    },
    {
      "path": "vulkan/llama-completion-impl.dll",
      "size": 139264,
      "sha256": "f81f830e1e862a955cccbcc64bb24239794251a548b8d0a6147d33db16f25463"
    },
    {
      "path": "vulkan/llama-fit-params-impl.dll",
      "size": 48128,
      "sha256": "b2f8f12f59f7176adc0269a94dde0bc42209ad8d8ea853917695a304dfbf99f1"
    },
    {
      "path": "vulkan/llama-perplexity-impl.dll",
      "size": 198144,
      "sha256": "14862a589913098cb341c7588783cba38053f774f2ec9933374f5609a542dd07"
    },
    {
      "path": "vulkan/llama-quantize-impl.dll",
      "size": 141312,
      "sha256": "4007bb641487b7baa431ba120eefb6240d0c7c1930c3908aa4587c8f4fdb6fa3"
    },
    {
      "path": "vulkan/llama-server-impl.dll",
      "size": 10343424,
      "sha256": "c81c23738405831cacda737e64ce8f08870d4f44beb63e3aa9515b3ad2e4286e"
    },
    {
      "path": "vulkan/llama-server.exe",
      "size": 18896547,
      "sha256": "2b614e1439fbdf5e16e94268077e8a356886ca1c219062ef85353a1c1f334d7d"
    },
    {
      "path": "vulkan/llama.dll",
      "size": 3868672,
      "sha256": "17b0063b06c4561f46929a809a60bf60c857783bb22f593528145cc1e1108d7d"
    },
    {
      "path": "vulkan/mtmd.dll",
      "size": 2244096,
      "sha256": "558d7c41475cc6f54d6da41eea23876cd35cfd2e9d8f2b3e637b8c49c9928ed5"
    }
  ]
});
export const LLAMA_RUNTIME_PIN = Object.freeze({
  release:'b12359', sourceCommit:LLAMA_RUNTIME_COMMIT, stableRelease:'v1.0.0',
  cpu:{name:'llama-b12359-bin-win-cpu-x64.zip',size:25097509,sha256:'837c1655e87df3b66989f4be33a792a1399c785bf259038dc75c900096683e69'},
  vulkan:{name:'llama-b12359-bin-win-vulkan-x64.zip',size:38090643,sha256:'e8d18c6e4210cca87e7307c2ea78363ac8d158e4e1397358ec96ab70b53a0d5e'},
});
export const LLAMA_PATCH_NAMES = Object.freeze(['llama-qwen3-object-schema.patch','llama-qwen3-io-compat.patch','llama-qwen3-action-schema.patch']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => Object.assign(Error(message),{code:'LLAMA_BUNDLE_INTEGRITY'});
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const fileIdentity = value => plain(value) && Number.isSafeInteger(value.size) && value.size >= 0 && /^[a-f0-9]{64}$/.test(value.sha256 || '');
const safeName = name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
const runtimePath = value => value === 'LICENSE' || typeof value === 'string' && value.split('/').length === 2 && (
  ['cpu','vulkan'].includes(value.split('/')[0]) && safeName(value.split('/')[1]) && (/\.dll$/.test(value) || value.endsWith('/llama-server.exe') || value.split('/')[1].startsWith('LICENSE')) ||
  value.split('/')[0] === 'patches' && LLAMA_PATCH_NAMES.includes(value.split('/')[1]));
const repairPath = value => typeof value === 'string' && /^bin\/[^/]+$/.test(value) && safeName(value.slice(4)) && (value === 'bin/llama-server.exe' || value.endsWith('.dll'));
const records = (values, validPath) => {
  if (!Array.isArray(values) || !values.length) throw fail('The runtime file inventory is missing.');
  const seen = new Set();
  return values.map(value => {
    if (!fileIdentity(value) || !validPath(value.path) || seen.has(value.path.toLowerCase())) throw fail('The runtime file inventory contains an invalid or duplicate path.');
    seen.add(value.path.toLowerCase());
    return {path:value.path,size:value.size,sha256:value.sha256};
  }).sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
};
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function validateLlamaRepairPin(pin) {
  if (!plain(pin)) throw Object.assign(Error('The repaired bundled runtime has not been qualified. Supply the accepted QX3 pins before packaging or execution.'),{code:'LLAMA_REPAIR_UNQUALIFIED'});
  if (pin.runtimeId !== LLAMA_RUNTIME_ID || pin.sourceCommit !== LLAMA_RUNTIME_COMMIT || pin.release !== 'b12359' ||
      !fileIdentity(pin.sourceArchive) || !fileIdentity(pin.buildManifest) || pin.buildManifest.schema !== 'blackice.minicpm.qx3.bundle.v1' ||
      !fileIdentity(pin.executable) || pin.executable.size <= 0) throw fail('The runtime repair provenance is invalid.');
  const artifact=pin.repairArchive;
  let url;try{url=new URL(artifact?.url);}catch{throw fail('The portable repair archive URL is invalid.');}
  const parts=url.pathname.split('/'),tag=parts[5];
  if (!fileIdentity(artifact) || artifact.size<=0 || artifact.name!==pin.runtimeId+'.zip' ||
      url.origin!=='https://github.com' || url.username || url.password || url.search || url.hash ||
      ![pin.runtimeId,'runtime-'+pin.runtimeId].includes(tag) ||
      url.pathname!=='/MoonlightClarity/BLACKICE/releases/download/'+tag+'/'+artifact.name)
    throw fail('The repair archive must be a pinned, dedicated BLACKICE runtime asset.');
  for (const backend of ['cpu','vulkan']) {
    const asset = pin.archives?.[backend];
    if (!fileIdentity(asset) || asset.size <= 0 || asset.name !== LLAMA_RUNTIME_PIN[backend].name) throw fail('The official runtime archive identity is invalid.');
  }
  if (!Array.isArray(pin.patches) || pin.patches.length !== LLAMA_PATCH_NAMES.length) throw fail('All reviewed source patches are required.');
  const patches = LLAMA_PATCH_NAMES.map(name => {
    const matching = pin.patches.filter(item=>item?.name === name);
    if (matching.length !== 1 || !fileIdentity(matching[0]) || matching[0].size <= 0) throw fail('A reviewed source patch identity is invalid.');
    return {name,size:matching[0].size,sha256:matching[0].sha256};
  });
  const repairFiles = records(pin.repairFiles,repairPath), files = records(pin.files,runtimePath);
  if (repairFiles.length !== 20 || repairFiles.filter(file=>file.path.endsWith('.dll')).length !== 19) throw fail('The repair bundle must contain its complete twenty-file runtime closure.');
  const matchesExecutable = file => file && file.size === pin.executable.size && file.sha256 === pin.executable.sha256;
  if (!matchesExecutable(repairFiles.find(file=>file.path === 'bin/llama-server.exe'))) throw fail('The repair executable does not match its accepted identity.');
  for (const backend of ['cpu','vulkan']) if (!matchesExecutable(files.find(file=>file.path === backend+'/llama-server.exe'))) throw fail('Both backend variants must contain the same accepted repaired executable.');
  if (!files.some(file=>file.path === 'LICENSE')) throw fail('The runtime license is missing from the trusted inventory.');
  for (const patch of patches) {
    const file = files.find(file=>file.path === 'patches/'+patch.name);
    if (!file || file.size !== patch.size || file.sha256 !== patch.sha256) throw fail('The shipped patch does not match its accepted identity.');
  }
  return {
    runtimeId:pin.runtimeId,sourceCommit:pin.sourceCommit,release:pin.release,
    sourceArchive:{size:pin.sourceArchive.size,sha256:pin.sourceArchive.sha256},
    buildManifest:{schema:pin.buildManifest.schema,size:pin.buildManifest.size,sha256:pin.buildManifest.sha256},
    executable:{size:pin.executable.size,sha256:pin.executable.sha256},
    repairArchive:{name:artifact.name,url:artifact.url,size:artifact.size,sha256:artifact.sha256},
    archives:Object.fromEntries(['cpu','vulkan'].map(backend=>[backend,{name:pin.archives[backend].name,size:pin.archives[backend].size,sha256:pin.archives[backend].sha256}])),
    patches,repairFiles,files,
  };
}

/** Verify the portable build manifest against source-pinned identities, never its own claims. */
export function verifyLlamaRepairManifest(bytes, repairPin) {
  const pin = validateLlamaRepairPin(repairPin);
  if (!Buffer.isBuffer(bytes) || bytes.length !== pin.buildManifest.size || digest(bytes) !== pin.buildManifest.sha256)
    throw fail('The portable repair manifest does not match its accepted bytes.');
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { throw fail('The portable repair manifest is invalid JSON.'); }
  const keys = (value,names) => plain(value) && same(Object.keys(value).sort(),[...names].sort());
  if (!keys(manifest,['schema','runtimeId','sourceCommit','release','archive','patches','files']) ||
      manifest.schema !== pin.buildManifest.schema || manifest.runtimeId !== pin.runtimeId ||
      manifest.sourceCommit !== pin.sourceCommit || manifest.release !== pin.release ||
      !keys(manifest.archive,['bytes','sha256']) || manifest.archive.bytes !== pin.sourceArchive.size ||
      manifest.archive.sha256 !== pin.sourceArchive.sha256)
    throw fail('The portable repair manifest has unexpected or mismatched provenance.');
  if (!Array.isArray(manifest.files) || manifest.files.some(file=>
      !keys(file,['name','relativePath','bytes','sha256']) || typeof file.relativePath !== 'string' ||
      file.name !== path.posix.basename(file.relativePath)) ||
      !same(records(manifest.files.map(file=>({path:file.relativePath,size:file.bytes,sha256:file.sha256})),repairPath),pin.repairFiles))
    throw fail('The portable repair manifest does not match the accepted twenty-file closure.');
  if (!Array.isArray(manifest.patches) || manifest.patches.length !== LLAMA_PATCH_NAMES.length ||
      manifest.patches.some(patch=>!keys(patch,['name','bytes','sha256'])))
    throw fail('The portable repair manifest must identify all reviewed patches.');
  const patches = LLAMA_PATCH_NAMES.map(name=>{
    const matches=manifest.patches.filter(patch=>patch.name===name);
    if(matches.length!==1)throw fail('The portable repair manifest has a missing or duplicate patch.');
    return {name,size:matches[0].bytes,sha256:matches[0].sha256};
  });
  if(!same(patches,pin.patches))throw fail('The portable repair patch identities do not match the accepted patches.');
  return manifest;
}

export function llamaBundleManifest(pin) {
  const accepted = validateLlamaRepairPin(pin);
  const provenance = {
    schema:'blackice.llama-runtime-provenance.v1',runtimeId:accepted.runtimeId,
    upstream:{release:accepted.release,sourceCommit:accepted.sourceCommit,sourceArchive:accepted.sourceArchive,archives:accepted.archives},
    buildManifest:accepted.buildManifest,repairArchive:accepted.repairArchive,patches:accepted.patches,executable:accepted.executable,
  };
  return {schema:'blackice.llama-runtime-bundle.v2',version:LLAMA_BUNDLE_VERSION,runtimeId:accepted.runtimeId,provenance,files:accepted.files};
}
export async function verifyLlamaFileTree(root, expectedFiles, {manifestBytes} = {}) {
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail('The runtime root must be an ordinary directory.');
  const expected = new Map(expectedFiles.map(file=>[file.path,file]));
  if (manifestBytes) expected.set('manifest.json',{path:'manifest.json',size:manifestBytes.length,sha256:digest(manifestBytes)});
  const directories = new Set();
  for (const name of expected.keys()) {
    const parts = name.split('/');
    for (let i=1;i<parts.length;i++) directories.add(parts.slice(0,i).join('/'));
  }
  const visited = new Set();
  async function visit(directory, prefix='') {
    const entries = await fs.readdir(directory,{withFileTypes:true}), names = new Set();
    for (const entry of entries) {
      const relative = prefix+entry.name, key = entry.name.toLowerCase();
      if (names.has(key)) throw fail('The runtime contains case-colliding paths.');
      names.add(key);
      const filename = path.join(directory,entry.name), stat = await fs.lstat(filename);
      if (stat.isSymbolicLink()) throw fail('The runtime contains a linked path.');
      if (stat.isDirectory()) {
        if (!directories.has(relative)) throw fail('The runtime contains an unlisted directory.');
        await visit(filename,relative+'/');
      } else {
        const record = expected.get(relative);
        if (!stat.isFile() || !record || stat.size !== record.size || digest(await fs.readFile(filename)) !== record.sha256) throw fail('The runtime contains an unlisted, missing, or altered file.');
        visited.add(relative);
      }
    }
  }
  await visit(root);
  if (visited.size !== expected.size) throw fail('The runtime is missing a required file.');
}
export function createLlamaBundleVerifier(pin) {
  return async ({root,expected}={}) => {
    const manifest = llamaBundleManifest(pin), bytes = Buffer.from(JSON.stringify(manifest,null,2)+'\n');
    await verifyLlamaFileTree(root,manifest.files,{manifestBytes:bytes});
    const receipt = {
      schema:'blackice.llama-runtime-verification.v1',runtimeId:manifest.runtimeId,version:manifest.version,
      manifest:{size:bytes.length,sha256:digest(bytes)},inventorySha256:digest(JSON.stringify(manifest.files)),
      executable:manifest.provenance.executable,provenance:manifest.provenance,files:manifest.files,
      bytes:manifest.files.reduce((sum,file)=>sum+file.size,0),
    };
    if (expected !== undefined && (!plain(expected) || !same(receipt,expected))) throw fail('The packaged runtime does not match the verified preparation receipt.');
    return receipt;
  };
}
export const verifyLlamaBundle = createLlamaBundleVerifier(LLAMA_RUNTIME_REPAIR_PIN);
// Explicit internal test seam: production callers use the fixed verifier above.
export const llamaBundleTest = Object.freeze({createVerifier:createLlamaBundleVerifier});
export const defaultBundleRoot = () => typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, 'llama.cpp') : null;
export async function inspectLlamaBundle({root = defaultBundleRoot(), platform = process.platform, arch = process.arch, run = execute, verify = verifyLlamaBundle} = {}) {
  const unavailable = message => ({available:false,source:'unavailable',version:LLAMA_BUNDLE_VERSION,runtimeId:LLAMA_RUNTIME_ID,backend:null,message});
  if (platform !== 'win32' || arch !== 'x64') return unavailable('The bundled runtime is available for Windows x64. An existing local server or custom runtime can still be used.');
  if (!root) return unavailable('Bundled runtime unavailable in this development checkout. Prepare the pinned runtime or use a custom executable.');
  let integrity;
  try { integrity = await verify({root}); }
  catch (error) { return unavailable(error.code === 'LLAMA_REPAIR_UNQUALIFIED' ? error.message : 'The bundled runtime failed its integrity check. Repair BLACKICE; model files and settings are untouched.'); }
  const identity = {version:LLAMA_BUNDLE_VERSION,runtimeId:integrity.runtimeId,manifestSha256:integrity.manifest.sha256,inventorySha256:integrity.inventorySha256};
  const cpu = path.join(root,'cpu','llama-server.exe'), vulkan = path.join(root,'vulkan','llama-server.exe');
  try {
    const probe = await run(vulkan,['--list-devices'],{cwd:path.dirname(vulkan),windowsHide:true,timeout:10000,maxBuffer:65536});
    if (/^\s*Vulkan\d+:\s+\S/m.test(probe.stdout || '')) return {available:true,source:'bundled',...identity,backend:'Vulkan',executablePath:vulkan,fallbackPath:cpu,message:'Bundled runtime ready. Compatible Vulkan GPU detected; CPU fallback is included.'};
  } catch { /* Driver absence/failure is ordinary: use the independent CPU dependency set. */ }
  try { await run(cpu,['--version'],{cwd:path.dirname(cpu),windowsHide:true,timeout:10000,maxBuffer:65536}); }
  catch { return unavailable('The bundled CPU runtime cannot start on this computer. Use a compatible custom runtime or external server.'); }
  return {available:true,source:'bundled',...identity,backend:'CPU',executablePath:cpu,message:'Bundled runtime ready. CPU selected because no working Vulkan device was detected.'};
}
