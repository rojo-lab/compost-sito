// seed.js MIGRATO A SQLITE v1.0
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const sqlite3 = require('sqlite3').verbose(); // Importa la nuova libreria

// --- CONFIGURAZIONE DATABASE SQLITE ---
const DB_FILE = path.join(__dirname, 'compost.db');
// Rimuovi il vecchio file DB se esiste, per partire da zero
if (fs.existsSync(DB_FILE)) {
    fs.unlinkSync(DB_FILE);
    console.log('Vecchio file compost.db eliminato.');
}
const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        return console.error("Errore connessione a SQLite:", err.message);
    }
    console.log('✅ Connesso al database SQLite locale (compost.db).');
});

// Funzione di normalizzazione (invariata)
const normalizeTitle = (str) => {
    if (!str) return '';
    return str
        .toLowerCase()
        .replace(/’|‘|`/g, "'")
        .replace(/–|-/g, '-')
        .replace(/^\d+[\s.-]*/, '')
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
};

// Funzione per creare lo schema del database con sintassi SQLite
const setupDatabaseSchema = () => {
    return new Promise((resolve, reject) => {
        console.log('🏗️  Costruzione dello schema del database per SQLite...');
        db.serialize(() => {
            db.run(`
                CREATE TABLE users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT UNIQUE NOT NULL,
                    password_hash TEXT,
                    google_id TEXT UNIQUE,
                    role TEXT DEFAULT 'user',
                    reset_password_token TEXT,
                    reset_password_expires DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);

            db.run(`
                CREATE TABLE nodes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    type TEXT NOT NULL,
                    status TEXT DEFAULT 'pending',
                    author_id INTEGER,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL
                );
            `);

            db.run(`
                CREATE TABLE links (
                    source_node_id INTEGER NOT NULL,
                    target_node_id INTEGER NOT NULL,
                    PRIMARY KEY (source_node_id, target_node_id),
                    FOREIGN KEY (source_node_id) REFERENCES nodes (id) ON DELETE CASCADE,
                    FOREIGN KEY (target_node_id) REFERENCES nodes (id) ON DELETE CASCADE
                );
            `);

            db.run(`
                CREATE TABLE reading_history (
                    user_id INTEGER NOT NULL,
                    node_id INTEGER NOT NULL,
                    PRIMARY KEY (user_id, node_id),
                    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                    FOREIGN KEY (node_id) REFERENCES nodes (id) ON DELETE CASCADE
                );
            `);

            db.run(`
                CREATE TABLE bug_reports (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    report_text TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
                );
            `, (err) => {
                if (err) return reject(err);
                console.log('✅ Schema SQLite creato con successo.');
                resolve();
            });
        });
    });
};

// Funzioni helper per usare async/await con sqlite3
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve({ lastID: this.lastID });
    });
});

const THESIS_DIR_PATH = path.join(__dirname, 'vault', 'tesi');
const CSV_DIR_PATH = path.join(__dirname, 'vault', 'csv_files'); 
const QUESTIONS_CSV_PATH = path.join(__dirname, 'vault', 'csv_files', 'domande.csv');

