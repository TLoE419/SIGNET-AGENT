"""Counts-only summary of a delimited table, so the model can check a table without seeing any row.

Reports the column names, the row count and, per column, how many values are blank and how
many are distinct. Only for columns with few distinct values (categories such as race or
gender) does it count each value. Identifier columns and columns with many distinct values
never have their values reported, and TCGA barcodes are masked wherever they appear.

Standalone on purpose: the standard library only and Python 3.6 syntax, because it also runs
with the HPC3 login node's system python3 (agent/runtime/hpc.py uploads this file's text).
"""
import json
import re
import sys

MAX_CATEGORIES = 20
MAX_VALUE_CHARS = 60
_ID_COLUMN = re.compile(r'(^|[_.\s-])(id|ids|barcode|uuid|submitter|sample|patient|case|name)([_.\s-]|$)', re.I)
_BARCODE = re.compile(r'TCGA-[A-Za-z0-9]{2}-[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{2,5})*')


def _delimiter(header):
    if '\t' in header:
        return '\t'
    return ',' if ',' in header else None


def _split(line, delimiter):
    line = line.rstrip('\r\n')
    return line.split(delimiter) if delimiter else line.split()


def summarize(lines):
    """Summarize an iterable of text lines whose first line is the header."""
    lines = iter(lines)
    header = next(lines, '')
    delimiter = _delimiter(header)
    columns = [name.strip() for name in _split(header, delimiter)]
    counts = [{} for _ in columns]
    blanks = [0] * len(columns)
    rows = ragged = 0
    for line in lines:
        if not line.strip():
            continue
        rows += 1
        fields = _split(line, delimiter)
        if len(fields) != len(columns):
            ragged += 1
        for index in range(len(columns)):
            value = fields[index].strip() if index < len(fields) else ''
            if not value:
                blanks[index] += 1
            elif len(counts[index]) <= MAX_CATEGORIES or value in counts[index]:
                counts[index][value] = counts[index].get(value, 0) + 1
    per_column = {}
    for index, name in enumerate(columns):
        values = counts[index]
        entry = {'blank': blanks[index]}
        if len(values) > MAX_CATEGORIES:
            entry['distinct'] = 'more than {}'.format(MAX_CATEGORIES)
        else:
            entry['distinct'] = len(values)
            if not _ID_COLUMN.search(name):
                entry['values'] = {_BARCODE.sub('TCGA-[masked]', value)[:MAX_VALUE_CHARS]: count
                                   for value, count in sorted(values.items(), key=lambda item: -item[1])}
        per_column[_BARCODE.sub('TCGA-[masked]', name)] = entry
    return {'status': 'ok', 'columns': [_BARCODE.sub('TCGA-[masked]', name) for name in columns], 'rows': rows,
            'rows_with_a_different_field_count': ragged,
            'delimiter': {'\t': 'tab', ',': 'comma', None: 'whitespace'}[delimiter],
            'windows_line_endings': header.endswith('\r\n'),
            'per_column': per_column,
            'scope': 'Counts only: no rows and no identifiers. Values are counted only for columns with at most '
                     '{} distinct values that are not identifier columns.'.format(MAX_CATEGORIES)}


def main():
    try:
        with open(sys.argv[1], encoding='utf-8', errors='replace', newline='') as stream:
            result = summarize(stream)
    except (OSError, IndexError) as error:
        result = {'status': 'failed', 'error': 'The table could not be read: {}'.format(type(error).__name__)}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
