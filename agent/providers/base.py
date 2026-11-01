"""Host-facing contract for LLM providers."""
from abc import ABC, abstractmethod
from contextlib import AbstractContextManager
from typing import Any

from agent.core.model_timing import ModelRequestTiming


class ProviderAdapter(ABC):
    label: str
    startup_messages: tuple[str, ...] = ()

    @abstractmethod
    def create_client(self, timing: ModelRequestTiming) -> AbstractContextManager[Any]:
        """Create one client context for one conversation turn."""

    def stop(self) -> None:
        """Stop provider-specific waits or owned requests when supported."""
