"""The one place that knows where the project root is.

Modules live in subpackages, so deriving the root from each module's own
location would differ per file. data/, runs/, .env, assets/, web/ and
signet_inventory.json all resolve from here.
"""
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
