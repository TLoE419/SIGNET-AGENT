"""Checks a step's input files on HPC3 before submission; prints JSON with counts only.

  gtf PATH
      Whether signet -t can read the annotation: uncompressed, tab-separated, and collapsed
      (gene rows carry transcript_type), since script/gexp_prep/gpos.R keeps only protein_coding
      gene rows and silently finds 0 genes otherwise.

  clinical CLINICAL GENOTYPE_IDS EXPRESSION_IDS CHOICES_JSON [OUT]
      What signet -a (script/adj/adj_adjust.R) will meet in the clinical table, counted only for
      the patients that have both genotype and expression results (the third part of a TCGA
      barcode, as script/adj/adj_gexp.R matches them). SIGNET treats race "not reported" as white,
      drops "american indian or alaska native", and requires exactly the races asian,
      black or african american, and white. Any other race value needs the researcher's choice:
        "not_reported"  treat it as "not reported" (SIGNET then counts it as white);
        "exclude"       leave those patients out, through SIGNET's own removal rule (the copy
                        labels them "american indian or alaska native", the one race
                        adj_adjust.R removes from both expression and genotype data).
      With OUT and no problems, writes a copy with the choices applied and Unix line endings,
      for the run to use; the researcher's file is never changed.

Standalone on purpose: the standard library only and Python 3.6 syntax, because it runs with the
HPC3 login node's system python3 (agent/runtime/signet_jobs.py uploads this file's text).
"""
import json
import os
import sys

REQUIRED_COLUMNS = ('submitter_id', 'race', 'gender')
HANDLED_RACES = {'white': 'white', 'black or african american': 'black or african american', 'asian': 'asian',
                 'not reported': 'white', 'american indian or alaska native': None}
SIGNET_RACES = ('asian', 'black or african american', 'white')
REMOVED = 'american indian or alaska native'
CHOICES = ('not_reported', 'exclude')


def gtf_problem(path):
    with open(path, 'rb') as stream:
        if stream.read(2) == b'\x1f\x8b':
            return 'SIGNET needs an uncompressed GTF. Decompress this file first.'
    with open(path, errors='replace') as stream:
        for number, line in enumerate(stream):
            if number >= 5000:
                break
            if line.startswith('#') or not line.strip():
                continue
            fields = line.rstrip('\n').split('\t')
            if len(fields) != 9:
                return 'This is not a GTF file: rows need 9 tab-separated columns.'
            if fields[2] == 'gene':
                if 'transcript_type' in fields[8]:
                    return None
                return 'This GTF is not collapsed: gene rows have no transcript_type, so signet -t would find 0 genes.'
    return 'This GTF has no gene rows near its start.'


def _patient(barcode):
    parts = barcode.strip().split('-')
    return parts[2] if len(parts) >= 3 else None


def _ids(path):
    with open(path, errors='replace') as stream:
        return {_patient(line.split()[0]) for line in stream if line.strip()} - {None}


def clinical(clinical_path, genotype_ids, expression_ids, choices, out=None):
    with open(clinical_path, encoding='utf-8', errors='replace', newline='') as stream:
        text = stream.read()
    windows = '\r\n' in text
    lines = [line for line in text.replace('\r\n', '\n').replace('\r', '\n').split('\n') if line.strip()]
    if not lines:
        return {'status': 'ok', 'problems': ['The clinical table is empty.'], 'needs_choice': []}
    header = lines[0].split('\t')
    missing = [name for name in REQUIRED_COLUMNS if name not in header]
    if missing:
        return {'status': 'ok', 'problems': ['The clinical table needs tab-separated columns: ' + ', '.join(missing) + '.'],
                'needs_choice': []}
    column = {name: header.index(name) for name in REQUIRED_COLUMNS}
    matched = _ids(genotype_ids) & _ids(expression_ids)
    rows, seen = [], {}
    for line in lines[1:]:
        fields = line.split('\t')
        fields += [''] * (len(header) - len(fields))
        rows.append(fields)
        patient = _patient(fields[column['submitter_id']])
        if patient in matched and patient not in seen:   # adj_adjust.R keeps each patient's first row
            seen[patient] = (fields[column['race']].strip(), fields[column['gender']].strip())
    race, gender, unrecognized = {}, {}, {}
    for value, sex in seen.values():
        label = value or '(blank)'
        race[label] = race.get(label, 0) + 1
        gender[sex or '(blank)'] = gender.get(sex or '(blank)', 0) + 1
        if value not in HANDLED_RACES:
            unrecognized[label] = unrecognized.get(label, 0) + 1
    needs_choice = sorted(label for label in unrecognized if choices.get(label) not in CHOICES)
    after = {}
    for value, _ in seen.values():
        label = value or '(blank)'
        if value in HANDLED_RACES:
            category = HANDLED_RACES[value]
        else:
            category = {'not_reported': 'white', 'exclude': None}.get(choices.get(label), '?')
        if category is not None:
            after[category] = after.get(category, 0) + 1
    problems = []
    absent = len(matched) - len(seen)
    if absent:
        problems.append('{} matched patients are not in the clinical table; signet -a needs every one of them.'.format(absent))
    if not needs_choice and sorted(after) != list(SIGNET_RACES):
        problems.append('After these choices the races are {}; signet -a requires exactly asian, '
                        'black or african american, and white, and would stop.'.format(', '.join(sorted(after)) or 'none'))
    result = {'status': 'ok', 'matched_patients': len(matched), 'race': race, 'gender': gender,
              'unrecognized_race': unrecognized, 'needs_choice': needs_choice, 'races_after': after,
              'problems': problems, 'windows_line_endings': windows,
              'signet_rules': {'not reported': 'counted as white', REMOVED: 'removed'},
              'scope': 'Counts only, for patients with both genotype and expression results.'}
    if out and not problems and not needs_choice:
        mapping = {label: ('not reported' if choice == 'not_reported' else REMOVED)
                   for label, choice in choices.items() if label in unrecognized}
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out + '.partial', 'w', encoding='utf-8', newline='\n') as dest:
            dest.write('\t'.join(header) + '\n')
            for fields in rows:
                label = fields[column['race']].strip() or '(blank)'
                if label in mapping:
                    fields = list(fields)
                    fields[column['race']] = mapping[label]
                dest.write('\t'.join(fields) + '\n')
        os.replace(out + '.partial', out)
        result['written'] = True
    return result


def main():
    try:
        if sys.argv[1] == 'gtf':
            result = {'status': 'ok', 'problem': gtf_problem(sys.argv[2])}
        else:
            choices = json.loads(sys.argv[5])
            if not isinstance(choices, dict):
                raise ValueError('choices')
            result = clinical(sys.argv[2], sys.argv[3], sys.argv[4], choices, sys.argv[6] if len(sys.argv) > 6 else None)
    except (OSError, ValueError, IndexError) as error:
        result = {'status': 'failed', 'error': 'The input could not be checked: {}'.format(type(error).__name__)}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
