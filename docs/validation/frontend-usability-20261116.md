# Frontend task walkthrough — 2026-11-16

Tested the running macOS Electron app on `main` (`1dfd55b`) with the current, uncommitted frontend changes. This is an agent-operated task walkthrough and regression test, not participant research, a VoiceOver audit, or a scientific-analysis validation. Outcomes below are observed task results; they are not population success rates or satisfaction scores.

## Tasks and observed results

| Task | Observation before correction | Retest |
| --- | --- | --- |
| Switch the interface to Traditional Chinese | Main chat translated, but welcome instructions displayed literal `<br>` text. | Instructions contain a real line break. |
| Prepare HPC3 while disconnected | Workflow names the missing connection, but its instruction and Check again error remained English. | Both messages are now Chinese in Chinese mode. No SSH connection or remote work was started. |
| Open HPC3 settings and cancel with Escape | Dialog closed, but keyboard focus fell back to the page. | Focus returns to the HPC3 settings button. |
| Compose without submitting | Shift+Enter left the text in the composer; it did not start a request. | Passed by native keyboard interaction. Physical IME composition was not tested. |
| Start a new chat, then return to an unsent draft | The original draft disappeared without warning. | Draft restored after navigating to another chat and back. A different chat starts with an empty composer. |
| Send a short, non-scientific request | Busy state appeared, Send and chat navigation were disabled, and Activity showed progress. | Real model returned `介面測試完成` in 4.1 seconds; recorded tool-call count was zero. This is one observed response time, not a performance benchmark. |
| Reload and recover a completed conversation | Completed conversation was available after reload. | Test request and reply remained visible; Activity reported restored conversation. |

The task request explicitly asked the model to reply with the test phrase and not call tools or run analysis. No study data, credentials, HPC files, remote downloads, or Slurm submissions were used. The test conversation remains in local history. The temporary test draft was cleared; the UI was left in Chinese with Workflow collapsed.

## Corrections

- Keep unsent drafts in window-scoped session storage, keyed by conversation. Clear the stored draft on submit. If storage is unavailable, warn before navigating away with unsent text. This does not promise draft recovery after quitting the app.
- Restore the actual trigger's focus when the shared native dialog unmounts.
- Convert legacy `<br>` markers to line breaks in Chinese UI labels without enabling HTML rendering.
- Translate the two observed disconnected-workflow instructions through the existing dictionary.

## Verification

All 119 existing Electron tests passed, including type checking. The chat-progress and translation logic checks also passed.

`npm run test:ux --prefix electron` passed against real Electron/Chromium with isolated state and controlled responses. It covers:

- 1320×900, 1000×700, minimum 760×540 windows, and 200% zoom;
- new-chat/history/language access and hidden visualization entry;
- keyboard skip link;
- per-conversation drafts across real page navigation;
- Chinese line breaks;
- Escape and focus restoration for an unmounted settings dialog;
- preserving dialog focus when a chat response finishes.

The regression test uses a controlled chat response; the manual task walkthrough above separately exercised the real configured model.

## Remaining findings and untested paths

1. **High impact — incomplete primary workflow:** Preprocessing and Analysis/results still say “Not available in this version.” The backend step API exists, but this UI cannot complete that analysis workflow. Do not interpret this walkthrough as end-to-end analysis acceptance.
2. **Medium impact — mixed-language settings:** SSH, HPC3 and model settings still contain English labels and explanations in Chinese mode. Only the two observed Workflow messages were localized in this correction.
3. **Low impact — empty chat names:** Empty conversations appear with shortened IDs, making them difficult to distinguish. A descriptive localized empty-chat label would be clearer.
4. Not exercised: real authentication/Duo, credential changes, file-picker selections against HPC3, scheduler cancellation/retry, large histories, screen-reader speech, or physical IME composition. These require suitable sessions/data or a separate test setup. No usability claim is made for them.

## Visual follow-up and final verification

The user subsequently reviewed the actual spacing and SSH control. The final UI:

- shares content insets across Workflow, activity and composer;
- keeps only the stages list scrolling inside expanded Workflow;
- prevents setup content from shrinking the composer;
- aligns settings actions and removes duplicate connection-form indentation;
- preserves a centered SSH switch thumb without the global button minimum height stretching its track;
- uses the accepted SSH design: protocol badge beside the name when expanded, SSH text beside the compact chevron when collapsed, and a centered status light.

Real Electron regression checks assert the content edges align, expanded regions do not overlap, the composer retains its height, the switch thumb is centered and model actions fit their content edge. Final verification passed: all 119 Electron tests, the real Electron UX test, and all four standalone renderer checks (chat progress, i18n, Stage 6 graphs and Markdown).
