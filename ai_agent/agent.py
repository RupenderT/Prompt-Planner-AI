from langgraph.graph import StateGraph, END#,START
from modules.query_parser import QueryParser
from modules.file_retriver import FileRetriever
from modules.planner import Planner
from modules.prompt_generator import PromptGenerator
from modules.llm_planner import LLMPlanner
# Define the state schema
from typing import TypedDict, List
class AgentState(TypedDict):
    query: str
    embeddings: dict
    parsed_query: dict
    files: List[str]
    plan: dict
    llm_analysis: str
    prompt: str
    model: str
    context_requests: List[str]  # new field for missing info
    matches: List[Match]
    symbols: List[Symbol]
    relatedSymbols: List[Symbol]
    
class Match:
    path:str
    start_line:int
    end_line:int
    score:int

class Symbol:
    name:str
    type:str
    path:str
    startLine:int
    endLine:int
    
def build_agent():
    graph = StateGraph(AgentState)

    parser = QueryParser()
    retriever = FileRetriever()
    planner = Planner()
    llm_planner = LLMPlanner()
    generator = PromptGenerator()

    graph.add_node("parse_query", parser.run)
    graph.add_node("retrieve_files", retriever.run)
    graph.add_node("create_plan", planner.run)
    graph.add_node("llm_planner", llm_planner.run)
    graph.add_node("generate_prompt", generator.run)

    #graph.add_edge(START, "parse_query")
    graph.add_edge("parse_query", "retrieve_files")
    graph.add_edge("retrieve_files", "create_plan")
    graph.add_edge("create_plan", "llm_planner")
    graph.add_edge("llm_planner", "generate_prompt")
    graph.add_edge("generate_prompt", END)
    graph.set_entry_point("parse_query")

    return graph.compile()
