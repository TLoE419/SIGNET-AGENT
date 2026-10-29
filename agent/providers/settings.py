"""Credential lookup shared by API-backed provider adapters."""
import os


def required_key(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f'請先在 .env 或環境變數設定 {name}。')
    return value
