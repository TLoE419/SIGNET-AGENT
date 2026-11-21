"""Bounded read-only structural review of the pinned TCGA SIGNET input layout."""
import csv
import hashlib
import json
import math
import os
import re
import stat
import sys
import time

LIMITS = {'max_file_bytes': 128 * 1024 * 1024, 'max_total_bytes': 256 * 1024 * 1024,
          'max_line_bytes': 4 * 1024 * 1024, 'max_rows': 1000000, 'max_seconds': 30}
KINDS = ('genotype', 'expression', 'clinical')
SAFE = re.compile(r'/[A-Za-z0-9_./-]+')
BLOCKED = ('/tmp', '/var/tmp', '/dev/shm', '/run')
RULE = 'TCGA patient = third dash-separated identifier component; preliminary before QC.'
SCOPE = 'TCGA input structure and preliminary sample matching only; not analysis readiness or scientific validity.'
MISSING = {'', 'na', 'n/a', 'nan', 'unknown', 'not reported', '--'}


class StopReview(Exception):
    def __init__(self, code, message, incomplete=False, line=None):
        self.issue = {'code': code, 'message': message}
        if line is not None:
            self.issue['line'] = line
        self.incomplete = incomplete


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def patient(value):
    parts = value.split('-')
    return parts[2] if len(parts) >= 3 and parts[2] else None


def issue(check, code, message, line=None):
    if len(check['issues']) < 12:
        value = {'code': code, 'message': message}
        if line is not None:
            value['line'] = line
        check['issues'].append(value)


class Reader:
    def __init__(self, path, role, budget, files):
        self.path = os.path.realpath(path)
        self.budget, self.digest = budget, hashlib.sha256()
        self.stream, self.before = None, None
        self.meta = {'path': self.path, 'role': role, 'size': 0, 'mtime_ns': 0,
                     'sha256': None, 'complete': False, 'lines': 0}
        files.append(self.meta)
        if (not SAFE.fullmatch(self.path) or len(self.path) > 2048
                or any(self.path == root or self.path.startswith(root + '/') for root in BLOCKED)):
            raise StopReview('unsupported_path', 'Choose a supported shared-storage path.')
        try:
            self.before = os.stat(self.path)
            self.meta.update(size=self.before.st_size, mtime_ns=self.before.st_mtime_ns)
            if not stat.S_ISREG(self.before.st_mode) or not os.access(self.path, os.R_OK) or not self.before.st_size:
                raise StopReview('unavailable_file', 'Select readable, nonempty regular files.')
            if self.before.st_size > LIMITS['max_file_bytes']:
                raise StopReview('file_limit', 'This file exceeds the bounded review size; it was not fully checked.', True)
            self.stream = open(self.path, 'rb')
            if identity(os.fstat(self.stream.fileno())) != identity(self.before):
                raise StopReview('file_changed', 'An input file changed during review. Check again.', True)
        except StopReview:
            if self.stream:
                self.stream.close()
            raise
        except OSError:
            if self.stream:
                self.stream.close()
            raise StopReview('unavailable_file', 'A selected file is missing or unreadable.')

    def __iter__(self):
        while True:
            if time.monotonic() > self.budget['deadline']:
                raise StopReview('time_limit', 'The bounded review time expired; the check is incomplete.', True)
            raw = self.stream.readline(LIMITS['max_line_bytes'] + 1)
            if not raw:
                self.meta['complete'] = True
                return
            self.meta['lines'] += 1
            self.budget['bytes'] += len(raw)
            if (len(raw) > LIMITS['max_line_bytes'] or self.meta['lines'] > LIMITS['max_rows']
                    or self.budget['bytes'] > LIMITS['max_total_bytes']):
                raise StopReview('scan_limit', 'A bounded scan limit was reached; the check is incomplete.', True)
            self.digest.update(raw)
            try:
                text = raw.decode('utf-8-sig' if self.meta['lines'] == 1 else 'utf-8')
            except UnicodeError:
                raise StopReview('text_encoding', 'Use uncompressed UTF-8 text inputs.', line=self.meta['lines'])
            if '\x00' in text:
                raise StopReview('binary_input', 'An input contains binary data rather than text.', line=self.meta['lines'])
            yield self.meta['lines'], text

    def close(self):
        if self.stream is None:
            return
        try:
            changed = (identity(os.fstat(self.stream.fileno())) != identity(self.before)
                       or identity(os.stat(self.path)) != identity(self.before))
        except OSError:
            changed = True
        self.stream.close()
        if changed:
            self.meta['complete'] = False
            raise StopReview('file_changed', 'An input file changed during review. Check again.', True)
        if self.meta['complete']:
            self.meta['sha256'] = self.digest.hexdigest()


