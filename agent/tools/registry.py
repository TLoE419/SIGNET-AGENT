"""Every tool the model may call. This list is also the dispatch allow-list."""
from agent.tools.general import GENERAL_TOOLS
from agent.tools.hpc import HPC_TOOLS
from agent.tools.signet import SIGNET_TOOLS
from agent.tools.ui import UI_TOOLS

ALL_TOOLS = [*GENERAL_TOOLS, *HPC_TOOLS, *SIGNET_TOOLS, *UI_TOOLS]
