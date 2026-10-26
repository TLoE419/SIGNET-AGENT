"""Groq API adapter."""
from contextlib import AbstractContextManager
import os
from typing import Any

from model_timing import ModelRequestTiming
from .base import ProviderAdapter
from .settings import required_key


class GroqProviderAdapter(ProviderAdapter):
    def __init__(self):
        from groq_provider import GROQ_MODEL
        self._api_key = required_key('GROQ_API_KEY')
        self.label = 'Groq / ' + os.environ.get('GROQ_MODEL', GROQ_MODEL)

    def create_client(self, timing: ModelRequestTiming) -> AbstractContextManager[Any]:
        from groq_provider import GroqClient
        return GroqClient(self._api_key, timing=timing)

    def stop(self) -> None:
        from groq_provider import REQUEST_PACER
        REQUEST_PACER.stopped.set()
