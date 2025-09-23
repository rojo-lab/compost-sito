// --- IMPORTAZIONE MODULI ---
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const path = require('path');
const crypto = require('crypto');
const sgMail = require('@sendgrid/mail');

// --- CONFIGURAZIONE DATABASE (SEMPLIFICATA PER DEPLOYMENT) ---
const pool = new Pool({
    // Usa sempre la stringa di connessione da DB_URL, sia in locale che su Render.
    connectionString: process.env.DB_URL,
    // Abilita SSL se la stringa di connessione lo richiede (come fa Render).
    ssl: {
        rejectUnauthorized: false
    }
});

// --- INIZIALIZZAZIONE EXPRESS ---
const app = express();
const port = process.env.PORT || 3000;

// --- MIDDLEWARE GLOBALI ---
app.use(cors());
app.use(express.json());
app.use(passport.initialize());

// --- SERVIRE IL FRONTEND (FILE STATICI) ---
app.use(express.static(path.join(__dirname, 'public')));


// CONFIGURAZIONE SENDGRID
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// --- CONFIGURAZIONE PASSPORT.JS PER GOOGLE OAUTH ---
const SERVER_URL = process.env.NODE_ENV === 'production' 
    ? 'https://compost-project.onrender.com' // Il tuo URL di Render
    : `http://localhost:${port}`;

