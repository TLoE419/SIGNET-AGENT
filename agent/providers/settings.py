"""Credential lookup shared by API-backed provider adapters."""
import os


def required_key(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f'Set {name} in .env or the environment.')
    return value
