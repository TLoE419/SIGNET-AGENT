"""Signed-in Codex CLI adapter."""
from contextlib import AbstractContextManager
import shutil
from typing import Any

from agent.core.model_timing import ModelRequestTiming
from .base import ProviderAdapter


class CodexProviderAdapter(ProviderAdapter):
    def __init__(self):
        from agent.providers.codex_client import configured_model
        self.label = 'Codex CLI / ' + (configured_model() or '預設模型')
        if not shutil.which('codex'):
            self.startup_messages = (
                '尚未安裝 Codex 命令列；介面仍可開啟，聊天前請依 docs/INSTALL.md 安裝與登入。',)

    def create_client(self, timing: ModelRequestTiming) -> AbstractContextManager[Any]:
        from agent.providers.codex_client import CodexClient
        return CodexClient(timing=timing)

    def stop(self) -> None:
        from agent.providers.codex_client import STOP
        STOP.set()
