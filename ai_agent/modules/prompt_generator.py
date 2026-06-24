from typing import Dict
from utils.logger import get_logger
from langchain_ollama import OllamaLLM
import json

logger = get_logger(__name__)
ollama = OllamaLLM(model="mistral", base_url="http://localhost:11434")
class PromptGenerator:
    def run(self, state: Dict) -> Dict:
        plan = state["plan"]
        parsed_query = state["parsed_query"]

        # Retrieved context from previous node
        retrieved_files = state.get("files", [])
        retrieved_chunks = state.get("embeddings", [])
        matches = state.get("matches", []) or []
        symbols = state.get("symbols", []) or []
        related_symbols = state.get("relatedSymbols", []) or []

        llm_input = {
            "user_request": parsed_query.get("feature"),
            "files_to_modify": plan.get("modify", []),
            "files_to_create": plan.get("create", []),
            "target_methods": plan.get("methods", []),
            "retrieved_files": retrieved_files,
            "retrieved_chunks": retrieved_chunks,
            "matches": matches,
            "symbols": symbols,
            "related_symbols": related_symbols,
        }

        llm_prompt = f"""
You are a senior software architect generating implementation instructions for a coding agent.

The coding agent already has access to the provided files and code chunks.

Your objective is to minimize the amount of repository exploration required by the coding agent.

Analyze the supplied files and code snippets.

Identify:

- Exact files requiring modification
- Functions/classes requiring modification
- Existing patterns already present
- Existing utilities that should be reused
- Tests that require updates
- Documentation updates if applicable

Important rules:

- Do NOT invent architecture.
- Do NOT invent classes, models, routers, services, or utilities that are not visible in the supplied code.
- Do NOT suggest creating files unless clearly required.
- Prefer modifying existing files.
- Reference actual files and functions found in the supplied context.
- Keep instructions implementation-focused.
- Assume the coding agent should not search the repository.

Output format:

TASK:
<summary>

FILES:
- file1.py
- file2.py

PATTERNS TO FOLLOW:
- ...

CHANGES:

file.py
- specific change

TESTS:
- ...

CONSTRAINTS:
- reuse existing code
- avoid new files

Context:
{json.dumps(llm_input, indent=2)}
"""
        print(f"LLMPlanner prompt: {llm_prompt}")

        llm_response = ollama.invoke(llm_prompt)

        state["prompt"] = llm_response.strip()

        logger.info(
            "Generated implementation prompt:\n%s",
            state["prompt"]
        )

        return state