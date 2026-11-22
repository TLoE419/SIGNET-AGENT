import os
from pathlib import Path

from agent.paths import PROJECT_ROOT

PROJECT = PROJECT_ROOT
EXCLUDED_DIRECTORIES = {'venv', 'node_modules', '__pycache__'}
MAX_READ_BYTES = 32 * 1024 * 1024


def list_files(folder: str) -> list[str]:
    """Recursively list project files as sorted paths relative to the project root.

    Excludes hidden files/directories (including .env and .venv), dependency and
    cache directories, research data/runs, and symbolic links. Lists paths only; never reads contents.

    Args:
        folder: This project's root directory; other directories are rejected.
    """
    raw = Path(folder)
    if any(path.is_symlink() for path in [raw, *raw.parents]):
        raise ValueError('Symbolic links are not accepted.')
    root = raw.resolve()
    if root != PROJECT:
        raise ValueError("The folder must be this project's root directory.")

    def fail(error):
        raise error

    files = []
    # Prune before descending so environments, hidden credentials and link loops stay excluded.
    for directory, directories, filenames in os.walk(root, followlinks=False, onerror=fail):
        current = Path(directory)
        directories[:] = [name for name in directories
                          if not name.startswith('.') and name not in EXCLUDED_DIRECTORIES
                          and not (current / name).is_symlink()]
        for name in filenames:
            path = current / name
            if not name.startswith('.') and not path.is_symlink() and path.is_file():
                files.append(path.relative_to(root).as_posix())
    return sorted(path for path in files if not path.startswith(('data/', 'runs/')))


def read_file(path: str, start_line: int = 1, max_lines: int = 100) -> dict:
    """Legacy entry point: file contents are never exposed to the chat model."""
    raise ValueError('File contents are private. Use the approved statistical summaries and manual workspace review.')


def summarize_table(path: str) -> dict:
    """Counts-only summary of a table in data/ or runs/: columns, rows, blanks, and value counts for category columns. No rows or IDs."""
    from agent.runtime.jobs.table_summary import summarize
    raw = Path(path)
    raw = raw if raw.is_absolute() else PROJECT / raw
    if any(item.is_symlink() for item in [raw, *raw.parents]):
        raise ValueError('Symbolic links are not accepted.')
    target = raw.resolve()
    if not any(target.is_relative_to(PROJECT / folder) for folder in ('data', 'runs')):
        raise ValueError('Summarize only files inside this project data/ or runs/.')
    if any(part.startswith('.') or part in EXCLUDED_DIRECTORIES for part in target.relative_to(PROJECT).parts):
        raise ValueError('Hidden files, environments and dependencies are not readable.')
    if not target.is_file() or target.stat().st_size > MAX_READ_BYTES:
        raise ValueError('Expected an existing text table of at most 32 MiB.')
    with target.open(encoding='utf-8', errors='replace', newline='') as stream:
        return {**summarize(stream), 'executed': False, 'scope': 'Counts only; source file name and identifiers are not shared.'}


GENERAL_TOOLS = [list_files, summarize_table]
