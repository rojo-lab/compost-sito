// seed.js FINALE v5.2 - Normalizzazione definitiva per link perfetti
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DB_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// VERSIONE DEFINITIVA DELLA FUNZIONE: Gestisce anche diversi tipi di trattini
const normalizeTitle = (str) => {
    if (!str) return '';
    return str
        .toLowerCase()
        .replace(/’|‘|`/g, "'")       // Standardizza gli apostrofi
        .replace(/–|-/g, '-')         // Standardizza tutti i trattini in un trattino semplice
        .replace(/^\d+[\s.-]*/, '')   // Rimuove la numerazione iniziale
        .replace(/[^\w\s-]/g, '')     // Rimuove altri caratteri non alfanumerici
        .replace(/\s+/g, ' ')         // Accorpa spazi multipli
        .trim();
};

const setupDatabaseSchema = async (client) => {
    console.log('🧹 Eliminazione (DROP) delle tabelle esistenti per un reset completo...');
    await client.query(`
        DROP TABLE IF EXISTS links CASCADE;
        DROP TABLE IF EXISTS reading_history CASCADE;
        DROP TABLE IF EXISTS bug_reports CASCADE;
        DROP TABLE IF EXISTS nodes CASCADE;
        DROP TABLE IF EXISTS users CASCADE;
    `);

    console.log('🏗️  Ricostruzione dello schema del database...');
    await client.query(`
        CREATE TABLE users (
            id SERIAL PRIMARY KEY,
            email VARCHAR(255) UNIQUE NOT NULL,
            password_hash VARCHAR(255),
            google_id VARCHAR(255) UNIQUE,
            role VARCHAR(50) DEFAULT 'user',
            reset_password_token VARCHAR(255),
            reset_password_expires TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE nodes (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            type VARCHAR(50) NOT NULL,
            status VARCHAR(50) DEFAULT 'pending',
            author_id INTEGER REFERENCES users(id),
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE links (
            source_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
            target_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
            PRIMARY KEY (source_node_id, target_node_id)
        );

        CREATE TABLE reading_history (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
            PRIMARY KEY (user_id, node_id)
        );

        CREATE TABLE bug_reports (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            report_text TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);
    console.log('✅ Schema ricostruito con successo.');
};

const THESIS_DIR_PATH = path.join(__dirname, 'vault', 'tesi');
const CSV_DIR_PATH = path.join(__dirname, 'vault', 'csv_files'); 
const QUESTIONS_CSV_PATH = path.join(__dirname, 'vault', 'csv_files', 'domande.csv');

async function seedDatabase() {
  console.log('🚀 Avvio dello script di seeding (con titoli brevi per le domande)...');
  const client = await pool.connect();

  try {
    await setupDatabaseSchema(client);

    const titleToIdMap = new Map();
    const allContentData = [];
    const processedContent = new Set();
    const questionLinksToCreate = [];
    const normalizedTitleToIdMap = new Map();

    // --- 1. LETTURA CAPITOLI TESI (MARKDOWN) ---
    console.log(`📚 1/4: Lettura capitoli tesi dal vault...`);
    const thesisFiles = fs.readdirSync(THESIS_DIR_PATH).filter(file => file.endsWith('.md'));
    for (const file of thesisFiles) {
        const title = path.basename(file, '.md');
        const content = fs.readFileSync(path.join(THESIS_DIR_PATH, file), 'utf-8');
        
        if (content && !titleToIdMap.has(title) && !processedContent.has(content.trim())) {
            const res = await client.query("INSERT INTO nodes (title, content, type, status) VALUES ($1, $2, 'tesi', 'approved') RETURNING id", [title, content]);
            const newId = res.rows[0].id;
            titleToIdMap.set(title, newId);
            processedContent.add(content.trim());
            allContentData.push({ id: newId, content });
            normalizedTitleToIdMap.set(normalizeTitle(title), newId);
        } else if (title) {
            if (titleToIdMap.has(title)) console.warn(`🟡 SKIPPED (Titolo duplicato): "${title}"`);
            else console.warn(`🟡 SKIPPED (Contenuto duplicato): "${title}"`);
        }
    }
    console.log(`✅ Inseriti ${titleToIdMap.size} nodi unici dalla tesi.`);

    // --- 2. LETTURA NOTE E AUTORI (CSV MULTIPLI) ---
    console.log(`📑 2/4: Lettura di note e autori dai file CSV...`);
    const csvFiles = fs.readdirSync(CSV_DIR_PATH).filter(file => file.toLowerCase().endsWith('.csv') && file.toLowerCase() !== 'domande.csv');
    let newCsvNodes = 0;
    for (const file of csvFiles) {
        const filePath = path.join(CSV_DIR_PATH, file);
        const csvRows = await new Promise((resolve, reject) => {
            const rows = [];
            fs.createReadStream(filePath).pipe(csv()).on('data', (row) => rows.push(row)).on('end', () => resolve(rows)).on('error', reject);
        });
        for (const row of csvRows) {
            const title = row.Titolo_Nota_Atomica;
            const content = row.Nota_Markdown;
            if (title && content && !titleToIdMap.has(title) && !processedContent.has(content.trim())) {
                const res = await client.query("INSERT INTO nodes (title, content, type, status) VALUES ($1, $2, 'nota', 'approved') RETURNING id", [title, content]);
                const newId = res.rows[0].id;
                titleToIdMap.set(title, newId);
                processedContent.add(content.trim());
                allContentData.push({ id: newId, content });
                normalizedTitleToIdMap.set(normalizeTitle(title), newId);
                newCsvNodes++;
            } else if (title) {
                 if (titleToIdMap.has(title)) console.warn(`🟡 SKIPPED (Titolo duplicato): "${title}"`);
                 else console.warn(`🟡 SKIPPED (Contenuto duplicato): "${title}"`);
            }
        }
    }
    console.log(`✅ Inseriti ${newCsvNodes} nuovi nodi unici (note/autori).`);
    
    // --- 3. LETTURA E INSERIMENTO DOMANDE ---
    console.log('❓ 3/4: Lettura e inserimento delle domande...');
    let questionNodes = 0;
    const questionCounters = {};

    if (fs.existsSync(QUESTIONS_CSV_PATH)) {
        const questionRows = await new Promise((resolve, reject) => {
            const rows = [];
            fs.createReadStream(QUESTIONS_CSV_PATH).pipe(csv()).on('data', (row) => rows.push(row)).on('end', () => resolve(rows)).on('error', reject);
        });

        for (const row of questionRows) {
            const content = row.Titolo_Nodo_Domanda;
            const chapterToLink = row.Capitolo_Associato;

            questionCounters[chapterToLink] = (questionCounters[chapterToLink] || 0) + 1;
            const title = `${chapterToLink} (Domanda #${questionCounters[chapterToLink]})`;
            
            if (content && !processedContent.has(content.trim())) {
                const res = await client.query(
                    "INSERT INTO nodes (title, content, type, status) VALUES ($1, $2, 'domanda', 'approved') RETURNING id",
                    [title, content]
                );
                const newId = res.rows[0].id;
                titleToIdMap.set(title, newId);
                processedContent.add(content.trim());
                allContentData.push({ id: newId, content });
                normalizedTitleToIdMap.set(normalizeTitle(title), newId);
                questionNodes++;

                const normalizedChapter = normalizeTitle(chapterToLink);
                if (normalizedTitleToIdMap.has(normalizedChapter)) {
                    questionLinksToCreate.push({ source: newId, target: normalizedTitleToIdMap.get(normalizedChapter) });
                } else {
                    console.warn(`- ATTENZIONE: Capitolo "${chapterToLink}" non trovato. Link non creato per la domanda: "${content.substring(0, 30)}..."`);
                }

            } else if (content) {
                console.warn(`🟡 SKIPPED (Contenuto duplicato): "${content.substring(0, 50)}..."`);
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
                const res = await client.query("INSERT INTO nodes (title, content, type, status) VALUES ($1, $2, 'autore', 'approved') RETURNING id", [targetTitle, 'Nodo per ' + targetTitle + ' generato automaticamente.']);
                targetId = res.rows[0].id;
                titleToIdMap.set(targetTitle, targetId);
                normalizedTitleToIdMap.set(normalizeTitle(targetTitle), targetId);
            }
            await client.query('INSERT INTO links (source_node_id, target_node_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [sourceId, targetId]);
            createdLinksCount++;
        }
    }
    
    console.log('🔗 Creazione collegamenti tra domande e capitoli...');
    for (const link of questionLinksToCreate) {
        await client.query('INSERT INTO links (source_node_id, target_node_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [link.source, link.target]);
        createdLinksCount++;
    }

    console.log(`✅ Creati ${createdLinksCount} collegamenti. Totale nodi unici nel grafo: ${titleToIdMap.size}.`);

  } catch (error) {
    console.error('❌ ERRORE DURANTE IL SEEDING:', error);
  } finally {
    console.log('🔚 Seeding completato. Rilascio della connessione al database.');
    client.release();
  }
}

seedDatabase().then(() => {
  pool.end();
});