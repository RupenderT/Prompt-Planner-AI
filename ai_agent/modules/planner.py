from typing import Dict
from utils.logger import get_logger

logger = get_logger(__name__)

class Planner:
    def run(self, state: Dict) -> Dict:
        files = state.get("files", [])
        action = state["parsed_query"]["action"]

        plan = {"create": [], "modify": files, "methods": []}

        feature = state["parsed_query"]["feature"].lower()
        if "jwt" in feature:
            plan["create"].append("JwtService.cs")
            plan["methods"].extend(["generate_token()", "login_endpoint()"])

        state["plan"] = plan
        logger.info(f"Created plan: {plan}")
        return state
