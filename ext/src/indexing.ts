import * as vscode from "vscode";
import fs from "fs";
import path from "path";
import crypto from "crypto";

import Database from "better-sqlite3";

// import Parser from "tree-sitter";
// import { typescript } from "tree-sitter-typescript";
//import CSharp from "tree-sitter-c-sharp";


import Parser from "tree-sitter";

const { typescript, tsx } = await import("tree-sitter-typescript");
// tree-sitter-c-sharp exports its language as the default
const csharp = (await import("tree-sitter-c-sharp")).default;


const db = new Database("codeindex2.db");

db.exec(`
CREATE TABLE IF NOT EXISTS files(
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE,
    language TEXT,
    modified_time INTEGER
);

CREATE TABLE IF NOT EXISTS symbols(
    id INTEGER PRIMARY KEY,
    file_id INTEGER,
    name TEXT,
    type TEXT,
    start_line INTEGER,
    end_line INTEGER
);

CREATE TABLE IF NOT EXISTS dependencies(
    id INTEGER PRIMARY KEY,
    file_id INTEGER,
    dependency TEXT
);
CREATE TABLE IF NOT EXISTS chunks(
    id INTEGER PRIMARY KEY,
    file_id INTEGER,
    symbol_name TEXT,
    symbol_type TEXT,
    file_path TEXT,
    start_line INTEGER,
    end_line INTEGER,
    hash TEXT,
    embedding TEXT
);

CREATE TABLE IF NOT EXISTS embeddings (
    path TEXT,
    chunk_index INTEGER,
    hash TEXT,
    embedding TEXT,
    PRIMARY KEY (path, chunk_index)
);
`);


export function printTableCounts() {
    const tables = [
        "files",
        "symbols",
        "dependencies",
        "chunks",
        "embeddings"
    ];

    for (const table of tables) {
        const stmt = db.prepare(`SELECT COUNT(*) as count FROM ${table}`);
        const row = stmt.get();
        console.log(`${table}: ${row.count}`);
    }
}

const insertFile = db.prepare(`
INSERT OR REPLACE INTO files(path, language, modified_time)
VALUES (?, ?, ?)
 ON CONFLICT(path)
DO UPDATE SET modified_time = excluded.modified_time
`);
function upsertFile(filePath: string, language: string, mtime: number) {
    const stmt = db.prepare(`
        INSERT INTO files(path, language, modified_time)
        VALUES (?, ?, ?)
        ON CONFLICT(path)
        DO UPDATE SET 
            language = excluded.language,
            modified_time = excluded.modified_time
    `);

    stmt.run(filePath, language, mtime);
    return true; // synchronous, no Promise needed
}

