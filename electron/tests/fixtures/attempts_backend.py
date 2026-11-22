"""Saved retry records only; history_backend forbids every remote operation."""

import copy
import json

import history_backend


def seed(project):
    saved = original_seed(project)
    shared = project / 'runs' / saved['shared']
    current_path = shared / 'steps/genotype.json'
    current = json.loads(current_path.read_text())
    for number, state, missing in ((1, 'failed', ['res/resg/signet_Geno']), (2, 'cancelled', []), (3, 'completed', [])):
        record = copy.deepcopy(current)
        record.update(attempt=number, job_id=str(700 + number), state=state,
                      submitted_at=f'2026-11-10T0{number}:00:00-0800',
                      finished_at=f'2026-11-10T0{number}:05:00-0800',
                      reason=('Required outputs are missing.' if number == 1 else
                              'Slurm confirmed the job was cancelled.' if number == 2 else
                              'Outputs present and logs clean. This is not scientific validation; review the results.'),
                      exit_code='2' if number == 1 else '0' if number == 3 else None,
                      missing_outputs=missing,
                      failure_hints=['Controlled attempt-one failure'] if number == 1 else [],
                      history=[{'state': 'submitted', 'at': f'2026-11-10T0{number}:00:00-0800'},
                               {'state': state, 'at': f'2026-11-10T0{number}:05:00-0800'}])
        record['settings']['mind'] = f'0.{number}'
        record['resources']['cpus'] = number
        record['resources']['mem_gb'] = number * 8
        if number == 3:
            record['outputs'] = ['work/res/resg/signet_Geno', 'work/res/resg/signet_Genotype.sampleID']
            record['previous_job_id'] = '702'
        elif number == 2:
            record['previous_job_id'] = '701'
        filename = 'genotype.json' if number == 3 else f'genotype.attempt{number}.json'
        history_backend.write(shared / 'steps' / filename, record)
    snapshot = json.loads((shared / 'workspace-genotype.json').read_text())
    snapshot['settings']['mind'] = '0.3'
    history_backend.write(shared / 'workspace-genotype.json', snapshot)

    # This belongs to attempt one even though the current result folder exists.
    old_result = shared / 'steps/genotype.attempt1.results/signet_Geno'
    old_result.parent.mkdir(parents=True)
    old_result.write_text('old partial result; never current-attempt evidence\n')

    generic = project / 'runs' / saved['generic']
    base = json.loads((generic / 'steps/expression.json').read_text())
    for number in (1, 3, 4):
        record = copy.deepcopy(base)
        record.update(attempt=number, job_id=str(800 + number),
                      state='cancelled' if number == 3 else 'failed',
                      submitted_at=f'2026-11-11T0{number}:00:00-0800',
                      finished_at=f'2026-11-11T0{number}:10:00-0800',
                      reason=f'Controlled expression attempt {number}',
                      missing_outputs=['res/rest/signet_gexp.data'] if number != 3 else [],
                      failure_hints=[f'Attempt {number} output missing'] if number != 3 else [],
                      exit_code='1' if number != 3 else None,
                      history=[{'state': 'submitted', 'at': f'2026-11-11T0{number}:00:00-0800'},
                               {'state': 'cancelled' if number == 3 else 'failed', 'at': f'2026-11-11T0{number}:10:00-0800'}])
        record['settings']['restrict.tcga'] = str(number)
        record['inputs']['gexp.file'] = f'/saved/expression-attempt-{number}.txt'
        record['resources']['cpus'] = number
        filename = 'expression.json' if number == 4 else f'expression.attempt{number}.json'
        history_backend.write(generic / 'steps' / filename, record)

    # A stray invalid archive is visible as invalid, never merged into another attempt.
    history_backend.write(generic / 'steps/expression.attempt5.json', {
        'run_id': 'unrelated-run', 'step': 'expression', 'attempt': 5,
        'state': 'completed', 'job_id': 'must-not-be-adopted', 'settings': {'restrict.tcga': '99'}})
    return saved


original_seed = history_backend.seed
history_backend.seed = seed


if __name__ == '__main__':
    history_backend.main()
