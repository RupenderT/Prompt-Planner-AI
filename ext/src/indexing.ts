import * as vscode from "vscode";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import initSqlJs from 'sql.js';

// import Parser from "tree-sitter";
// import { typescript } from "tree-sitter-typescript";
//import CSharp from "tree-sitter-c-sharp";




let db: any = null;
let SQL: any = null;
let DB_FILE: string = '';

export function setStoragePath(workspacePath: string) {
    DB_FILE = path.join(workspacePath, 'codeindex2.db');
}

async function initDatabase() {
    if (db) return db;
    
    if (!DB_FILE) {
        throw new Error('Storage path not set. Call setStoragePath() first.');
    }
    
    SQL = await initSqlJs();

    if (fs.existsSync(DB_FILE)) {
        const buf = fs.readFileSync(DB_FILE);
        db = new SQL.Database(new Uint8Array(buf));
    } else {
        db = new SQL.Database();
    }

    // ensure tables exist
    db.run(`
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

    persistDb();
    return db;
}

function persistDb() {
    if (!db) return;
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_FILE, buffer);
}


export async function printTableCounts() {
    await initDatabase();
    const tables = ["files", "symbols", "dependencies", "chunks", "embeddings"];
    for (const table of tables) {
        const stmt = db.prepare(`SELECT COUNT(*) as count FROM ${table}`);
        let row: any = null;
        if (stmt.step()) row = stmt.getAsObject();
        stmt.free();
        console.log(`${table}: ${row?.count ?? 0}`);
    }
}

async function upsertFile(filePath: string, language: string, mtime: number) {
    await initDatabase();
    const stmt = db.prepare(`
        INSERT INTO files(path, language, modified_time)
        VALUES (?, ?, ?)
        ON CONFLICT(path)
        DO UPDATE SET 
            language = excluded.language,
            modified_time = excluded.modified_time
    `);
    stmt.bind([filePath, language, mtime]);
    stmt.step();
    stmt.free();
    persistDb();
    return true;
}

async function insertChunk(chunk: any) {
    await initDatabase();
    const stmt = db.prepare(`INSERT INTO chunks(
        file_id,
        symbol_name,
        symbol_type,
        start_line,
        end_line,
        hash,
        embedding
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    stmt.bind([
        chunk.file_id,
        chunk.symbol_name,
        chunk.symbol_type,
        chunk.start_line,
        chunk.end_line,
        chunk.hash,
        chunk.embedding
    ]);
    stmt.step();
    stmt.free();
    persistDb();
}
async function getFileIdForPath(filePath: string) {
    await initDatabase();
    const stmt = db.prepare(`SELECT id FROM files WHERE path = ?`);
    stmt.bind([filePath]);
    let row = null;
    if (stmt.step()) row = stmt.getAsObject();
    stmt.free();
    return row?.id;
}

async function findFileByPathSQL(filePath: string) {
    await initDatabase();
    const stmt = db.prepare(`SELECT path, language, modified_time FROM files WHERE path = ?`);
    stmt.bind([filePath]);
    let row = null;
    if (stmt.step()) row = stmt.getAsObject();
    stmt.free();
    return row;
}

async function getAllChunksSQL() {
    await initDatabase();
    const stmt = db.prepare(`SELECT * FROM chunks`);
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
}

async function getDBChunkByIdSQL(id: any) {
    await initDatabase();
    const stmt = db.prepare(`SELECT * FROM chunks join files ON chunks.file_id = files.id WHERE chunks.id = ?`);
    stmt.bind([id]);
    let row = null;
    if (stmt.step()) row = stmt.getAsObject();
    stmt.free();
    return row;
}

async function insertSymbolSQL(file_id: number, name: string, type: string, start_line: number, end_line: number) {
    await initDatabase();
    const stmt = db.prepare(`INSERT INTO symbols(file_id, name, type, start_line, end_line) VALUES (?, ?, ?, ?, ?)`);
    stmt.bind([file_id, name, type, start_line, end_line]);
    stmt.step();
    stmt.free();
    persistDb();
}

async function insertDependencySQL(file_id: number, dependency: string) {
    await initDatabase();
    const stmt = db.prepare(`INSERT INTO dependencies(file_id, dependency) VALUES (?, ?)`);
    stmt.bind([file_id, dependency]);
    stmt.step();
    stmt.free();
    persistDb();
}

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

// function buildParser(language: string) {
//     const parser = new Parser();

//     if (language === "csharp") {
//         parser.setLanguage(csharp);
//     } else {
//         parser.setLanguage(typescript);
//     }

//     return parser;
// }
async function indexFile(filePath: string) {
    const language = getLanguage(filePath);
    if (!language) return;

    const stat = fs.statSync(filePath);
    const currentMtime = stat.mtimeMs;

    // Check DB for existing modified_time
    const filerow = await findFileByPathSQL(filePath) as any;

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
    const fileId = await getFileIdForPath(filePath) as any;
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
    await insertSymbolSQL(fileId, symbolName, symbolType, startLine, endLine);
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

async function getEmbeddingsList(): Promise<Record<string, number[]>> {
    const rows = await getAllChunksSQL();
    const result: Record<string, number[]> = {};
    for (const row of rows) {
        try {
            result[`${row.id}`] = JSON.parse(row.embedding);
        } catch (e) {
            result[`${row.id}`] = [];
        }
    }
    return result;
}

async function saveEmbedding(pathStr: string, chunkIndex: number, hash: string, embedding: number[]) {
    await initDatabase();
    const stmt = db.prepare(`REPLACE INTO embeddings (path, chunk_index, hash, embedding) VALUES (?, ?, ?, ?)`);
    stmt.bind([pathStr, chunkIndex, hash, JSON.stringify(embedding)]);
    stmt.step();
    stmt.free();
    persistDb();
}

async function deleteEmbeddingsByPath(pathStr: string) {
    await initDatabase();
    const stmt = db.prepare(`DELETE FROM embeddings WHERE path = ?`);
    stmt.bind([pathStr]);
    stmt.step();
    stmt.free();
    persistDb();
}

async function deleteEmbeddingsFromChunk(pathStr: string, startChunk: number) {
    await initDatabase();
    const stmt = db.prepare(`DELETE FROM embeddings WHERE path = ? AND chunk_index >= ?`);
    stmt.bind([pathStr, startChunk]);
    stmt.step();
    stmt.free();
    persistDb();
}

async function getEmbeddingsByPath(pathStr: string): Promise<Array<{ chunk_index: number; hash: string; embedding: number[] }>> {
    await initDatabase();
    const stmt = db.prepare(`SELECT chunk_index, hash, embedding FROM embeddings WHERE path = ?`);
    stmt.bind([pathStr]);
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows.map(row => ({
        chunk_index: row.chunk_index,
        hash: row.hash,
        embedding: JSON.parse(row.embedding)
    }));
}

async function getAllSymbols(): Promise<Array<{ name: string; type: string; path: string; startLine: number; endLine: number }>> {
    await initDatabase();
    const stmt = db.prepare(`
        SELECT s.name, s.type, s.start_line, s.end_line, f.path
        FROM symbols s
        JOIN files f ON f.id = s.file_id
    `);
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows.map(row => ({
        name: row.name,
        type: row.type,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line
    }));
}

async function getSymbolsByPaths(paths: string[]): Promise<Array<{ name: string; type: string; path: string; startLine: number; endLine: number }>> {
    await initDatabase();
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
    stmt.bind(paths);
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows.map(row => ({
        name: row.name,
        type: row.type,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line
    }));
}

async function getRelatedSymbolsByPaths(paths: string[]): Promise<Array<{ name: string; type: string; path: string }>> {
    const symbols = await getSymbolsByPaths(paths);
    return symbols.map(({ name, type, path }) => ({ name, type, path }));
}

export async function getAllFiles(){
    await initDatabase();
    const stmt = db.prepare(`SELECT path, language, modified_time FROM files`);
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows.map(row => ({
        path: row.path,
        language: row.language,
        modified_time: row.modified_time
    }));
}

export async function getChunkById(id:any){
    const row = await getDBChunkByIdSQL(id) as any;
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