def finite(value):
    try:
        return math.isfinite(float(value))
    except ValueError:
        return False


def genotype(reader, check, state):
    first = True
    role, width, samples, markers, duplicate_ids, mismatches = None, None, 0, 0, 0, 0
    ids, patients, positions, marker_ids = set(), [], set(), set()
    duplicate_positions = duplicate_markers = 0
    for number, text in reader:
        fields = text.split()
        if not fields:
            continue
        if first:
            role = 'map' if len(fields) == 4 else 'ped' if len(fields) >= 8 and len(fields) % 2 == 0 else None
            reader.meta['role'] = role or 'genotype'
            first, width = False, len(fields)
        if role is None:
            issue(check, 'genotype_layout', 'Genotype files must form one four-column MAP and one six-field-plus-allele-pairs PED.', number)
            continue
        if len(fields) != width:
            issue(check, 'inconsistent_columns', 'Genotype rows do not have a consistent number of fields.', number)
            continue
        if role == 'map':
            markers += 1
            try:
                position = int(fields[3])
            except ValueError:
                position = -1
            if not finite(fields[2]) or position < 0:
                issue(check, 'map_coordinates', 'MAP rows need a finite genetic distance and a nonnegative integer position.', number)
            key = (fields[0], fields[3])
            duplicate_positions += key in positions
            duplicate_markers += fields[1] in marker_ids
            positions.add(key)
            marker_ids.add(fields[1])
        else:
            samples += 1
            duplicate_ids += fields[1] in ids
            ids.add(fields[1])
            mismatches += fields[0] != fields[1]
            if fields[4] not in ('0', '1', '2') or not finite(fields[5]):
                issue(check, 'ped_metadata', 'PED sex must be 0, 1 or 2, and phenotype must be numeric.', number)
            value = patient(fields[1])
            if value:
                patients.append(value)
    if role is None:
        issue(check, 'empty_table', 'An input contains no recognizable genotype rows.')
        return
    if role in state:
        issue(check, 'genotype_roles', 'Select one PED and one MAP file, rather than two files of the same layout.')
        return
    state[role] = {'samples': samples, 'markers': markers, 'width': width, 'patients': patients,
                   'duplicate_ids': duplicate_ids, 'mismatches': mismatches,
                   'duplicate_positions': duplicate_positions, 'duplicate_markers': duplicate_markers}


def expression(reader, check, state):
    header, split, rows, genes, duplicate_ids = None, None, 0, set(), 0
    tail = []
    for number, text in reader:
        if not text.strip():
            continue
        if header is None:
            delimiter = '\t' if '\t' in text else ',' if ',' in text else None
            split = (lambda line: next(csv.reader([line], delimiter=delimiter))) if delimiter else (lambda line: line.split())
            header = split(text.rstrip('\r\n'))
            if len(header) < 2:
                issue(check, 'expression_header', 'Expression needs one gene-ID column and sample columns.', number)
            ids = header[1:]
            duplicate_ids = len(ids) - len(set(ids))
            state['expression_ids'] = ids
            continue
        fields = split(text.rstrip('\r\n'))
        rows += 1
        if len(fields) != len(header):
            issue(check, 'expression_columns', 'Expression rows must match the header width.', number)
            continue
        if not fields[0] or any(not finite(value) or float(value) < 0 for value in fields[1:]):
            issue(check, 'expression_values', 'Expression requires a nonempty gene identifier and finite nonnegative numeric values.', number)
        tail.append((number, fields[0]))
        if len(tail) > 5:
            line, identifier = tail.pop(0)
            if identifier in genes:
                issue(check, 'duplicate_gene', 'Gene identifiers before the trailing five rows must be unique.', line)
            genes.add(identifier)
    state['expression_rows'] = rows
    check['metrics'] = {'samples': len(header or []) - 1 if header else 0, 'genes': max(0, rows - 5),
                        'data_rows': rows, 'trailing_rows': min(5, rows), 'duplicate_sample_ids': duplicate_ids,
                        'duplicate_patients': 0}
    if header is None or rows <= 5:
        issue(check, 'expression_rows', 'Expression needs gene rows plus the five trailing rows discarded by the pinned workflow.')
    if duplicate_ids:
        issue(check, 'duplicate_sample', 'Expression sample-column identifiers must be unique.')


