# Catalyst licensing

Catalyst itself is licensed under the Apache License 2.0. The canonical project license is `LICENSE.txt`.

Catalyst's dependency policy is stricter than its technical requirements: the project rejects dependencies whose package metadata declares GPL, LGPL, or AGPL licensing.

## Direct runtime dependencies

| Dependency | Purpose | License |
| --- | --- | --- |
| React / React DOM | UI | MIT |
| EmbedPDF (`@embedpdf/react-pdf-viewer` 2.15.1) | Active PDF reader and native annotation surface | MIT |
| `docx` | DOCX project export | MIT |
| `pdfmake` | PDF project export | MIT |

## Direct development dependencies

| Dependency | Purpose | License |
| --- | --- | --- |
| React type definitions | TypeScript declarations | MIT |
| TypeScript / TypeScript 6 compatibility package | Compiler/tooling | Apache-2.0 |
| Vite | Build/dev server | MIT |
| Vite React plugin | React build integration | MIT |

## Automated audit

After `npm install`, run `npm run licenses`. Use `npm run licenses -- --full` when a complete rescan is required.

The audit scans the installed npm dependency graph, fails on GPL/LGPL/AGPL identifiers, and surfaces unknown licenses for manual review. Cargo auditing is not applicable to the active Catalyst runtime because the current application has no active `src-tauri` Cargo manifest.

Released distributions should preserve all third-party license and attribution notices required by their resolved dependency graph.