# Demonstration Without Bundled Data

This guide replaces the live demonstration script that depended on specific historical run IDs. It describes the current downloadable version.

## Basic Demonstration

1. Follow the [installation guide](INSTALL.md), start the service, and open the [chat page](http://127.0.0.1:8880). Confirm that model sign-in or a key is configured.
2. Select English and enter: "Describe the analyses currently available and the data each requires. Do not run anything yet." Expect only an explanation of capabilities and input requirements.
3. Enter: "Check which data files and run records are in the current project. Do not run an analysis." A clean download has no data or historical results; the assistant should report the files actually present.
4. Enter: "Open the Stage 6 workspace and query its current status only. Do not change parameters or run anything." The right-hand workspace should report that no verified baseline is available, without displaying a fabricated example graph.
5. Inspect **Activity**, which opens automatically below the conversation. Confirm that status, elapsed time, and tool records are visible. Collapse and reopen it after completion; the records should remain. This does not require opening Stage 6. Listing filenames does not establish that their contents have been read or verified.

This procedure calls a real model, whose wording may vary. Acceptance depends on actual tool status and the correctness of the content.

## After You Have Your Own Results

First follow the [advanced guide](ADVANCED.md) to configure the official source, runtime, and input data. Complete Stage 6 and pass the technical output checks, then:

1. Select your own completed result as the workspace baseline.
2. Use natural language to request a frequency-threshold or displayed-subnetwork-count change, preparing a proposal only.
3. Check the before and after values, then confirm and run it yourself. Use a new working directory and retain the baseline.
4. After completion, compare edge and gene counts, shared, added, and removed edges, and the network graph.

This project includes none of these datasets, completed results, chat records, or predefined baseline IDs. Analysis speed depends on the environment, and external annotation services may be required. Passing technical checks does not establish biological validity.