def clinical(reader, check, state):
    columns, count, patients, duplicate, missing_race, missing_gender = None, 0, {}, 0, 0, 0
    for number, text in reader:
        if not text.strip():
            continue
        fields = next(csv.reader([text.rstrip('\r\n')], delimiter='\t'))
        if columns is None:
            columns = fields
            if any(columns.count(key) != 1 for key in ('submitter_id', 'race', 'gender')):
                issue(check, 'clinical_columns', 'Clinical data requires exactly one submitter_id, race and gender column.', number)
            continue
        count += 1
        if len(fields) != len(columns):
            issue(check, 'clinical_width', 'Clinical rows must match the tab-separated header width.', number)
            continue
        if not all(key in columns for key in ('submitter_id', 'race', 'gender')):
            continue
        row = dict(zip(columns, fields))
        value = patient(row['submitter_id'])
        if not value:
            issue(check, 'clinical_identifier', 'Clinical submitter identifiers need the TCGA patient component.', number)
            continue
        missing_race += row['race'].strip().lower() in MISSING
        missing_gender += row['gender'].strip().lower() in MISSING
        duplicate += value in patients
        patients.setdefault(value, (row['race'].strip(), row['gender'].strip()))
    state['clinical'] = patients
    check['metrics'] = {'rows': count, 'patients': len(patients), 'columns': len(columns or []),
                        'duplicate_patients': duplicate, 'missing_race': missing_race, 'missing_gender': missing_gender}
    if not columns or not count:
        issue(check, 'clinical_rows', 'Clinical data needs a header and patient rows.')


