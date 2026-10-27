# Third-Party Sources and Licensing Status

- `web/vendor/`: retains the markdown-it and vis-network license files. See that directory's README for versions and modifications.
- `assets/tokenizers/`: Qwen tokenizer data under Apache 2.0. See that directory's README for the pinned version and hash. No model weights are included.
- `electron/`: uses `ssh2` 1.17.0 under the MIT license for the desktop-owned SSH connection. The pinned package and transitive dependency metadata are recorded in `electron/package-lock.json`.
- Official SIGNET scientific source: not bundled with this project. `scripts/setup_source.py` installs only inventoried code, configuration templates, and upstream license documents from the commit specified by `signet_inventory.json`. It does not install example or study data. Each file must pass the existing SHA-256 check.
- `scripts/advanced/verify_network.cjs`: ports output-verification logic from `desktop/core/results.cjs` in the [desktop history commit](https://github.com/TLoE419/SIGNET-AGENT/blob/cfd64e0ceaeabc6d8aa285285bd991587b8272e0/desktop/core/results.cjs). It retains checks of matrices, command-completion lists, scheduler records, and resampling averages. Desktop export features are removed, and the verifier is a single file using only the Node.js standard library.
  Original verifier SHA-256: `ec6da24f2a94f09d89aa4cb147d28739bbd4ae26eff0633aa26a9a3b2acfb6e2`.

The owner has not yet selected an open-source license for this project itself, so no root LICENSE has been added. Third-party licenses are not presented as the license for the entire project. This decision and confirmation of distribution rights for the ported verifier are prerequisites for a formal public release.

## Terminology

- **README:** source and usage documentation.
- **SHA-256:** the hash used to check that file contents match the pinned source.
- **Node.js:** the runtime executing the JavaScript verifier.
- **LICENSE:** the document specifying usage and distribution rights.
