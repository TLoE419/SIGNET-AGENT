# Reviewed workspace Agent tools

The model allow-list now exposes `get_workspace_stage(run_id, stage, source='live')`,
`propose_workspace_stage(run_id, stage, source='live')`, and
`propose_workspace_dataset(dataset_id)`. Stage is an integer 1–6. Source must be
`live`; archives cannot become executable runs through these tools.

Status reads the same `workspace_genotype.run_history` and `signet_jobs.STEPS`
used by manual controls. It returns saved state, attempt, job ID, settings,
resource limits and prerequisites; it does not refresh scheduler state or read
matrices. Unknown remains unknown. Stage proposals use the existing manual
review services (including guarded Stage 1 retry). New Stage 1 proposals review
the explicitly selected dataset's saved inputs with `review_dataset`.
Reviews may perform the same read-only remote checks as the manual form; they
never create runs, update settings, submit, retry, cancel or persist authorization.

Every proposal is `needs_review`, `executed: false`, including ready proposals.
Existing-run proposals provide the item 18 navigation contract:
`workspace_action: {version: 1, action: 'view_stage', history_id: 'workspace--<run>', stage}`.
This action is navigation only. The manual form must re-review current values
and use its existing confirmation/submission endpoint. Proposal values are not
an authorization token and are not silently applied to the form. Item 18 owns
consuming navigation; no renderer changes or imports of unfinished modules are
required here. Item 17 may supply identifiers separately; all tools still require
explicit arguments and do not import its module.

Legacy scientific Python functions remain callable by existing application code
and manual services. They are removed from the model schema; dispatching an old
saved scientific tool call yields `needs_review` without calling it. Old network
status dispatch resolves Stage 5 workspace status rather than the standalone
worker. Existing visualization proposal/approval remains supported.

No live scientific execution or biological validation is established by these
tests. The UI geometry is unchanged. No new settings editor or duplicate execution
service is introduced; edits and submission remain in the existing manual form.
