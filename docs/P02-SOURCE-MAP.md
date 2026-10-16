# P02 public content provenance

This branch starts at the unchanged P01 commit and reconstructs the final P02 content in one new commit. The following two original commits map many-to-one to that public content commit; their original bytes, authors, dates and parent chains remain in the separate local-only history bundle. Original object IDs below are attribution text, not public ancestors or a promise that the original objects are available remotely.

The new portability policy and its tests are authored by polish (Codex), using the explicit role identity polish@local.invalid. The original authors did not author these new changes.

- Original-Commit: 462f1b6325ebf1248da79cf565ee663d8112e3d4
  Original-Author: TLoE419 <tloemizuchizu@gmail.com>
  Original-Author-Date: 2026-10-13T14:35:38-07:00
  Original-Parents: ae9437f5c1ed35301555ec66fe66f59e8a8b6c4a
  Original-Subject: feat: isolated durable S2 monitoring, recovery, cancellation and bounded logs

- Original-Commit: ca9e1c76322ca9a38847725d08d7e7fe44c4983b
  Original-Author: TLoE419 <tloemizuchizu@gmail.com>
  Original-Author-Date: 2026-10-13T15:04:47-07:00
  Original-Parents: 462f1b6325ebf1248da79cf565ee663d8112e3d4
  Original-Subject: test: separate viewer UI language from Unicode data

The feature content is limited to S2 local monitoring, bounded logs, recovery and cancellation. Remote work, scientific execution and seven original complete-flow checks remain unverified. The only changes relative to final P02 are portable source-tree exclusion, its trusted main/worker wiring and tests, plus the associated configuration and provenance documentation. No later P03-P06 feature is included.

A trusted main process must supply SIGNET_ORIGINAL_SOURCE_ROOT as an existing canonical absolute original-checkout directory without symlink ancestors. The current checkout derives from the policy module location. The renderer cannot supply or alter this policy. Missing context refuses writable startup. The policy checks the declared source roots and local path state; it does not discover undeclared checkouts or claim OS-level race-free filesystem isolation.
