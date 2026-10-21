# Bundled PDFium runtime

BLACKICE includes the unmodified ESM wrapper and WebAssembly binary from `@hyzyla/pdfium` version **3.0.0**. `provenance.json` records the exact npm archive, published integrity value, SHA-256 values and copied members. The runtime loads these local files directly; it performs no package installation or network download.

Upstream wrapper: https://github.com/hyzyla/pdfium

Wrapper license: `LICENSE-wrapper.md` (MIT).

PDFium project: https://pdfium.googlesource.com/pdfium/

PDFium license text: `LICENSE-PDFium.txt`, retrieved from https://pdfium.googlesource.com/pdfium/+/refs/heads/main/LICENSE on October 18, 2026.

The BLACKICE worker and queue live one directory above this vendor directory. They validate input/page/image bounds, isolate parsing and rendering from the application thread, and stop an operation after its deadline or cancellation. A worker's JavaScript heap limit does not cap WebAssembly memory. PDF content is never opened in a desktop application or executed as application JavaScript.

To update the vendor, verify the new package archive against its published integrity metadata, replace the unmodified wrapper and matching WASM together, retain the upstream licenses, refresh the provenance record, and rerun PDF/document attachment tests on the supported Windows runtime before distributing the change.