function insertChunk(chunk: any) {

    const stmt = db.prepare(`INSERT INTO chunks(
        file_id,
        symbol_name,
        symbol_type,
        start_line,
        end_line,
        hash,
        embedding
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
   
        stmt.run(
            chunk.file_id,
            chunk.symbol_name,
            chunk.symbol_type,
            chunk.start_line,
            chunk.end_line,
            chunk.hash,
            chunk.embedding,
        );
}
const getFileId = db.prepare(`
SELECT id FROM files WHERE path = ?
`);

const getAllDBFiles = db.prepare(`
SELECT path, language, modified_time FROM files
`);

const findFileByPath = db.prepare(`
 SELECT path,language,modified_time FROM files WHERE path = ?
`);

const getAllChunks = db.prepare(`
SELECT * FROM chunks
`);

const getDBChunkById = db.prepare(`
SELECT * FROM chunks
join files ON chunks.file_id = files.id
 WHERE chunks.id = ?
`);

const insertSymbol = db.prepare(`
INSERT INTO symbols(
    file_id,
    name,
    type,
    start_line,
    end_line
)
VALUES (?, ?, ?, ?, ?)
`);

const insertDependency = db.prepare(`
INSERT INTO dependencies(
    file_id,
    dependency
)
VALUES (?, ?)
`);

// const insertChunk = db.prepare(`
// INSERT INTO chunks(
//     file_id,
//     symbol_name,
//     start_line,
//     end_line,
//     file_path,
//     embedding
// )
// VALUES (?, ?, ?, ?, ?, ?)
// `);

function getLanguage(filePath: string) {
    const ext = path.extname(filePath);

    if (ext === ".cs") return "csharp";
    if (ext === ".ts") return "typescript";
    if (ext === ".js") return "javascript";

    return null;
}

function buildParser(language: string) {
    const parser = new Parser();

    if (language === "csharp") {
        parser.setLanguage(csharp);
    } else {
        parser.setLanguage(typescript);
    }

    return parser;
}
async function indexFile(filePath: string) {
    const language = getLanguage(filePath);
    if (!language) return;

    const stat = fs.statSync(filePath);
    const currentMtime = stat.mtimeMs;

    // Check DB for existing modified_time
    const filerow = findFileByPath.get(filePath) as any;

    if (filerow) {
        console.error(filerow);
        console.error(`File ${filePath} exists in DB with modified_time: ${filerow.modified_time}, current modified_time: ${currentMtime}`);
        const storedMtime = filerow.modified_time;
        console.error(`Stored mtime: ${storedMtime}, Current mtime: ${currentMtime}`);
        if (storedMtime === currentMtime) {
            console.log(`Skipping unchanged file: ${filePath}`);
            return; // no reindex needed
        }

    }

    const code = fs.readFileSync(filePath, "utf8");

    console.log(`upserting file: ${filePath} (language: ${language})`);
    await upsertFile(filePath, language, stat.mtimeMs);
    console.log(`upserted file: ${filePath} (language: ${language})`);
    const row = getFileId.get(filePath) as any;
    const fileId = row.id;
    console.log(`fileId for ${filePath}: ${fileId}`);
    const doc = await vscode.workspace.openTextDocument(filePath);
    console.log(`Opened document for ${filePath}, languageId: ${doc.languageId}`);

    const symbols: vscode.DocumentSymbol[] =
        (await vscode.commands.executeCommand(
            "vscode.executeDocumentSymbolProvider",
            doc.uri
        )) || [];
    console.log("Raw symbols:", symbols);

    const flatSymbols = flattenSymbols(symbols);
    console.log(`Found ${flatSymbols.length} symbols in ${filePath}`);
    for (const sym of flatSymbols) {
        await handleSymbolLSP({
            fileId,
            filePath,
            code,
            symbol: sym
        });
    }
}

function flattenSymbols(symbols: vscode.DocumentSymbol[]) {
    const result: vscode.DocumentSymbol[] = [];

    function walk(list: vscode.DocumentSymbol[]) {
        for (const s of list) {
            result.push(s);
            if (s.children?.length) {
                walk(s.children);
            }
        }
    }

    walk(symbols);
    return result;
}

function getSymbolRange(symbol: vscode.DocumentSymbol): { startLine: number; endLine: number } {
    const startLine = symbol.range.start.line;
    let endLine = symbol.range.end.line;

    if (symbol.children?.length) {
        for (const child of symbol.children) {
            const childRange = getSymbolRange(child);
            if (childRange.endLine > endLine) {
                endLine = childRange.endLine;
            }
        }
    }

    return { startLine, endLine };
}

async function handleSymbolLSP({
    fileId,
    filePath,
    code,
    symbol
}: {
    fileId: number;
    filePath: string;
    code: string;
    symbol: vscode.DocumentSymbol;
}) {
    console.log(`Indexing symbol: ${symbol.name} (${symbol.kind}) in ${filePath}`);
    const symbolRange = getSymbolRange(symbol);
    const startLine = symbolRange.startLine + 1;
    const endLine = symbolRange.endLine + 1;

    const lines = code.split("\n");

    const chunkText = lines
        .slice(symbolRange.startLine, symbolRange.endLine + 1)
        .join("\n")
        .trim();

    if (!chunkText) return;
    console.log(`Chunk text for symbol ${symbol.name}:\n${chunkText}\n`);
    const hash = sha256(chunkText);

    const symbolName = symbol.name;

    const symbolType = mapSymbolKind(symbol.kind);
    console.log(`Symbol type for ${symbol.name}: ${symbolType}`);
    // insert symbol metadata
    const insertSymbolStmt = db.prepare(
        "INSERT OR REPLACE INTO symbols (file_id, name, type, start_line, end_line) VALUES (?, ?, ?, ?, ?)"
    );
    insertSymbolStmt.run(
        fileId,
        symbolName,
        symbolType,
        startLine,
        endLine
    );
    console.log(`Inserted symbol ${symbolName} of type ${symbolType} into database`);
    // embedding text (VERY IMPORTANT IMPROVEMENT vs your old version)
    const embeddingInput =
        `Name: ${symbolName}\nType: ${symbolType}\n\n${chunkText}`;

    console.log(`Creating embedding for symbol ${symbolName} with input:\n${embeddingInput}\n`);
    const embedding = await createEmbedding(embeddingInput);
    console.log(`Embedding created for symbol ${symbolName}, length: ${embedding.length}`);

    await insertChunk({
        file_id: fileId,
        symbol_name: symbolName,
        symbol_type: symbolType,
        start_line: startLine,
        end_line: endLine,
        hash,
        embedding: JSON.stringify(embedding)
    });
    console.log(`Inserted chunk for symbol ${symbolName} into database`);
}

function mapSymbolKind(kind: vscode.SymbolKind): string {
    switch (kind) {
        case vscode.SymbolKind.Class:
            return "class";

        case vscode.SymbolKind.Method:
            return "method";

        case vscode.SymbolKind.Function:
            return "function";

        case vscode.SymbolKind.Constructor:
            return "constructor";

        case vscode.SymbolKind.Interface:
            return "interface";

        default:
            return "symbol";
    }
}
// async function visit(node: Parser.SyntaxNode, fileId: number) {

//     //----------------------------------
//     // C# Classes
//     //----------------------------------

//     if (node.type === "class_declaration") {

//         const name =
//             node.childForFieldName("name");

//         if (name) {
//             insertSymbol.run(
//                 fileId,
//                 name.text,
//                 "class",
//                 node.startPosition.row + 1,
//                 node.endPosition.row + 1
//             );
//             //generate embedding for the class and save it to the database
//             const embedding = await createEmbedding(name.text);
//             await insertChunk({
//                 file_id: fileId,
//                 symbol_name: name.text,
//                 symbol_type: "class",
//                 start_line: node.startPosition.row + 1,
//                 end_line: node.endPosition.row + 1,
//                 hash: sha256(name.text),
//                 embedding
//             });
//         }
//     }

//     //----------------------------------
//     // TS/JS Functions
//     //----------------------------------

//     if (
//         node.type === "function_declaration"
//     ) {
//         const name =
//             node.childForFieldName("name");

//         if (name) {
//             insertSymbol.run(
//                 fileId,
//                 name.text,
//                 "function",
//                 node.startPosition.row + 1,
//                 node.endPosition.row + 1
//             );
//             //generate embedding for the class and save it to the database
//             const embedding = await createEmbedding(name.text);
//             await insertChunk({
//                 file_id: fileId,
//                 symbol_name: name.text,
//                 symbol_type: "function",
//                 start_line: node.startPosition.row + 1,
//                 end_line: node.endPosition.row + 1,
//                 hash: sha256(name.text),
//                 embedding
//             });
//         }
//     }

//     //----------------------------------
//     // Methods
//     //----------------------------------

//     if (
//         node.type === "method_definition" ||
//         node.type === "method_declaration"
//     ) {
//         const name =
//             node.childForFieldName("name");

//         if (name) {
//             insertSymbol.run(
//                 fileId,
//                 name.text,
//                 "method",
//                 node.startPosition.row + 1,
//                 node.endPosition.row + 1
//             );
//             //generate embedding for the method and save it to the database
//             const embedding = await createEmbedding(name.text);
//             await insertChunk({
//                 file_id: fileId,
//                 symbol_name: name.text,
//                 symbol_type: "method",
//                 start_line: node.startPosition.row + 1,
//                 end_line: node.endPosition.row + 1,
//                 hash: sha256(name.text),
//                 embedding
//             });
//         }
//     }

//     //----------------------------------
//     // TS Imports
//     //----------------------------------

//     if (
//         node.type === "import_statement"
//     ) {
//         const source =
//             node.childForFieldName("source");

//         if (source) {
//             insertDependency.run(
//                 fileId,
//                 source.text.replace(/['"]/g, "")
//             );
//             //generate embedding for the import and save it to the database
//             const embedding = await createEmbedding(source.text);
//             await insertChunk({
//                 file_id: fileId,
//                 symbol_name: source.text,
//                 symbol_type: "import",
//                 start_line: node.startPosition.row + 1,
//                 end_line: node.endPosition.row + 1,
//                 hash: sha256(source.text),
//                 embedding
//             });
//         }
//     }

//     //----------------------------------
//     // C# Using
//     //----------------------------------

//     if (
//         node.type === "using_directive"
//     ) {
//         insertDependency.run(
//             fileId,
//             node.text
//         );
//             //generate embedding for the class and save it to the database
//             const embedding = await createEmbedding(node.text);
//             await insertChunk({
//                 file_id: fileId,
//                 symbol_name: node.text,
//                 symbol_type: "using",
//                 start_line: node.startPosition.row + 1,
//                 end_line: node.endPosition.row + 1,
//                 hash: sha256(node.text),
//                 embedding
//             });
//     }

//     for (const child of node.children) {
//         visit(child, fileId);
//     }
// }

function scanDirectory(dir: string) {

    const entries =
        fs.readdirSync(dir, {
            withFileTypes: true
        });

    for (const entry of entries) {

        const fullPath =
            path.join(dir, entry.name);

        if (entry.isDirectory()) {

            if (
                entry.name === "node_modules" ||
                entry.name === "bin" ||
                entry.name === "obj" ||
                entry.name === ".git"
            ) {
                continue;
            }

            scanDirectory(fullPath);
        }
        else {

            const ext =
                path.extname(fullPath);

            if (
                ext === ".cs" ||
                ext === ".ts" ||
                ext === ".js"
            ) {
                console.log(
                    "Indexing:",
                    fullPath
                );

                indexFile(fullPath);
            }
        }
    }
}

async function createEmbedding(text: string): Promise<number[]> {

    const response = await fetch(
        "http://localhost:11434/api/embeddings",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "nomic-embed-text",
                prompt: text
            })
        }
    );

    const data: any = await response.json();
    console.log("Embedding created for text:", text, "Embedding length:", data?.embedding?.length);
    return data.embedding;
}


