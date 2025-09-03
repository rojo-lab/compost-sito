// Importa la libreria dotenv per leggere il file .env
require('dotenv').config();

console.log('--- Inizio Test di Configurazione .env ---');

// Leggiamo alcune variabili chiave dal file
const port = process.env.PORT;
const dbUrl = process.env.DB_URL;
const frontendUrl = process.env.FRONTEND_URL;

// Controlliamo se esistono e le stampiamo
console.log('PORT:', port ? `OK (${port})` : '⛔️ MANCANTE!');
console.log('DB_URL:', dbUrl ? `OK (inizia con "${dbUrl.substring(0, 20)}...")` : '⛔️ MANCANTE!');
console.log('FRONTEND_URL:', frontendUrl ? `OK (${frontendUrl})` : '⛔️ MANCANTE!');

console.log('\n--- Test Completato ---');

if (!port || !dbUrl || !frontendUrl) {
  console.error('\n⚠️ ATTENZIONE: Una o più variabili fondamentali non sono state caricate!');
} else {
  console.log('\n✅ Successo! Tutte le variabili di test sono state caricate correttamente.');
}