// VERSIONE CORRETTA E ROBUSTA DELLA STRATEGIA GOOGLE
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${SERVER_URL}/api/auth/google/callback`
  },
  async (accessToken, refreshToken, profile, done) => {
    const email = profile.emails[0].value;
    const googleId = profile.id;

    try {
        // 1. Cerca l'utente tramite google_id. Questo è il caso più comune dopo il primo login.
        let userResult = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
        if (userResult.rows.length > 0) {
            console.log(`✅ Utente trovato tramite Google ID: ${email}`);
            return done(null, userResult.rows[0]);
        }

        // 2. Se non trovato, cerca l'utente tramite email. Potrebbe esistere un account creato con password.
        userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length > 0) {
            console.log(`🔗 Account esistente trovato per email: ${email}. Collegamento con Google ID in corso...`);
            // Collega il google_id all'account esistente senza toccare il ruolo.
            const existingUser = userResult.rows[0];
            const updatedUserResult = await pool.query(
                'UPDATE users SET google_id = $1 WHERE id = $2 RETURNING *',
                [googleId, existingUser.id]
            );
            return done(null, updatedUserResult.rows[0]);
        }

        // 3. Se l'utente non esiste affatto, creane uno nuovo.
        console.log(`✨ Creazione nuovo utente per: ${email}`);
        const newUserResult = await pool.query(
            'INSERT INTO users (email, google_id, role) VALUES ($1, $2, $3) RETURNING *',
            [email, googleId, 'user'] // Il nuovo utente ha ruolo 'user' di default
        );
        return done(null, newUserResult.rows[0]);

    } catch (err) {
        console.error("❌ Errore durante la strategia Google OAuth:", err);
        return done(err, null);
    }
  }
));


// --- MIDDLEWARE DI AUTENTICAZIONE JWT ---
const authMiddleware = (req, res, next) => {
    const authHeader = req.header('Authorization');
    if (!authHeader) return res.status(401).json({ message: 'Accesso negato. Nessun token fornito.' });
    try {
        const token = authHeader.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'Formato token non valido.' });
        req.user = jwt.verify(token, process.env.JWT_SECRET).user;
        next();
    } catch (err) {
        res.status(400).json({ message: 'Token non valido.' });
    }
};

// --- MIDDLEWARE DI AUTENTICAZIONE PER ADMIN ---
const adminAuthMiddleware = (req, res, next) => {
    authMiddleware(req, res, () => {
        if (req.user && req.user.role === 'admin') {
            next();
        } else {
            res.status(403).json({ message: 'Accesso negato. Riservato agli amministratori.' });
        }
    });
};

// ===============================================
//         DEFINIZIONE DELLE API
// ===============================================

// --- ROUTE PUBBLICHE ---
app.get('/api/graph', async (req, res) => {
    try {
        const nodesResult = await pool.query("SELECT id, title, content, type FROM nodes WHERE status = 'approved'");
        const linksResult = await pool.query('SELECT source_node_id, target_node_id FROM links');
        
        res.json({
            nodes: nodesResult.rows,
            links: linksResult.rows.map(link => ({ source: link.source_node_id, target: link.target_node_id }))
        });
    } catch (err) {
        console.error('❌ Errore GET /api/graph:', err);
        res.status(500).json({ message: 'Errore interno del server.' });
    }
});

// --- ROUTE AUTENTICAZIONE ---
app.get('/api/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/api/auth/google/callback', 
    passport.authenticate('google', { session: false, failureRedirect: `${process.env.FRONTEND_URL}/index.html` }),
    (req, res) => {
        const payload = { user: { id: req.user.id, email: req.user.email, role: req.user.role } };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.redirect(`${process.env.FRONTEND_URL}/index.html?token=${token}`);
    }
);

app.post('/api/auth/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email e password sono obbligatori.' });
    try {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        const result = await pool.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email`, [email, passwordHash]);

        const newUser = result.rows[0];
        const msg = {
            to: newUser.email,
            from: process.env.VERIFIED_SENDER_EMAIL,
            subject: 'Benvenutə su Compost!',
            html: `<h1>Grazie per esserti registratə!</h1><p>Il tuo account su Compost è stato creato con successo.</p><p><em>- Il team di Compost</em></p>`,
        };
        sgMail.send(msg)
            .then(() => console.log(`✅ Email di benvenuto inviata a ${newUser.email}`))
            .catch(error => console.error('❌ Errore invio email di benvenuto:', error.response.body));

        res.status(201).json({ message: 'Utente registrato! Ora puoi effettuare il login.', user: newUser });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: 'Questa email è già registrata.' });
        console.error('❌ Errore /api/auth/register:', err);
        res.status(500).json({ message: 'Errore interno del server.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(401).json({ message: 'Credenziali non valide.' });
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];
        if (!user || !user.password_hash || !await bcrypt.compare(password, user.password_hash)) {
            return res.status(401).json({ message: 'Credenziali non valide.' });
        }
        const payload = { user: { id: user.id, email: user.email, role: user.role } };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.json({ token });
    } catch (err) {
        console.error('❌ Errore /api/auth/login:', err);
        res.status(500).json({ message: 'Errore interno del server.' });
    }
});

app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = userResult.rows[0];
        if (!user) {
            return res.status(200).json({ message: 'Se un account con questa email esiste, abbiamo inviato un link per il reset.' });
        }
        const token = crypto.randomBytes(32).toString('hex');
        const tokenExpiry = new Date(Date.now() + 3600000); // 1 ora
        await pool.query('UPDATE users SET reset_password_token = $1, reset_password_expires = $2 WHERE id = $3', [token, tokenExpiry, user.id]);
        
        const resetURL = `${process.env.FRONTEND_URL}/reset-password.html?token=${token}`;
        const msg = {
            to: user.email,
            from: process.env.VERIFIED_SENDER_EMAIL,
            subject: 'Reset Password per Compost',
            html: `<p>Clicca su questo link per resettare la tua password (valido per 1 ora): <a href="${resetURL}">${resetURL}</a></p>`,
        };
        await sgMail.send(msg);

        res.status(200).json({ message: 'Se un account con questa email esiste, abbiamo inviato un link per il reset.' });
    } catch (err) {
        console.error('❌ Errore /api/auth/forgot-password:', err);
        res.status(500).json({ message: 'Errore interno del server.' });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) {
        return res.status(400).json({ message: 'Token e nuova password sono obbligatori.' });
    }
    try {
        const userResult = await pool.query('SELECT * FROM users WHERE reset_password_token = $1 AND reset_password_expires > NOW()', [token]);
        const user = userResult.rows[0];
        if (!user) {
            return res.status(400).json({ message: 'Token non valido o scaduto.' });
        }
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        await pool.query('UPDATE users SET password_hash = $1, reset_password_token = NULL, reset_password_expires = NULL WHERE id = $2', [passwordHash, user.id]);
        res.status(200).json({ message: 'Password aggiornata con successo! Ora puoi effettuare il login.' });
    } catch (err) {
        console.error('❌ Errore /api/auth/reset-password:', err);
        res.status(500).json({ message: 'Errore interno del server.' });
    }
});

