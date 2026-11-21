# Browser dependency

- markdown-it 15.0.3 (MIT), https://github.com/markdown-it/markdown-it
- Source: https://registry.npmjs.org/markdown-it/-/markdown-it-15.0.3.tgz
- Verified archive SHA-512 (base64): `+Az7Ojz3iRGu8KYMvJ6xVhvrxP3eE+vEtJX75Ow88XBpcQNV/0lGX5ZynIIBftREo4DC2jsveAMDaeltmm8QvQ==`
- Bundled `dist/browser/markdown-it.umd.min.js` at the start of `electron/renderer/features/chat/markdown.js` and copied `LICENSE`; removed the source-map comment because the map is not shipped. The Electron build serves it as a shared chat formatter and includes it in the classic controller bundle.
- Served locally. Raw HTML and Markdown images are disabled; links use the library's default protocol validation. No syntax highlighting or math extensions.
