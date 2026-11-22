"""Model-callable page controls. The chat service streams each request to the open page."""
from contextvars import ContextVar

# Set by the chat service for one turn; a callable that forwards a request to the page.
UI_CHANNEL = ContextVar('ui_channel', default=None)
PANELS = ('workflow',)


def show_panel(panel: str, visible: bool) -> dict:
    """Open or collapse the "workflow" panel on the chat page (the setup and analysis checklist).
    Use when the user asks to show, open, hide or collapse it. Analysis results are on the chat cards.

    Changes only what the page shows; it runs nothing and changes no data.
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
