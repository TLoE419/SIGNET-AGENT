"""Model-callable page controls. The chat service streams each request to the open page."""
from contextvars import ContextVar
import re

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


def navigate_workspace(action: str, history_id: str, stage: int, gene: str = "") -> dict:
    """View a saved workspace stage or select a Stage 6 gene and its connections. Navigation only; never runs analysis. Use canonical history_id from recorded history, never guess an ID."""
    from agent.stage6.workspace import CHAT_CONTEXT
    if (action not in ('view_stage', 'select_gene') or type(stage) is not int or not 1 <= stage <= 6
            or not re.fullmatch(r'(workspace|archive|recorded)--[A-Za-z0-9][A-Za-z0-9_-]{0,63}', history_id)
            or (action == 'select_gene' and (stage != 6 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', gene)))
            or (action == 'view_stage' and gene)):
        return {'status': 'invalid', 'executed': False}
    context, channel = CHAT_CONTEXT.get(), UI_CHANNEL.get()
    if context is None or channel is None:
        return {'status': 'unavailable', 'executed': False}
    run = next((row for row in context[0].history()['runs'] if row.get('history_id') == history_id), None)
    if run is None:
        return {'status': 'invalid', 'executed': False, 'reason': 'Unknown canonical history identity.'}
    payload = {'version': 1, 'action': action, 'history_id': history_id, 'stage': stage}
    if gene:
        payload['gene'] = gene
    channel({'workspace_action': payload})
    return {'status': 'ok', 'executed': False, 'workspace_action': payload,
            'note': 'Navigation requested; the page validates availability and current turn before applying.'}


UI_TOOLS = [show_panel, navigate_workspace]
