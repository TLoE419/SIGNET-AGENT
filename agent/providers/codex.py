"""SIGNET's isolated Codex CLI test provider."""
import threading

from .base import ProviderAdapter
from .codex_client import CodexClient


class CodexProviderAdapter(ProviderAdapter):
    label = 'Codex CLI'

    def __init__(self):
        self.stopped = threading.Event()

    def create_client(self, timing):
        return CodexClient(timing=timing, stopped=self.stopped)

    def stop(self):
        self.stopped.set()