def validate(inputs):
    checks = [{'id': kind + '_format', 'kind': kind,
               'label': {'genotype': 'PED/MAP structure', 'expression': 'TCGA expression structure',
                         'clinical': 'Clinical table structure'}[kind],
               'status': 'unchecked', 'message': '', 'paths': inputs.get(kind, []), 'metrics': {}, 'issues': []}
              for kind in KINDS]
    files, state = [], {}
    budget = {'bytes': 0, 'deadline': time.monotonic() + LIMITS['max_seconds']}
    incomplete = False
    for check in checks:
        paths, kind = check['paths'], check['kind']
        if len(paths) != (2 if kind == 'genotype' else 1):
            issue(check, 'file_count', 'Choose one PED/MAP pair.' if kind == 'genotype' else 'Choose exactly one file for this input type.')
            check['message'] = check['issues'][0]['message']
            incomplete = True
            continue
        check['status'] = 'passed'
        for path in paths:
            reader = None
            try:
                if (not isinstance(path, str) or not SAFE.fullmatch(path) or len(path) > 2048
                        or '..' in path.split('/')):
                    raise StopReview('absolute_remote_path', 'Choose absolute remote paths with the remote file browser; saved example labels are not file locations.')
                reader = Reader(path, kind, budget, files)
                {'genotype': genotype, 'expression': expression, 'clinical': clinical}[kind](reader, check, state)
            except StopReview as error:
                if len(check['issues']) < 12:
                    check['issues'].append(error.issue)
                incomplete |= error.incomplete
                check['status'] = 'unchecked' if error.incomplete else 'failed'
            except (OSError, ValueError, csv.Error, OverflowError):
                issue(check, 'unreadable_table', 'An input could not be parsed as the expected plain-text table.')
                check['status'] = 'failed'
            finally:
                if reader:
                    try:
                        reader.close()
                    except StopReview as error:
                        if len(check['issues']) < 12:
                            check['issues'].append(error.issue)
                        incomplete = True
                        check['status'] = 'unchecked'
        if check['issues'] and check['status'] == 'passed':
            check['status'] = 'failed'
        if check['status'] == 'passed' and kind == 'genotype':
            ped, mapping = state.get('ped'), state.get('map')
            if not ped or not mapping or (ped['width'] - 6) // 2 != mapping['markers']:
                issue(check, 'ped_map_markers', 'Each PED row must contain two allele fields for every MAP marker.')
                check['status'] = 'failed'
            else:
                values = ped['patients']
                check['metrics'] = {'samples': ped['samples'], 'markers': mapping['markers'],
                    'ped_markers': (ped['width'] - 6) // 2, 'duplicate_sample_ids': ped['duplicate_ids'],
                    'duplicate_patients': len(values) - len(set(values)), 'fid_iid_mismatches': ped['mismatches']}
                if ped['duplicate_ids']:
                    issue(check, 'duplicate_sample', 'The pinned workflow loses family grouping; individual identifiers must be unique.')
                    check['status'] = 'failed'
                elif ped['mismatches'] or mapping['duplicate_positions'] or mapping['duplicate_markers']:
                    issue(check, 'genotype_compatibility', 'Review differing family/individual IDs or duplicate markers; later SIGNET preprocessing may drop or fail to match them.')
                    check['status'] = 'warning'
        if check['status'] == 'passed' and kind == 'expression':
            check['status'] = 'warning'
            issue(check, 'expression_scale', 'The pinned workflow interprets values as log2(count+1) and discards the last five rows. Numeric shape cannot prove that this scale and row removal are intended.')
        if check['status'] == 'passed' and kind == 'clinical' and check['metrics']['duplicate_patients']:
            issue(check, 'duplicate_clinical_patient', 'The pinned workflow keeps only the first clinical row for each patient component.')
            check['status'] = 'warning'
        check['message'] = check['issues'][0]['message'] if check['issues'] else 'The checked table structure matches the current input layout.'

    pairing = {'status': 'unchecked', 'rule': RULE, 'genotype_patients': 0, 'expression_patients': 0,
               'matched_patients': 0, 'clinical_matched': 0, 'unmatched_genotype': 0, 'unmatched_expression': 0, 'issues': []}
    if all(check['status'] in ('passed', 'warning') for check in checks):
        genotype_ids = state['ped']['patients']
        expression_ids = [patient(value) for value in state.get('expression_ids', [])]
        gen, expr = set(genotype_ids), set(value for value in expression_ids if value)
        matched, rows = gen & expr, state['clinical']
        pairing.update(genotype_patients=len(gen), expression_patients=len(expr), matched_patients=len(matched),
                       clinical_matched=len(matched & set(rows)), unmatched_genotype=len(gen - expr),
                       unmatched_expression=len(expr - gen), status='passed')
        checks[1]['metrics']['duplicate_patients'] = sum(value is not None for value in expression_ids) - len(expr)
        def pair_issue(code, message, failed=False):
            pairing['issues'].append({'code': code, 'message': message})
            pairing['status'] = 'failed' if failed or pairing['status'] == 'failed' else 'warning'
        if len(genotype_ids) != state['ped']['samples'] or any(value is None for value in expression_ids):
            pair_issue('sample_identifier', 'Some sample identifiers do not contain the TCGA patient component.', True)
        if not matched:
            pair_issue('no_overlap', 'Genotype and expression have no matching TCGA patient components.', True)
        if len(matched & set(rows)) != len(matched):
            pair_issue('clinical_coverage', 'Clinical rows are missing for some matched patients.', True)
        if gen - expr or expr - gen:
            pair_issue('unmatched_samples', 'Some patients occur in only one input; later matching will exclude them.')
        if len(genotype_ids) != len(gen) or sum(value is not None for value in expression_ids) != len(expr):
            pair_issue('ambiguous_patient', 'Repeated patient components may create ambiguous pairs; this preview does not reproduce later duplicate filtering.')
        races, genders, missing_race, missing_gender, unsupported = set(), set(), 0, 0, 0
        for value in matched & set(rows):
            race, gender = rows[value]
            if race == 'american indian or alaska native':
                continue
            race = 'white' if race == 'not reported' else race
            missing_race += race.lower() in MISSING
            missing_gender += gender.lower() in MISSING
            if race.lower() not in MISSING:
                races.add(race)
                unsupported += race not in {'asian', 'black or african american', 'white'}
            if gender.lower() not in MISSING:
                genders.add(gender)
        pairing.update(missing_race=missing_race, missing_gender=missing_gender, race_groups=len(races), gender_groups=len(genders))
        if missing_race or missing_gender:
            pair_issue('missing_covariates', 'Some matched clinical rows have missing race or gender values.', True)
        if unsupported or races != {'asian', 'black or african american', 'white'} or len(genders) < 2:
            pair_issue('adjustment_groups', 'The current Stage 3 execution guard requires its three supported race groups and at least two gender groups; this is a workflow constraint, not a universal clinical-file format rule.')
    status = 'incomplete' if incomplete else 'failed' if any(check['status'] == 'failed' for check in checks) or pairing['status'] == 'failed' else 'warning' if any(check['status'] == 'warning' for check in checks) or pairing['status'] == 'warning' else 'passed'
    return {'status': status, 'checks': checks, 'pairing': pairing, 'files': files,
            'limits': LIMITS.copy(), 'read_only': True, 'executed': False, 'scope': SCOPE}


if __name__ == '__main__':
    result = validate(json.loads(sys.argv[1]))
    print('@@result\t' + json.dumps(result))
