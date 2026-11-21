"""Read-only compatibility check for the official TCGA adjustment inputs."""

import csv
import hashlib
import io
import json
import os
from pathlib import Path
import sys


def review(clinical, genotype_ids, expression_ids, choices=None, out=None):
    choices = {} if choices is None else choices
    if (not isinstance(choices, dict) or len(choices) > 64 or
            any(not isinstance(key, str) or not 1 <= len(key) <= 240 or value not in ('not_reported', 'exclude')
                for key, value in choices.items())):
        raise ValueError('Choose not_reported or exclude for each unrecognized race value.')
    upstream_digests = {}
    def patients(name, path):
        raw = Path(path).read_bytes()
        upstream_digests[name] = hashlib.sha256(raw).hexdigest()
        result = set()
        for line in raw.decode('utf-8-sig').splitlines():
            fields = line.strip().split('-')
            if len(fields) >= 3 and fields[2]:
                result.add(fields[2])
        return result

    matched = patients('genotype', genotype_ids) & patients('expression', expression_ids)
    original = Path(clinical).read_bytes()
    reader = csv.DictReader(io.StringIO(original.decode('utf-8-sig'), newline=''), delimiter='\t')
    columns = reader.fieldnames or []
    records = list(reader)
    result = {'columns': columns, 'rows': len(records), 'matched': len(matched),
              'clinical_matched': 0, 'missing_gender': 0, 'missing_race': 0,
              'unsupported_races': [], 'issues': [], 'race': {}, 'gender': {},
              'unrecognized_race': {}, 'needs_choice': [], 'choices': choices,
              'races_after': {}, 'retained': 0, 'excluded': 0, 'source_digest': hashlib.sha256(original).hexdigest(),
              'upstream_digests': upstream_digests}
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
        label = race or '(blank)'
        result['race'][label] = result['race'].get(label, 0) + 1
        result['gender'][gender or '(blank)'] = result['gender'].get(gender or '(blank)', 0) + 1
        if race not in {'asian', 'black or african american', 'white', 'not reported', 'american indian or alaska native'}:
            result['unrecognized_race'][label] = result['unrecognized_race'].get(label, 0) + 1
            if label not in choices:
                unsupported.add(label)
                continue
            race = 'not reported' if choices[label] == 'not_reported' else 'american indian or alaska native'
        if race == 'american indian or alaska native':
            result['excluded'] += 1
            continue
        if race == 'not reported':
            race = 'white'
        if race.lower() in missing_values:
            result['missing_race'] += 1
        elif race not in {'asian', 'black or african american', 'white'}:
            unsupported.add(race)
        else:
            races.add(race)
            result['races_after'][race] = result['races_after'].get(race, 0) + 1
        result['retained'] += 1
        if gender.lower() in missing_values:
            result['missing_gender'] += 1
        else:
            genders.add(gender)
    result['unsupported_races'] = sorted(unsupported)
    result['needs_choice'] = sorted(unsupported)
    if not matched:
        result['issues'].append('The completed genotype and expression outputs have no matching TCGA patient identifiers.')
    if result['clinical_matched'] != len(matched):
        result['issues'].append('Clinical data is missing for some matched patients.')
    if result['missing_gender'] or result['missing_race']:
        result['issues'].append('Matched patients have missing race or gender values.')
    if unsupported:
        result['issues'].append('Choose how to handle each unrecognized race value, then check the clinical file again.')
    if not unsupported and races != {'asian', 'black or african american', 'white'}:
        result['issues'].append('The official adjustment requires the race groups asian, black or african american, and white.')
    if len(genders) < 2:
        result['issues'].append('The official adjustment requires at least two gender groups among matched patients.')
    if out and not result['issues']:
        destination = Path(out)
        # Refuse existing linked ancestors before mkdir can create anything outside the run.
        if destination.resolve() != destination:
            raise ValueError('The reviewed clinical copy must stay in its owned run folder.')
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.parent.resolve() != destination.parent or destination.is_symlink():
            raise ValueError('The reviewed clinical copy must stay in its owned run folder.')
        # Every submission writes its own copy; the researcher's selected file is never edited.
        partial = destination.with_suffix(destination.suffix + '.partial')
        created = False
        try:
            with partial.open('x', encoding='utf-8', newline='\n') as stream:
                created = True
                writer = csv.DictWriter(stream, fieldnames=columns, delimiter='\t', lineterminator='\n')
                writer.writeheader()
                for row in records:
                    label = (row.get('race') or '').strip() or '(blank)'
                    if label in result['unrecognized_race']:
                        row['race'] = 'not reported' if choices[label] == 'not_reported' else 'american indian or alaska native'
                    writer.writerow(row)
            try:
                # A hard link publishes this exact file exclusively; a raced destination is never overwritten.
                os.link(partial, destination)
            except FileExistsError:
                if (destination.resolve() != destination or not destination.is_file()
                        or destination.read_bytes() != partial.read_bytes()):
                    raise ValueError('The existing reviewed clinical copy differs; it was preserved.')
        finally:
            if created:
                partial.unlink()
        result['written'] = True
    return result


if __name__ == '__main__':
    try:
        result = review(*sys.argv[1:4], json.loads(sys.argv[4]) if len(sys.argv) > 4 else {},
                        sys.argv[5] if len(sys.argv) > 5 else None)
    except (OSError, ValueError, csv.Error, TypeError) as error:
        result = {'issues': ['Could not read the clinical data: ' + str(error)]}
    print('@@clinical\t' + json.dumps(result))
