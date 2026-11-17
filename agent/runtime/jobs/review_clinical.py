"""Read-only compatibility check for the official TCGA adjustment inputs."""

import csv
import json
from pathlib import Path
import sys


def review(clinical, genotype_ids, expression_ids):
    def patients(path):
        result = set()
        for line in Path(path).read_text().splitlines():
            fields = line.strip().split('-')
            if len(fields) >= 3 and fields[2]:
                result.add(fields[2])
        return result

    matched = patients(genotype_ids) & patients(expression_ids)
    with Path(clinical).open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream, delimiter='\t')
        columns = reader.fieldnames or []
        records = list(reader)
    result = {'columns': columns, 'rows': len(records), 'matched': len(matched),
              'clinical_matched': 0, 'missing_gender': 0, 'missing_race': 0,
              'unsupported_races': [], 'issues': []}
    missing = [key for key in ('submitter_id', 'race', 'gender') if columns.count(key) != 1]
    if missing:
        result['issues'].append('The clinical file needs one column named ' + ', '.join(missing) + '.')
        return result
    # adj_adjust.R keeps the first clinical record for each TCGA patient identifier.
    by_patient = {}
    for row in records:
        fields = (row.get('submitter_id') or '').split('-')
        if len(fields) >= 3:
            by_patient.setdefault(fields[2], row)
    races, genders, unsupported = set(), set(), set()
    missing_values = {'', 'na', 'n/a', 'nan', 'unknown', 'not reported', '--'}
    for patient in matched:
        row = by_patient.get(patient)
        if row is None:
            continue
        result['clinical_matched'] += 1
        race, gender = (row.get('race') or '').strip(), (row.get('gender') or '').strip()
        if race == 'american indian or alaska native':
            continue
        if race == 'not reported':
            race = 'white'
        if race.lower() in missing_values:
            result['missing_race'] += 1
        elif race not in {'asian', 'black or african american', 'white'}:
            unsupported.add(race)
        else:
            races.add(race)
        if gender.lower() in missing_values:
            result['missing_gender'] += 1
        else:
            genders.add(gender)
    result['unsupported_races'] = sorted(unsupported)
    if not matched:
        result['issues'].append('The completed genotype and expression outputs have no matching TCGA patient identifiers.')
    if result['clinical_matched'] != len(matched):
        result['issues'].append('Clinical data is missing for some matched patients.')
    if result['missing_gender'] or result['missing_race']:
        result['issues'].append('Matched patients have missing race or gender values.')
    if unsupported or races != {'asian', 'black or african american', 'white'}:
        result['issues'].append('The official adjustment requires the race groups asian, black or african american, and white.')
    if len(genders) < 2:
        result['issues'].append('The official adjustment requires at least two gender groups among matched patients.')
    return result


if __name__ == '__main__':
    try:
        result = review(*sys.argv[1:])
    except (OSError, ValueError, csv.Error, TypeError) as error:
        result = {'issues': ['Could not read the clinical data: ' + str(error)]}
    print('@@clinical\t' + json.dumps(result))
