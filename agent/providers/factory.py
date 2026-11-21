"""Explicit provider name to adapter dispatch."""
from .base import ProviderAdapter
from .codex import CodexProviderAdapter
from .gemini import GeminiProviderAdapter
from .groq import GroqProviderAdapter

PROVIDERS = ('gemini', 'groq', 'codex')


def create_provider_adapter(name: str, *, gemini_model: str) -> ProviderAdapter:
    match name:
        case 'groq':
            return GroqProviderAdapter()
        case 'gemini':
            return GeminiProviderAdapter(gemini_model)
        case 'codex':
            return CodexProviderAdapter()
        case _:
            raise ValueError('Unsupported model provider.')
