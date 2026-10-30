"""Model-callable page controls. The chat service streams each request to the open page."""
from contextvars import ContextVar

# Set by the chat service for one turn; a callable that forwards a request to the page.
UI_CHANNEL = ContextVar('ui_channel', default=None)
PANELS = ('workflow', 'visualization')


def show_panel(panel: str, visible: bool) -> dict:
    """Open or collapse a panel on the chat page: "workflow" (the setup and analysis checklist) or "visualization" (Stage 6 network results). Use when the user asks to show, open, hide or collapse one.

    Changes only what the page shows; it runs nothing and changes no data. The
    visualization panel opens only when Stage 6 results exist.
    """
    if panel not in PANELS:
        return {'status': 'invalid', 'executed': False, 'error': f'panel must be one of {", ".join(PANELS)}.'}
    channel = UI_CHANNEL.get()
    if channel is None:
        return {'status': 'unavailable', 'executed': False, 'reason': 'Only the chat page can show or hide panels.'}
    channel({'panel': panel, 'visible': visible})
    return {'status': 'ok', 'executed': False, 'panel': panel, 'visible': visible,
            'note': 'The page was asked to update; nothing was run.'}


UI_TOOLS = [show_panel]
