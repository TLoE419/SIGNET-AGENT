# Browser dependency

- markdown-it 15.0.3 (MIT), https://github.com/markdown-it/markdown-it
- Source: https://registry.npmjs.org/markdown-it/-/markdown-it-15.0.3.tgz
- Verified archive SHA-512 (base64): `+Az7Ojz3iRGu8KYMvJ6xVhvrxP3eE+vEtJX75Ow88XBpcQNV/0lGX5ZynIIBftREo4DC2jsveAMDaeltmm8QvQ==`
- Bundled `dist/browser/markdown-it.umd.min.js` at the start of `web/chat.js` and copied `LICENSE`; removed the source-map comment because the map is not shipped. Keeping the existing script URL lets the running server serve the update without restarting active conversations.
- Served locally. Raw HTML and Markdown images are disabled; links use the library's default protocol validation. No syntax highlighting or math extensions.

Stage 6 graph viewer: vis-network is copied from the pinned official SIGNET export (vis-network 9.1.0 bundle). Original dual MIT/Apache copyright notice is retained. One CSP compatibility change replaces the regenerator global fallback using Function() with globalThis assignment; no eval permission is added.
