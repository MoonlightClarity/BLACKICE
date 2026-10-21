# Third-party notices

Copyright 2026 BLACKICE

BLACKICE-authored portions are licensed under the [Apache License, Version 2.0](LICENSE). Bundled third-party software, data, reference material, and fonts retain their own copyright notices and license terms. The project license does not replace those terms.

This file indexes the preserved notices and provenance records. It is not a substitute for the complete license texts in those files and does not modify them.

## Browser request filtering

| Component | License and preserved material |
| --- | --- |
| Ghostery adblocker 2.20.1 and its bundled `@remusao` libraries | Mozilla Public License 2.0. Complete notices and license texts are retained in [ADBLOCK-NOTICES.md](lib/vendor/ADBLOCK-NOTICES.md). The exact original source files are preserved in [adblock-source.json](lib/vendor/adblock-source.json). |
| `tldts` components included in the filtering bundle | MIT. Their copyright notices and license text are retained in [ADBLOCK-NOTICES.md](lib/vendor/ADBLOCK-NOTICES.md), with the original sources in [adblock-source.json](lib/vendor/adblock-source.json). |
| EasyList and EasyPrivacy snapshots | Distributed under CC BY-SA 3.0, the option selected in the existing bundled notices. Attribution: **The EasyList authors**, <https://easylist.to/>. Original list comments, source URLs, retrieval metadata, and integrity digests are retained in [adblock-filter-data.json](lib/vendor/adblock-filter-data.json) and [ADBLOCK-NOTICES.md](lib/vendor/ADBLOCK-NOTICES.md). |

The source archive in `adblock-source.json` stores its original `records` and `files` objects in the `data` field, encoded as base64-compressed gzip. Decoding that field and decompressing it exposes the preserved source files and their licenses. The filter-list snapshots use a separate losslessly compressed bundle. Preserve both bundles and their notices when redistributing these components.

The Apache license for BLACKICE-authored integration code does not change the MPL, MIT, or CC BY-SA terms of these bundled components. [BROWSER-PROTECTION.md](BROWSER-PROTECTION.md) describes the integration and its source provenance.

## Catalyst reference catalog

The bundled catalog is derived from [Catalyst](https://github.com/MoonlightClarity/Catalyst), pinned to commit `1c50eea56ea4c05de8055084583145882dc8d302`, under Apache License 2.0.

Preserved material:

- [LICENSE.txt](lib/vendor/catalyst/LICENSE.txt): upstream license text.
- [NOTICE.md](lib/vendor/catalyst/NOTICE.md): attribution, source pin, and BLACKICE adaptation notice.
- [LICENSES.md](lib/vendor/catalyst/LICENSES.md): upstream licensing information.
- [retrieval-manifest.json](lib/vendor/catalyst/retrieval-manifest.json): source-file paths, byte lengths, and integrity digests.
- [catalog.json](lib/vendor/catalyst/catalog.json): the pinned materialized catalog and its source metadata.

Keep the upstream source and attribution files with the catalog. BLACKICE checks the pinned catalog and retrieval-manifest hashes when loading this material.

## PDF processing

The bundled PDF integration uses `@hyzyla/pdfium` 3.0.0 and its PDFium WebAssembly binary.

| Preserved file | Purpose |
| --- | --- |
| [LICENSE-wrapper.md](lib/vendor/pdfium/LICENSE-wrapper.md) | MIT license and notices for the JavaScript wrapper. |
| [LICENSE-PDFium.txt](lib/vendor/pdfium/LICENSE-PDFium.txt) | Preserved PDFium notices, including the BSD notice and accompanying Apache license text. The complete file governs the components it identifies. |
| [provenance.json](lib/vendor/pdfium/provenance.json) | Provenance for the bundled wrapper and PDFium artifacts. |

Retain these files with `index.esm.js` and `pdfium.wasm`. The BLACKICE project license does not relicense the wrapper or the WebAssembly binary.

## Fonts

The bundled font files retain their accompanying Open Font License notices:

| Font files | Preserved notice |
| --- | --- |
| `IBMPlexMono-Regular.ttf`, `IBMPlexMono-Medium.ttf` | [ibmplexmono-OFL.txt](public/assets/fonts/ibmplexmono-OFL.txt) |
| `Oxanium-Variable.ttf` | [oxanium-OFL.txt](public/assets/fonts/oxanium-OFL.txt) |
| `ShareTechMono-Regular.ttf` | [sharetechmono-OFL.txt](public/assets/fonts/sharetechmono-OFL.txt) |

Keep the complete font notices, including any reserved font names, with the corresponding fonts. The project license does not replace these notices.

## Electron and packaged runtime components

The application uses Electron. Binary distributions must retain the license and third-party notice files supplied with the exact Electron runtime being packaged, including the notices for its bundled Chromium and other components. Preserve files such as `LICENSE.electron.txt` and `LICENSES.chromium.html` when provided by that distribution; this index does not replace them.

Build dependencies installed through npm also retain their own licenses. `package-lock.json` records package versions and declared license expressions, but those metadata entries do not replace the complete notices included with packages or binary distributions.

## Redistribution

Include the root [LICENSE](LICENSE), [NOTICE](NOTICE), and this index in source and binary packages. Preserve the third-party license, attribution, source, and provenance files alongside the components they describe. Follow each component's own terms for its redistribution or modification; do not replace upstream notices with the BLACKICE Apache license.