// --- ROUTE PROTETTE ---
app.post('/api/bug-report', authMiddleware, async (req, res) => {
    const { reportText } = req.body;
    const { id: userId, email: userEmail } = req.user;
    if (!reportText) {
        return res.status(400).json({ message: 'Il testo della segnalazione non può essere vuoto.' });
    }
    try {
        await pool.query('INSERT INTO bug_reports (user_id, report_text) VALUES ($1, $2)', [userId, reportText]);
        
        const msg = {
            to: userEmail,
            from: process.env.VERIFIED_SENDER_EMAIL,
            subject: 'Grazie per la tua segnalazione!',
            html: `<p>Ciao, abbiamo ricevuto la tua segnalazione e ti ringraziamo per il contributo!</p><p><b>La tua segnalazione:</b></p><blockquote>${reportText}</blockquote>`,
        };
        await sgMail.send(msg);

        res.status(200).json({ message: 'Segnalazione inviata con successo! Ti abbiamo mandato una mail di conferma.' });
    } catch (err) {
        console.error('❌ Errore POST /api/bug-report:', err);
        res.status(500).json({ message: 'Errore interno del server.' });
    }
});

// =================================================================
// === SEZIONE CORRETTA ============================================
// =================================================================
app.post('/api/nodes', authMiddleware, async (req, res) => {
    // Estrae titolo, contenuto e TIPO dal corpo della richiesta
    const { title, content, type } = req.body;
    const userId = req.user.id;

    // Aggiunge un controllo per assicurarsi che il tipo sia valido
    const allowedTypes = ['nota', 'autore', 'domanda', 'risposta', 'contributo'];
    if (!title || !content || !type || !allowedTypes.includes(type)) {
        return res.status(400).json({ message: 'Titolo, contenuto e un tipo di nodo valido sono obbligatori.' });
    }

    try {
        // Usa il 'type' ricevuto dal frontend nell'inserimento
        const result = await pool.query(
            `INSERT INTO nodes (title, content, type, status, author_id) VALUES ($1, $2, $3, 'pending', $4) RETURNING id`, 
            [title, content, type, userId]
        );
        res.status(201).json({ message: 'Contributo ricevuto! Sarà revisionato a breve.', node: result.rows[0] });
    } catch (err) {
        console.error('❌ Errore POST /api/nodes:', err);
        res.status(500).json({ message: 'Errore interno del server.' });
    }
});
// =================================================================
// === FINE SEZIONE CORRETTA =======================================
// =================================================================


app.get('/api/me/history', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT n.title FROM reading_history rh JOIN nodes n ON rh.node_id = n.id WHERE rh.user_id = $1', [req.user.id]);
        res.json(result.rows.map(row => row.title));
    } catch (err) {
        console.error('❌ Errore GET /api/me/history:', err);
        res.status(500).json({ message: 'Errore interno del server.' });
    }
});

