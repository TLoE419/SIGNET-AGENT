"""Google Gemini API adapter."""
from contextlib import AbstractContextManager
from typing import Any

from agent.core.model_timing import ModelRequestTiming
from .base import ProviderAdapter
from .settings import required_key


class GeminiProviderAdapter(ProviderAdapter):
    def __init__(self, model: str):
        self._api_key = required_key('GEMINI_API_KEY')
        self.label = model

    def create_client(self, timing: ModelRequestTiming) -> AbstractContextManager[Any]:
        from google import genai
        from google.genai import types
        return genai.Client(
            api_key=self._api_key,
            http_options=types.HttpOptions(client_args=timing.client_args()))
