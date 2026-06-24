import json
from typing import Dict
from langchain_ollama import OllamaLLM
from utils.logger import get_logger

logger = get_logger(__name__)
ollama = OllamaLLM(model="mistral", base_url="http://localhost:11434")

class LLMPlanner:
    def run(self, state: Dict) -> Dict:
        plan = state.get("plan", {})
        query = state["parsed_query"]["feature"]
        matches = state.get("matches", []) or []
        symbols = state.get("symbols", []) or []
        related_symbols = state.get("relatedSymbols", []) or []

        # Ask Ollama to refine plan and recommend model
        prompt = (
            f"You are a planning agent. User query: {query}\n"
            f"Draft plan: {plan}\n"
            f"Relevant code matches: {json.dumps(matches, indent=2)}\n"
            f"Symbols in scope: {json.dumps(symbols, indent=2)}\n"
            f"Related symbols: {json.dumps(related_symbols, indent=2)}\n"
            "Refine the plan, ask for missing context if needed, "
            "and recommend a model (cheap vs powerful) based on complexity."
        )
        
        print(f"LLMPlanner prompt: {prompt}")

        llm_response = ollama.invoke(prompt)
        state["llm_analysis"] = llm_response
        print(f"LLMPlanner response: {llm_response}")

        # Simple heuristic: look for keywords in LLM response
        if "cheap" in llm_response.lower():
            state["model"] = "GPT-3.5"
        elif "powerful" in llm_response.lower():
            state["model"] = "GPT-4"
        else:
            state["model"] = "GPT-3.5"

        logger.info(f"LLM refined plan and recommended model: {state['model']}")
        return state
