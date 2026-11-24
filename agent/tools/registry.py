"""Every tool the model may call. This list is also the dispatch allow-list."""
from agent.tools.general import GENERAL_TOOLS
from agent.tools.hpc import HPC_TOOLS
from agent.tools.signet import SIGNET_TOOLS
from agent.tools.ui import UI_TOOLS
from agent.tools.workspace import WORKSPACE_TOOLS, LEGACY_EXECUTION

# Chat-card tools from before the Analysis forms; the forms replaced them, so the model no longer sees them.
RETIRED_CHAT_TOOLS = {'get_network_status', 'get_signet_settings', 'get_visualization_workspace',
                      'propose_visualization_change', 'configure_signet', 'propose_hpc3_genotype'}

ALL_TOOLS = [*GENERAL_TOOLS, *HPC_TOOLS, *(fn for fn in SIGNET_TOOLS if fn.__name__ not in LEGACY_EXECUTION and fn.__name__ not in RETIRED_CHAT_TOOLS), *WORKSPACE_TOOLS, *UI_TOOLS]
