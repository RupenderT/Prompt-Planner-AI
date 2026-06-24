from typing import Dict
from utils.logger import get_logger

logger = get_logger(__name__)

class ModelSelector:
    def run(self, state: Dict) -> Dict:
        plan = state["plan"]
        complexity = len(plan["modify"]) + len(plan["methods"]) + len(plan["create"])
        model = "GPT-4" if complexity > 3 else "GPT-3.5"
        state["model"] = model
        logger.info(f"Selected model: {model}")
        return state
