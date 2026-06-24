import numpy as np
from typing import Dict, List

def cosine_similarity(vec1: List[float], vec2: List[float]) -> float:
    return float(np.dot(vec1, vec2) / (np.linalg.norm(vec1) * np.linalg.norm(vec2)))

def find_relevant_files(query: str, embeddings: Dict[str, List[float]]) -> List[str]:
    # Placeholder: in production, embed query and compare
    if not embeddings:
        return []
    return sorted(embeddings.keys())[:3]
