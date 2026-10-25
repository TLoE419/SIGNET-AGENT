# Sanitized Slurm fixtures

Recordings of SIGNET steps and failure experiments on UCI HPC3, one folder per run (`<YYYYMMDD-HHMMSS>_<step>_<label>/`). They are produced by `hpc/baseline/` (Monitor Spec 01) and used as offline test data for the monitor's parser and interpreter (Specs 02–04).

Only sanitized copies belong here. Raw fixtures stay on HPC3, because they contain the user name, lab account, node names and `/pub` paths. Copy them with:

```sh
python3 hpc/baseline/scripts/sanitize_fixture.py fixtures/<run_id> tests/fixtures/slurm/<run_id>
```

See `hpc/baseline/README.md` for the file format. Fixtures are added in the follow-up pull request after the HPC3 runs.
