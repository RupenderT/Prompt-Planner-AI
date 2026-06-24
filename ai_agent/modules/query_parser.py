from typing import Dict
from utils.logger import get_logger

logger = get_logger(__name__)

class QueryParser:
    def run(self, state: Dict) -> Dict:
        query = state.get("query", "")
        action = "unknown"
        if "add" in query.lower():
            action = "add"
        elif "modify" in query.lower():
            action = "modify"
        elif "delete" in query.lower():
            action = "delete"

        matches = state.get("matches", []) or []
        symbols = state.get("symbols", []) or []
        related_symbols = state.get("relatedSymbols", []) or []

        parsed = {
            "action": action,
            "feature": query,
            "match_paths": list({m.get("path") for m in matches if isinstance(m, dict) and m.get("path")}),
            "symbol_names": [s.get("name") for s in symbols if isinstance(s, dict) and s.get("name")],
            "related_symbol_names": [s.get("name") for s in related_symbols if isinstance(s, dict) and s.get("name")],
            "target_symbols": [
                s.get("name")
                for s in symbols
                if isinstance(s, dict) and s.get("name") and s.get("name").lower() in query.lower()
            ],
        }

        state["parsed_query"] = parsed
        logger.info(f"Parsed query: {parsed}")
        return state
