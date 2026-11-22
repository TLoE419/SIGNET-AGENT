"""Every tool the model may call. This list is also the dispatch allow-list."""
from agent.tools.general import GENERAL_TOOLS
from agent.tools.hpc import HPC_TOOLS
from agent.tools.signet import SIGNET_TOOLS
from agent.tools.ui import UI_TOOLS
from agent.tools.workspace import WORKSPACE_TOOLS, LEGACY_EXECUTION

ALL_TOOLS = [*GENERAL_TOOLS, *HPC_TOOLS, *(fn for fn in SIGNET_TOOLS if fn.__name__ not in LEGACY_EXECUTION and fn.__name__ != 'get_network_status'), *WORKSPACE_TOOLS, *UI_TOOLS]
