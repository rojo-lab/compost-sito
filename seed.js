// seed.js AGGIORNATO CON CREAZIONE DINAMICA DEI NODI
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT,
});

const CSV_PATH = path.join(__dirname, 'vault', 'note_finali_con_link.csv');
const THESIS_DIR_PATH = path.join(__dirname, 'vault', 'tesi');

async function seedDatabase() {
    console.log('🚀 Avvio dello script di seeding (V2 - con creazione dinamica nodi)...');
    const client = await pool.connect();

    try {
        console.log('🧹 Pulizia delle tabelle esistenti...');
        await client.query('TRUNCATE TABLE links, nodes RESTART IDENTITY CASCADE');

        const titleToIdMap = new Map();
        const allContentData = [];

        console.log(`📚 Lettura capitoli tesi...`);
        const thesisFiles = fs.readdirSync(THESIS_DIR_PATH).filter(file => file.endsWith('.md'));
        for (const file of thesisFiles) {
            const title = path.basename(file, '.md');
            const content = fs.readFileSync(path.join(THESIS_DIR_PATH, file), 'utf-8');
            const res = await client.query(
                "INSERT INTO nodes (title, content, type, status) VALUES ($1, $2, 'tesi', 'approved') RETURNING id",
                [title, content]
            );
            const newId = res.rows[0].id;
            titleToIdMap.set(title, newId);
            allContentData.push({ id: newId, content });
        }
        console.log(`✅ Inseriti ${thesisFiles.length} capitoli.`);

        console.log(`📑 Lettura note bibliografiche...`);
        const csvRows = [];
        await new Promise((resolve, reject) => {
            fs.createReadStream(CSV_PATH)
                .pipe(csv())
                .on('data', (row) => csvRows.push(row))
                .on('end', resolve)
                .on('error', reject);
        });
        let csvCount = 0;
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
                csvCount++;
            }
        }
        console.log(`✅ Inserite ${csvCount} note.`);

        console.log('🔗 Creazione dei collegamenti...');
        let createdLinksCount = 0;
        const linkRegex = /\[\[(.*?)\]\]/g;

        for (const data of allContentData) {
            const sourceId = data.id;
            const matches = [...data.content.matchAll(linkRegex)];
            for (const match of matches) {
                let targetTitle = match[1];
                
                // Pulisce eventuali spazi extra
                targetTitle = targetTitle.trim();

                // Ignora link vuoti come [[]]
                if (!targetTitle) continue;

                let targetId = titleToIdMap.get(targetTitle);

                // --- NUOVA LOGICA ---
                // Se il nodo di destinazione non esiste, crealo al volo!
                if (!targetId) {
                    console.log(`🌱 Collegamento a "${targetTitle}" non trovato. Creo un nuovo nodo-hub...`);
                    const res = await client.query(
                        // Usiamo un nuovo tipo 'autore' per questi nodi generati
                        "INSERT INTO nodes (title, content, type, status) VALUES ($1, $2, 'autore', 'approved') RETURNING id",
                        [targetTitle, 'Nodo per ' + targetTitle + ' generato automaticamente.']
                    );
                    targetId = res.rows[0].id;
                    // Aggiungi il nuovo nodo alla mappa per trovarlo la prossima volta
                    titleToIdMap.set(targetTitle, targetId);
                }
                
                // Ora che siamo sicuri che targetId esista, creiamo il link
                await client.query('INSERT INTO links (source_node_id, target_node_id) VALUES ($1, $2)', [sourceId, targetId]);
                createdLinksCount++;
            }
        }
        console.log(`✅ Creati ${createdLinksCount} collegamenti.`);

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