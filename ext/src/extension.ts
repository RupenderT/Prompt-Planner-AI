import * as vscode from 'vscode';
import * as fs from 'fs';
import axios from 'axios';
import path from "path";
import {
    indexFile,
    scanDirectory,
    createEmbedding,
    getEmbeddingsList,
    saveEmbedding,      
    deleteEmbeddingsByPath,
    deleteEmbeddingsFromChunk,
    getEmbeddingsByPath,
    getAllSymbols,
    getRelatedSymbolsByPaths,
    printTableCounts,
    getAllFiles,
    getChunkById,
    setStoragePath
} from './indexing.js';


let embeddingsCache: Record<string, number[]> = {};
interface EmbeddingRow { hash: string; }

let panel: vscode.WebviewPanel | undefined;

function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function getRelevantEmbaddings(
    query: string,
    topK: number = 8
): Promise<Array<{ path: string; start_line: number; end_line: number; score: number; chunkText: string, symbol_name: string; symbol_type: string }>> {
    // 1. Create embedding for the query
    const queryEmbedding = await createEmbedding(query);

    // 2. Load embeddings from DB (instead of only cache)
    const embeddings = await getEmbeddingsList(); // { "path:chunkIndex": number[] }

    // 3. Score each chunk
    const scoredChunks = Object.entries(embeddings)
        .map(([key, embedding]) => ({
            key,
            score: cosineSimilarity(queryEmbedding, embedding)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

    // 4. Normalize result
    const results = await Promise.all(scoredChunks.map(async chunk => {
        const id = chunk.key;
        const savedChunk = await getChunkById(id) as any;
        const chunkText = readChunkText(savedChunk.path, savedChunk.start_line, savedChunk.end_line);
        return {
            path: path.basename(savedChunk.path),
            start_line: savedChunk.start_line,
            end_line: savedChunk.end_line,
            score: chunk.score,
            chunkText: chunkText,
            symbol_name: savedChunk.symbol_name,
            symbol_type: savedChunk.symbol_type
        };
    }));
    return results;
}

function readChunkText(path: string, startLine: number, endLine: number): string {
    const contents = fs.readFileSync(path, 'utf8');
    const lines = contents.split(/\r?\n/);
    const startIndex = Math.max(0, startLine - 1);
    const endIndex = Math.min(lines.length, endLine);
    return lines.slice(startIndex, endIndex).join('\n').trim();
}




async function loadEmbeddingsCache() {
    embeddingsCache = await getEmbeddingsList();
    console.log(`Loaded ${Object.keys(embeddingsCache).length} chunk embeddings from DB`);
}
export async function activate(context: vscode.ExtensionContext) {
    // Set storage path for database
    const projectRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    const storagePath = projectRoot || context.globalStorageUri.fsPath;
    
    // Ensure storage directory exists
    if (!projectRoot && !fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
    }
    
    setStoragePath(storagePath);
    
    // Register UI command immediately
    const uiCommand = vscode.commands.registerCommand('planner-ai.showUI', async () => {
        await showPlannerUI(context);
    });
    context.subscriptions.push(uiCommand);

    // Schedule cache load + indexing AFTER activation
    setTimeout(async () => {
        try {
            await printTableCounts();
            const scanRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath || process.cwd();
            await scanDirectory(scanRoot);

            vscode.window.showInformationMessage("Planner AI indexing complete");
            await loadEmbeddingsCache();
        } catch (err) {
            vscode.window.showErrorMessage(`Indexing failed: ${err}`);
        }
    }, 0);

    // Keep file watchers active
    vscode.workspace.onDidSaveTextDocument(doc => {
        indexFile(doc.uri.fsPath);
    });

    vscode.workspace.onDidDeleteFiles(async event => {
        for (const file of event.files) {
            await deleteEmbeddingsByPath(file.fsPath);
            Object.keys(embeddingsCache).forEach(key => {
                if (key.startsWith(file.fsPath + ":")) delete embeddingsCache[key];
            });
        }
        await updateUIFiles();
    });
}

async function showPlannerUI(context: vscode.ExtensionContext) {
    if (panel) {
        panel.reveal(vscode.ViewColumn.One);
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'plannerAI',
        'Planner AI',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    panel.webview.html = getWebviewContent();

    panel.onDidDispose(() => { panel = undefined; });

    panel.webview.onDidReceiveMessage(async message => {
        if (message.type === 'runQuery') {
            try {
                const matches = await getRelevantEmbaddings(message.query, 10);
                //const symbols = getAllSymbols();
                //const relatedSymbols = getRelatedSymbolsByPaths(matches.map(m => m.path));
                const relatedSymbols = matches.map(m => ({ name: m.symbol_name, type: m.symbol_type, path: m.path } ));
                const response = await axios.post('http://localhost:5000/agent', {
                    query: message.query,
                    matches: matches.map(m => ({ path: m.path, start_line: m.start_line, end_line: m.end_line, chunkText: m.chunkText })),
                    //symbols,
                    relatedSymbols
                });
                panel?.webview.postMessage({ type: 'agentOutput', data: response.data });
            } catch (error: any) {
                vscode.window.showErrorMessage(`Error calling agent: ${error.message}`);
            }
        }
    });

    await updateUIFiles();
}

function getWebviewContent(): string {
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <style>
            body { font-family: sans-serif; padding: 1rem; }
            .section { margin-bottom: 1rem; }
            .files { max-height: 200px; overflow-y: auto; border: 1px solid #ccc; padding: 0.5rem; }
            .file { margin: 2px 0; font-size: 0.9rem; }
            pre { background: #f5f5f5; padding: 0.5rem; border-radius: 4px; }
        </style>
    </head>
    <body>
        <h2>Planner AI Dashboard</h2>
        <div class="section">
            <input id="queryInput" placeholder="Enter your query" value="add and empty method named log in discountservice"style="width:70%" />
            <button onclick="runQuery()">Run Query</button>
        </div>
        <div class="section">
            <h3>Indexed Files</h3>
            <div id="files" class="files"></div>
        </div>
        <div class="section">
            <h3>Agent Output</h3>
            <pre  id="output"></pre>
        </div>
        <script>
            const vscode = acquireVsCodeApi();
            function runQuery() {
                const query = document.getElementById('queryInput').value;
                vscode.postMessage({ type: 'runQuery', query });
            }
            window.addEventListener('message', event => {
                const msg = event.data;
                if (msg.type === 'filesIndexed') {
                    const filesDiv = document.getElementById('files');
                    filesDiv.innerHTML = msg.files.map(f => '<div class="file">Language:'+f.language+'Path:'+f.path+'Modified Date:'+f.modified_time+'</div>').join('');
                     }
                if (msg.type === 'agentOutput') {
                    document.getElementById('output').textContent =
                        "Plan: " + JSON.stringify(msg.data.plan, null, 2) + "\\n" +
                        "Prompt: " + msg.data.prompt + "\\n" +
                        "Model: " + msg.data.model + "\\n" +
                        (msg.data.context_requests?.length ? "Needs context: " + msg.data.context_requests.join(", ") : "");
                }
            });
        </script>
    </body>
    </html>
    `;
}

async function updateUIFiles() {
    if (panel) {
        const files = await getAllFiles();
        console.log("embeddingsCache keys:", files.map(f => f.path));
        panel.webview.postMessage({ type: 'filesIndexed', files });
    }
}

export function deactivate() { }
