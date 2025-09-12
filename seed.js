// seed.js AGGIORNATO V4.2 - Con Debug Avanzato sul contenuto della cartella
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

// --- PERCORSI DI TUTTE LE SORGENTI DATI ---
const THESIS_DIR_PATH = path.join(__dirname, 'vault', 'tesi');
const CSV_DIR_PATH = path.join(__dirname, 'vault', 'csv_files'); 
const OLD_CSV_PATH = path.join(__dirname, 'vault', 'note_finali_con_link.csv');

async function seedDatabase() {
  console.log('🚀 Avvio dello script di seeding (V4.2 - Con Debug Avanzato)...');
  const client = await pool.connect();

  try {
    console.log('🧹 Pulizia delle tabelle esistenti...');
    await client.query('TRUNCATE TABLE links, nodes, reading_history, bug_reports RESTART IDENTITY CASCADE');

    const titleToIdMap = new Map();
    const allContentData = [];

    // --- 1. LETTURA CAPITOLI TESI (MARKDOWN) ---
    console.log(`📚 1/3: Lettura capitoli tesi dal vault...`);
    const thesisFiles = fs.readdirSync(THESIS_DIR_PATH).filter(file => file.endsWith('.md'));
    for (const file of thesisFiles) {
        const title = path.basename(file, '.md');
        if (!titleToIdMap.has(title)) {
            const content = fs.readFileSync(path.join(THESIS_DIR_PATH, file), 'utf-8');
            const res = await client.query(
                "INSERT INTO nodes (title, content, type, status) VALUES ($1, $2, 'tesi', 'approved') RETURNING id",
                [title, content]
            );
            const newId = res.rows[0].id;
            titleToIdMap.set(title, newId);
            allContentData.push({ id: newId, content });
        }
    }
    console.log(`✅ Inseriti ${titleToIdMap.size} nodi dalla tesi.`);

    // --- 2. LETTURA NUOVI FILE CSV (MULTIPLI) ---
    console.log(`📑 2/3: Lettura dei nuovi file CSV...`);
    console.log(`   -> Sto cercando nella cartella: ${CSV_DIR_PATH}`);

    if (!fs.existsSync(CSV_DIR_PATH)) {
        console.error(`❌ ERRORE FATALE: La cartella specificata non esiste! Verifica il percorso.`);
        process.exit(1);
    }

    // --- NUOVO DEBUG: Mostra tutti i file trovati nella cartella ---
    const allFilesInDir = fs.readdirSync(CSV_DIR_PATH);
    console.log(`   -> Contenuto della cartella trovato (${allFilesInDir.length} elementi):`, allFilesInDir);
    // --- FINE NUOVO DEBUG ---

    const csvFiles = allFilesInDir.filter(file => file.toLowerCase().endsWith('.csv'));
    let newCsvNodes = 0;
    
    for (const file of csvFiles) {
        const filePath = path.join(CSV_DIR_PATH, file);
        const csvRows = await new Promise((resolve, reject) => {
            const rows = [];
            fs.createReadStream(filePath).pipe(csv())
                .on('data', (row) => rows.push(row))
                .on('end', () => resolve(rows))
                .on('error', reject);
        });
        for (const row of csvRows) {
            const title = row.Titolo_Nota_Atomica;
            const content = row.Nota_Markdown;
            if (title && content && !titleToIdMap.has(title)) {
                const res = await client.query(
                    "INSERT INTO nodes (title, content, type, status) VALUES ($1, $2, 'nota', 'approved') RETURNING id",
                    [title, content]
                );
                const newId = res.rows[0].id;
                titleToIdMap.set(title, newId);
                allContentData.push({ id: newId, content });
                newCsvNodes++;
            }
        }
    }
    console.log(`✅ Inseriti ${newCsvNodes} nuovi nodi da ${csvFiles.length} file CSV.`);
    
    // --- 3. LETTURA VECCHIO FILE CSV SINGOLO ---
    console.log(`🗂️ 3/3: Lettura del vecchio file CSV di fallback...`);
    let oldCsvNodes = 0;
    if (fs.existsSync(OLD_CSV_PATH)) {
        const oldCsvRows = await new Promise((resolve, reject) => {
            const rows = [];
            fs.createReadStream(OLD_CSV_PATH).pipe(csv())
                .on('data', (row) => rows.push(row))
                .on('end', () => resolve(rows))
                .on('error', reject);
        });
        for (const row of oldCsvRows) {
            const title = row.Titolo_Nota_Atomica;
            const content = row.Nota_Markdown;
            if (title && content && !titleToIdMap.has(title)) {
                const res = await client.query(
                    "INSERT INTO nodes (title, content, type, status) VALUES ($1, $2, 'nota', 'approved') RETURNING id",
                    [title, content]
                );
                const newId = res.rows[0].id;
                titleToIdMap.set(title, newId);
                allContentData.push({ id: newId, content });
                oldCsvNodes++;
            }
        }
        console.log(`✅ Inseriti ${oldCsvNodes} nodi unici dal vecchio file CSV.`);
    } else {
        console.warn('⚠️ Vecchio file CSV non trovato, saltato.');
    }
    
    // --- 4. CREAZIONE LINK (INVARIATO) ---
    console.log('🔗 Creazione di tutti i collegamenti...');
    let createdLinksCount = 0;
    const linkRegex = /\[\[(.*?)\]\]/g;
    for (const data of allContentData) {
        const sourceId = data.id;
        const matches = [...data.content.matchAll(linkRegex)];
        for (const match of matches) {
            let targetTitle = match[1].trim();
            if (!targetTitle) continue;
            let targetId = titleToIdMap.get(targetTitle);
            if (!targetId) {
                const res = await client.query(
                    "INSERT INTO nodes (title, content, type, status) VALUES ($1, $2, 'autore', 'approved') RETURNING id",
                    [targetTitle, 'Nodo per ' + targetTitle + ' generato automaticamente.']
                );
                targetId = res.rows[0].id;
                titleToIdMap.set(targetTitle, targetId);
            }
            await client.query('INSERT INTO links (source_node_id, target_node_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [sourceId, targetId]);
            createdLinksCount++;
        }
    }
    console.log(`✅ Creati ${createdLinksCount} collegamenti. Totale nodi nel grafo: ${titleToIdMap.size}.`);

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