app.post('/api/me/history', authMiddleware, async (req, res) => {
    const { nodeId } = req.body;
    if (!nodeId) return res.status(400).json({ message: 'nodeId mancante.' });
    try {
        const nodeRes = await pool.query('SELECT id FROM nodes WHERE title = $1', [nodeId]);
        if (nodeRes.rows.length === 0) { return res.status(404).json({ message: 'Nodo non trovato.' }); }
        const numericNodeId = nodeRes.rows[0].id;
        await pool.query('INSERT INTO reading_history (user_id, node_id) VALUES ($1, $2) ON CONFLICT (user_id, node_id) DO NOTHING', [req.user.id, numericNodeId]);
        res.status(201).send();
    } catch (err) {
        console.error('❌ Errore POST /api/me/history:', err);
        res.status(500).json({ message: 'Errore interno del server.' });
    }
});

app.get('/api/me/contributions', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query("SELECT title, content, status, type FROM nodes WHERE author_id = $1 ORDER BY created_at DESC", [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        console.error('❌ Errore GET /api/me/contributions:', err);
        res.status(500).json({ message: 'Errore interno del server.' });
    }
});

// ===============================================
//         ROUTE PER AMMINISTRAZIONE
// ===============================================

app.get('/api/admin/pending-nodes', adminAuthMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT n.id, n.title, n.content, n.created_at, u.email as author_email 
             FROM nodes n
             JOIN users u ON n.author_id = u.id
             WHERE n.status = 'pending' 
             ORDER BY n.created_at ASC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('❌ Errore GET /api/admin/pending-nodes:', err);
        res.status(500).json({ message: 'Errore interno del server.' });
    }
});

app.post('/api/admin/moderate-node', adminAuthMiddleware, async (req, res) => {
    const { nodeId, decision } = req.body;

    if (!nodeId || !['approved', 'rejected'].includes(decision)) {
        return res.status(400).json({ message: 'ID del nodo e decisione validi sono obbligatori.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const nodeUpdateResult = await client.query(
            "UPDATE nodes SET status = $1 WHERE id = $2 RETURNING *",
            [decision, nodeId]
        );
        const moderatedNode = nodeUpdateResult.rows[0];

        if (!moderatedNode) {
            throw new Error('Nodo non trovato.');
        }

        if (decision === 'approved') {
            const linkRegex = /\[\[(.*?)\]\]/g;
            const matches = [...moderatedNode.content.matchAll(linkRegex)];
            
            for (const match of matches) {
                const targetTitle = match[1].trim();
                if (targetTitle) {
                    const targetNodeRes = await client.query("SELECT id FROM nodes WHERE title = $1 AND status = 'approved'", [targetTitle]);
                    if (targetNodeRes.rows.length > 0) {
                        const targetId = targetNodeRes.rows[0].id;
                        await client.query(
                            `INSERT INTO links (source_node_id, target_node_id) 
                             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                            [moderatedNode.id, targetId]
                        );
                    }
                }
            }

            const authorRes = await client.query("SELECT email FROM users WHERE id = $1", [moderatedNode.author_id]);
            const authorEmail = authorRes.rows[0].email;

            const msg = {
                to: authorEmail,
                from: process.env.VERIFIED_SENDER_EMAIL,
                subject: 'Il tuo contributo su Compost è stato approvato!',
                html: `<h1>Congratulazioni!</h1><p>Ciao, siamo felici di comunicarti che il tuo contributo "<b>${moderatedNode.title}</b>" è stato approvato e ora è visibile a tutti nel grafo di Compost.</p><p>Grazie per aver arricchito la nostra rete di conoscenza!</p><p><em>- Il team di Compost</em></p>`,
            };
            await sgMail.send(msg);
        }

        await client.query('COMMIT');
        res.status(200).json({ message: `Contributo ${decision === 'approved' ? 'approvato' : 'rifiutato'} con successo.` });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Errore POST /api/admin/moderate-node:', err);
        res.status(500).json({ message: 'Errore interno del server durante la moderazione.' });
    } finally {
        client.release();
    }
});

// --- AVVIO DEL SERVER ---
app.listen(port, () => {
    console.log(`✅ Server in ascolto su http://localhost:${port}`);
});