# Demonstration Without Bundled Data

This guide replaces the live demonstration script that depended on specific historical run IDs. It describes the current downloadable version.

## Basic Demonstration

1. Follow the [installation guide](INSTALL.md), start Electron with `npm start --prefix electron`. Confirm that model sign-in or a key is configured.
2. Select English and enter: "Describe the analyses currently available and the data each requires. Do not run anything yet." Expect only an explanation of capabilities and input requirements.
3. Enter: "Check which data files and run records are in the current project. Do not run an analysis." A clean download has no data or historical results; the assistant should report the files actually present.
4. Inspect **Activity**, which opens automatically below the conversation. Confirm that status, elapsed time, and tool records are visible. Collapse and reopen it after completion; the records should remain. Listing filenames does not establish that their contents have been read or verified.

This procedure calls a real model, whose wording may vary. Acceptance depends on actual tool status and the correctness of the content.

## Running the Example Study

With an HPC3 account, follow the [HPC3 guide](HPC3_GUIDE.md): prepare the environment in the Workflow panel, then start an analysis with the official example data. Each stage appears as a confirmation card in the chat; nothing runs until you confirm it. After stage 6 the results card shows the network, SIGNET's plots and the connection table, and offers a download. To change a setting, use **Rerun stage** on a completed card; the original analysis is kept.

Passing technical checks does not establish biological validity.