/**
 * ---------------------------
 * UTIL: HASH
 * ---------------------------
 */
function sha256(input: string) {
    return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * ---------------------------
 * EMBEDDINGS: Database Operations
 * ---------------------------
 */

const getEmbeddingsStmt = db.prepare(`
    SELECT path, chunk_index, embedding FROM embeddings
`);

const saveEmbeddingStmt = db.prepare(`
    REPLACE INTO embeddings (path, chunk_index, hash, embedding)
    VALUES (?, ?, ?, ?)
`);

const deleteEmbeddingStmt = db.prepare(`
    DELETE FROM embeddings WHERE path = ?
`);

const deleteEmbeddingChunkStmt = db.prepare(`
    DELETE FROM embeddings WHERE path = ? AND chunk_index >= ?
`);

function getEmbeddingsList(): Record<string, number[]> {
    const rows = getAllChunks.all() as any[];
    const result: Record<string, number[]> = {};
    for (const row of rows) {
        result[`${row.id}`] = JSON.parse(row.embedding);
    }
    return result;
}

function saveEmbedding(path: string, chunkIndex: number, hash: string, embedding: number[]) {
    saveEmbeddingStmt.run(path, chunkIndex, hash, JSON.stringify(embedding));
}

function deleteEmbeddingsByPath(path: string) {
    deleteEmbeddingStmt.run(path);
}

function deleteEmbeddingsFromChunk(path: string, startChunk: number) {
    deleteEmbeddingChunkStmt.run(path, startChunk);
}

function getEmbeddingsByPath(path: string): Array<{ chunk_index: number; hash: string; embedding: number[] }> {
    const stmt = db.prepare(`SELECT chunk_index, hash, embedding FROM embeddings WHERE path = ?`);
    const rows = stmt.all(path) as any[];
    return rows.map(row => ({
        chunk_index: row.chunk_index,
        hash: row.hash,
        embedding: JSON.parse(row.embedding)
    }));
}

function getAllSymbols(): Array<{ name: string; type: string; path: string; startLine: number; endLine: number }> {
    const stmt = db.prepare(`
        SELECT s.name, s.type, s.start_line, s.end_line, f.path
        FROM symbols s
        JOIN files f ON f.id = s.file_id
    `);
    const rows = stmt.all() as any[];
    return rows.map(row => ({
        name: row.name,
        type: row.type,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line
    }));
}

function getSymbolsByPaths(paths: string[]): Array<{ name: string; type: string; path: string; startLine: number; endLine: number }> {
    if (paths.length === 0) {
        return [];
    }

    const placeholders = paths.map(() => '?').join(',');
    const stmt = db.prepare(`
        SELECT s.name, s.type, s.start_line, s.end_line, f.path
        FROM symbols s
        JOIN files f ON f.id = s.file_id
        WHERE f.path IN (${placeholders})
    `);
    const rows = stmt.all(...paths) as any[];
    return rows.map(row => ({
        name: row.name,
        type: row.type,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line
    }));
}

function getRelatedSymbolsByPaths(paths: string[]): Array<{ name: string; type: string; path: string }> {
    const symbols = getSymbolsByPaths(paths);
    return symbols.map(({ name, type, path }) => ({ name, type, path }));
}

export function getAllFiles(){
    const rows = getAllDBFiles.all() as any[];
    return rows.map(row => ({
        path: row.path,
        language: row.language,
        modified_time: row.modified_time
    }));
}

export function getChunkById(id:any){
    const row = getDBChunkById.get(id) as any;
    if (!row) return null;
    return {
        id: row.id,
        path: row.path,
        start_line: row.start_line,
        end_line: row.end_line,
        hash: row.hash,
        symbol_name: row.symbol_name,
        symbol_type: row.symbol_type,
        embedding: JSON.parse(row.embedding)
    };
}
// Export functions for use in extension
export {
    indexFile,
    scanDirectory,
    createEmbedding,
    getEmbeddingsList,
    saveEmbedding,
    deleteEmbeddingsByPath,
    deleteEmbeddingsFromChunk,
    getEmbeddingsByPath,
    getAllSymbols,
    getRelatedSymbolsByPaths
};