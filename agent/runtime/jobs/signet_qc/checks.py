"""Streaming checks and aggregate evidence shared by the cohort readers."""

import math
import re

from .issues import CommonIssue, IssueCode


SAMPLE_ID_ISSUES = (CommonIssue.SAMPLE_ID_COUNT_MISMATCH, CommonIssue.DUPLICATE_SAMPLE_IDS)


class Report:
    def __init__(self):
        self.metrics = {}
        self.issues = []

    def issue(self, code: IssueCode, *, parameters=()):
        self.issues.append({'code': code.value, 'severity': code.severity, 'parameters': list(parameters)})

    def result(self):
        if any(issue['severity'] == 'error' for issue in self.issues):
            status = 'blocked'
        elif self.issues:
            status = 'review_required'
        else:
            status = 'pass'
        return {'qc_status': status, 'metrics': self.metrics, 'issues': self.issues}


def read_run_settings(run_dir):
    """Read SIGNET's assignments, ignoring section labels and cohort markers."""
    config_path = run_dir / 'work/config.ini'
    values = {}
    if config_path.is_file():
        for line in config_path.read_text().splitlines():
            if '=' not in line or line.lstrip().startswith(('#', ';')):
                continue
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip()
    return values


def artifact_prefix(run_dir, config, key, default):
    work = (run_dir / 'work').resolve()
    path = (work / config.get(key, default)).resolve()
    if work not in path.parents:
        raise ValueError('Artifact prefix must be inside the run work directory.')
    return path


def input_path(run_dir, config, key):
    value = config.get(key)
    return run_dir / 'work' / value if value else None


def split_whitespace_rows(stream):
    for line in stream:
        yield line.split()


def read_identifiers(path, column=0, header=False):
    with path.open() as stream:
        if header:
            next(stream, None)
        values = []
        for row in split_whitespace_rows(stream):
            if len(row) <= column:
                raise ValueError('Invalid identifier row.')
            values.append(row[column])
        return values


def check_numeric_matrix(source, report, *, encoding=None, metadata_columns=0):
    """Validate rows as they are read. BED metadata columns are excluded."""
    row_count = 0
    invalid_values = 0
    ragged_rows = 0
    width = None
    for row in source:
        values = row[metadata_columns:]
        if width is None:
            width = len(values)
        row_count += 1
        if len(values) != width:
            ragged_rows += 1
        for value in values:
            if not is_valid_matrix_value(value, encoding):
                invalid_values += 1
    report.metrics.update(matrix_rows=row_count, matrix_columns=width or 0,
                          ragged_rows=ragged_rows, invalid_values=invalid_values, missing_values=0)
    if not row_count or not width:
        report.issue(CommonIssue.EMPTY_MATRIX)
    if ragged_rows:
        report.issue(CommonIssue.RAGGED_MATRIX)
    if invalid_values:
        report.issue(CommonIssue.INVALID_MATRIX_VALUES)
    return row_count, width or 0


def is_valid_matrix_value(value, encoding):
    if encoding is not None:
        return value in encoding
    try:
        return math.isfinite(float(value))
    except ValueError:
        return False


def check_ids(values, expected, report, kind='sample', issue_codes=SAMPLE_ID_ISSUES):
    mismatch_code, duplicate_code = issue_codes
    duplicates = len(values) - len(set(values))
    report.metrics[f'{kind}_id_count'] = len(values)
    report.metrics[f'duplicate_{kind}_ids'] = duplicates
    if len(values) != expected:
        report.issue(mismatch_code)
    if duplicates:
        report.issue(duplicate_code)


def chromosome_scope(setting):
    if not setting or setting == 'no':
        return None
    result = set()
    for part in setting.split(','):
        match = re.fullmatch(r'(\d{1,2})(?:-(\d{1,2}))?', part.strip())
        if not match:
            return None
        first, last = match.groups()
        result.update(f'chr{n}' for n in range(int(first), int(last or first) + 1))
    return result
