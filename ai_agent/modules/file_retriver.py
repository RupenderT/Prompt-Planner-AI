from typing import Dict
from utils.embeddings import find_relevant_files
from utils.logger import get_logger

logger = get_logger(__name__)

class FileRetriever:
    def run(self, state: Dict) -> Dict:
        embeddings = state.get("embeddings", {})
        query = state["parsed_query"]["feature"]
        relevant_files = find_relevant_files(query, embeddings)
        state["files"] = relevant_files
        logger.info(f"Retrieved files: {relevant_files}")
        return state
