import requests
from typing import Dict
from utils.logger import get_logger

logger = get_logger(__name__)

class OllamaClient:
    def __init__(self, base_url: str = "http://localhost:11434/api/generate"):
        self.base_url = base_url

    def generate(self, model: str, prompt: str) -> str:
        try:
            response = requests.post(
                self.base_url,
                json={"model": model, "prompt": prompt},
                timeout=60
            )
            response.raise_for_status()
            output = ""
            for line in response.iter_lines():
                if line:
                    output += line.decode("utf-8")
            return output
        except Exception as e:
            logger.error(f"Ollama call failed: {e}")
            return f"Error calling Ollama: {e}"
