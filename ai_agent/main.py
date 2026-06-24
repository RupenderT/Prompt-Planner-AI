from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from agent import build_agent
from config import SERVICE_PORT
from typing import List, Dict, Any
import uvicorn
import requests

app = FastAPI()
agent = build_agent()
OLLAMA_URL = "http://localhost:11434/api/embed"
@app.post("/agent")
async def run_agent(request: Request):
    data = await request.json()
    query = data.get("query")
    #print(data)
    matches = data.get("matches", {})
    symbols = data.get("symbols", {})
    relatedSymbols = data.get("relatedSymbols", {})

    if not query:
        return {"error": "Query is required"}
    agent_state = {
        "query": query,
        "matches": matches,
        "symbols": symbols,
        "relatedSymbols": relatedSymbols
    }
    print(f"Agent state: {agent_state}")
    result = agent.invoke(agent_state)
    print(f"Agent result: {result}")
    return {
        "plan": result.get("plan"),
        "prompt": result.get("prompt"),
        "model": result.get("model"),
        "files": result.get("files"),
    }

@app.post("/embed")
async def embed_file(request: Request):
    data = await request.json()
    content = data.get("content", "")
    response = requests.post(
        OLLAMA_URL,
        json={"model": "nomic-embed-text", "input": content},
        timeout=60*6
    )
    return response.json()

MODEL_NAME =  "nomic-embed-text"

class EmbedRequest(BaseModel):
    content: str


class EmbedFile(BaseModel):
    path: str
    chunk_index: int
    content: str


class EmbedBatchRequest(BaseModel):
    files: List[EmbedFile] = []


@app.post("/embed_batch")
async def embed_files(request: EmbedBatchRequest) -> Dict[str, Any]:
    inputs = [file.content for file in request.files]
    response = requests.post(
        OLLAMA_URL,
        json={"model": MODEL_NAME, "input": inputs},
        timeout=60 * 6,
    )
    response.raise_for_status()
    data = response.json()

    embeddings = data.get("embeddings")
    if not embeddings or len(embeddings) != len(request.files):
        raise HTTPException(status_code=500, detail="Invalid batch embedding response")

    result = {
        f"{file.path}:{file.chunk_index}": embeddings[i]
        for i, file in enumerate(request.files)
    }

    return {"embeddings": result}