async function seedDatabase() {
  console.log('🚀 Avvio dello script di seeding per SQLite...');

  try {
    await setupDatabaseSchema();

    const titleToIdMap = new Map();
    const allContentData = [];
    const processedContent = new Set();
    const questionLinksToCreate = [];
    const normalizedTitleToIdMap = new Map();

    // --- 1. LETTURA CAPITOLI TESI (MARKDOWN) ---
    console.log(`📚 1/4: Lettura capitoli tesi...`);
    const thesisFiles = fs.readdirSync(THESIS_DIR_PATH).filter(file => file.endsWith('.md'));
    for (const file of thesisFiles) {
        const title = path.basename(file, '.md');
        const content = fs.readFileSync(path.join(THESIS_DIR_PATH, file), 'utf-8');
        
        if (content && !processedContent.has(content.trim())) {
            const result = await dbRun("INSERT INTO nodes (title, content, type, status) VALUES (?, ?, 'tesi', 'approved')", [title, content]);
            const newId = result.lastID;
            titleToIdMap.set(title, newId);
            processedContent.add(content.trim());
            allContentData.push({ id: newId, content });
            normalizedTitleToIdMap.set(normalizeTitle(title), newId);
        } else if (title) {
            console.warn(`🟡 SKIPPED (Duplicato): "${title}"`);
        }
    }
    console.log(`✅ Inseriti ${titleToIdMap.size} nodi unici dalla tesi.`);

    // --- 2. LETTURA NOTE E AUTORI (CSV MULTIPLI) ---
    console.log(`📑 2/4: Lettura di note e autori...`);
    const csvFiles = fs.readdirSync(CSV_DIR_PATH).filter(file => file.toLowerCase().endsWith('.csv') && file.toLowerCase() !== 'domande.csv');
    let newCsvNodes = 0;
    for (const file of csvFiles) {
        const filePath = path.join(CSV_DIR_PATH, file);
        const csvRows = await new Promise((resolve) => {
            const rows = [];
            fs.createReadStream(filePath).pipe(csv()).on('data', (row) => rows.push(row)).on('end', () => resolve(rows));
        });
        for (const row of csvRows) {
            const title = row.Titolo_Nota_Atomica;
            const content = row.Nota_Markdown;
            if (title && content && !processedContent.has(content.trim())) {
                const result = await dbRun("INSERT INTO nodes (title, content, type, status) VALUES (?, ?, 'nota', 'approved')", [title, content]);
                const newId = result.lastID;
                titleToIdMap.set(title, newId);
                processedContent.add(content.trim());
                allContentData.push({ id: newId, content });
                normalizedTitleToIdMap.set(normalizeTitle(title), newId);
                newCsvNodes++;
            } else if (title) {
                console.warn(`🟡 SKIPPED (Duplicato): "${title}"`);
            }
        }
    }
    console.log(`✅ Inseriti ${newCsvNodes} nuovi nodi unici (note/autori).`);
    
    // --- 3. LETTURA E INSERIMENTO DOMANDE ---
    console.log('❓ 3/4: Lettura e inserimento delle domande...');
    let questionNodes = 0;
    const questionCounters = {};
    if (fs.existsSync(QUESTIONS_CSV_PATH)) {
        const questionRows = await new Promise((resolve) => {
            const rows = [];
            fs.createReadStream(QUESTIONS_CSV_PATH).pipe(csv()).on('data', (row) => rows.push(row)).on('end', () => resolve(rows));
        });
        for (const row of questionRows) {
            const content = row.Titolo_Nodo_Domanda;
            const chapterToLink = row.Capitolo_Associato;
            questionCounters[chapterToLink] = (questionCounters[chapterToLink] || 0) + 1;
            const title = `${chapterToLink} (Domanda #${questionCounters[chapterToLink]})`;
            
            if (content && !processedContent.has(content.trim())) {
                const result = await dbRun("INSERT INTO nodes (title, content, type, status) VALUES (?, ?, 'domanda', 'approved')", [title, content]);
                const newId = result.lastID;
                titleToIdMap.set(title, newId);
                processedContent.add(content.trim());
                allContentData.push({ id: newId, content });
                normalizedTitleToIdMap.set(normalizeTitle(title), newId);
                questionNodes++;
                const normalizedChapter = normalizeTitle(chapterToLink);
                if (normalizedTitleToIdMap.has(normalizedChapter)) {
                    questionLinksToCreate.push({ source: newId, target: normalizedTitleToIdMap.get(normalizedChapter) });
                } else {
                    console.warn(`- ATTENZIONE: Capitolo "${chapterToLink}" non trovato. Link non creato.`);
                }
            } else if (content) {
                console.warn(`🟡 SKIPPED (Duplicato): "${content.substring(0, 50)}..."`);
            }
        }
        console.log(`✅ Inserite ${questionNodes} domande uniche.`);
    } else {
        console.warn('⚠️ File domande.csv non trovato, saltato.');
    }

    // --- 4. CREAZIONE LINK ---
    console.log('🔗 4/4: Creazione di tutti i collegamenti...');
    let createdLinksCount = 0;
    const linkRegex = /\[\[(.*?)\]\]/g;
    
    for (const data of allContentData) {
        if (typeof data.content !== 'string') continue;
        const sourceId = data.id;
        const matches = [...data.content.matchAll(linkRegex)];
        for (const match of matches) {
            let targetTitle = match[1].trim();
            if (!targetTitle) continue;
            let targetId = normalizedTitleToIdMap.get(normalizeTitle(targetTitle));
            if (!targetId) {
                const result = await dbRun("INSERT INTO nodes (title, content, type, status) VALUES (?, ?, 'autore', 'approved')", [targetTitle, 'Nodo per ' + targetTitle + ' generato automaticamente.']);
                targetId = result.lastID;
                titleToIdMap.set(targetTitle, targetId);
                normalizedTitleToIdMap.set(normalizeTitle(targetTitle), targetId);
            }
            await dbRun('INSERT INTO links (source_node_id, target_node_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [sourceId, targetId]);
            createdLinksCount++;
        }
    }
    
    console.log('🔗 Creazione collegamenti tra domande e capitoli...');
    for (const link of questionLinksToCreate) {
        await dbRun('INSERT INTO links (source_node_id, target_node_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [link.source, link.target]);
        createdLinksCount++;
    }

    console.log(`✅ Creati ${createdLinksCount} collegamenti. Totale nodi unici nel grafo: ${titleToIdMap.size}.`);

  } catch (error) {
    console.error('❌ ERRORE DURANTE IL SEEDING:', error);
  } finally {
    db.close((err) => {
        if (err) {
            return console.error(err.message);
        }
        console.log('🔚 Connessione al database SQLite chiusa.');
    });
  }
}

seedDatabase();