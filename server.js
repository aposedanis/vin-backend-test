const express = require('express');
const cors = require('cors');
const vision = require('@google-cloud/vision');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Récupérer les credentials depuis une variable d'environnement
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
const client = new vision.ImageAnnotatorClient({ credentials });

// Initialiser la base de données SQLite
const db = new sqlite3.Database('./vins.db');

// Créer les tables nécessaires
db.serialize(() => {
    // Table pour les VINs
    db.run(`
        CREATE TABLE IF NOT EXISTS vins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            date TEXT NOT NULL,
            image TEXT
        )
    `);
    
    // Table pour les items (si nécessaire pour d'autres fonctionnalités)
    db.run(`
        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            price REAL NOT NULL
        )
    `);
});

// Configurer multer pour les uploads
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: function(req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// ===================
// ROUTES API VINs
// ===================

// GET - Récupérer tous les VINs
app.get('/api/vins', (req, res) => {
    db.all("SELECT * FROM vins ORDER BY date DESC", (err, rows) => {
        if (err) {
            console.error('Erreur lors de la récupération des VINs:', err);
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// POST - Créer un nouveau VIN
app.post('/api/vins', (req, res) => {
    const { code, image } = req.body;
    
    if (!code) {
        res.status(400).json({ error: 'Le code VIN est requis' });
        return;
    }
    
    const date = new Date().toISOString();
    
    db.run("INSERT INTO vins (code, date, image) VALUES (?, ?, ?)",
        [code, date, image || ''],
        function(err) {
            if (err) {
                console.error('Erreur lors de la création du VIN:', err);
                if (err.message.includes('UNIQUE constraint failed')) {
                    res.status(400).json({ error: 'Ce VIN existe déjà dans la base de données' });
                } else {
                    res.status(500).json({ error: err.message });
                }
                return;
            }
            
            // Retourner le VIN créé
            res.status(201).json({
                id: this.lastID,
                code: code,
                date: date,
                image: image || ''
            });
        }
    );
});

// DELETE - Supprimer un VIN par ID
app.delete('/api/vins/:id', (req, res) => {
    const { id } = req.params;
    
    if (!id || isNaN(id)) {
        res.status(400).json({ error: 'ID invalide' });
        return;
    }
    
    db.run("DELETE FROM vins WHERE id = ?", [id], function(err) {
        if (err) {
            console.error('Erreur lors de la suppression du VIN:', err);
            res.status(500).json({ error: err.message });
            return;
        }
        
        if (this.changes === 0) {
            res.status(404).json({ error: 'VIN non trouvé' });
            return;
        }
        
        res.json({ 
            message: 'VIN supprimé avec succès',
            deleted: this.changes 
        });
    });
});

// GET - Rechercher des VINs
app.get('/api/vins/search', (req, res) => {
    const { q, dateFrom, dateTo } = req.query;
    
    let query = "SELECT * FROM vins WHERE 1=1";
    const params = [];
    
    // Filtre par code VIN
    if (q) {
        query += " AND code LIKE ?";
        params.push(`%${q.toUpperCase()}%`);
    }
    
    // Filtre par date de début
    if (dateFrom) {
        query += " AND date >= ?";
        params.push(dateFrom);
    }
    
    // Filtre par date de fin
    if (dateTo) {
        query += " AND date <= ?";
        params.push(dateTo + 'T23:59:59.999Z');
    }
    
    query += " ORDER BY date DESC";
    
    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('Erreur lors de la recherche des VINs:', err);
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// GET - Récupérer un VIN spécifique par ID
app.get('/api/vins/:id', (req, res) => {
    const { id } = req.params;
    
    if (!id || isNaN(id)) {
        res.status(400).json({ error: 'ID invalide' });
        return;
    }
    
    db.get("SELECT * FROM vins WHERE id = ?", [id], (err, row) => {
        if (err) {
            console.error('Erreur lors de la récupération du VIN:', err);
            res.status(500).json({ error: err.message });
            return;
        }
        
        if (!row) {
            res.status(404).json({ error: 'VIN non trouvé' });
            return;
        }
        
        res.json(row);
    });
});

// GET - Statistiques des VINs
app.get('/api/vins/stats', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = new Date().toISOString().slice(0, 7);
    
    // Compter le total
    db.get("SELECT COUNT(*) as total FROM vins", (err, totalResult) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        // Compter aujourd'hui
        db.get("SELECT COUNT(*) as today FROM vins WHERE date LIKE ?", [`${today}%`], (err, todayResult) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            
            // Compter ce mois
            db.get("SELECT COUNT(*) as month FROM vins WHERE date LIKE ?", [`${currentMonth}%`], (err, monthResult) => {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }
                
                res.json({
                    total: totalResult.total,
                    today: todayResult.today,
                    month: monthResult.month
                });
            });
        });
    });
});

// ===================
// ROUTE OCR (VOTRE LOGIQUE ORIGINALE)
// ===================

app.post('/api/ocr/process', async (req, res) => {
    try {
        const { image } = req.body;
        
        if (!image) {
            res.status(400).json({ 
                success: false, 
                message: 'Image manquante' 
            });
            return;
        }
        
        // Supprimer le préfixe data URL
        const base64Image = image.replace(/^data:image\/\w+;base64,/, '');
        const imageBuffer = Buffer.from(base64Image, 'base64');

        // Appeler l'API Google Vision
        const [result] = await client.textDetection({ 
            image: { content: imageBuffer } 
        });
        
        const detections = result.textAnnotations;

        if (detections && detections.length > 0) {
            const fullText = detections[0].description;
            
            // Extraire le pattern VIN (17 caractères)
            const vinRegex = /[A-HJ-NPR-Z0-9]{17}/g;
            const matches = fullText.match(vinRegex);
            
            if (matches && matches.length > 0) {
                res.json({ 
                    success: true, 
                    vin: matches[0],
                    allText: fullText 
                });
            } else {
                res.json({ 
                    success: false, 
                    message: 'Aucun VIN trouvé dans l\'image',
                    allText: fullText 
                });
            }
        } else {
            res.json({ 
                success: false, 
                message: 'Aucun texte détecté dans l\'image' 
            });
        }
    } catch (error) {
        console.error('Erreur OCR :', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ===================
// MIDDLEWARE ET GESTION D'ERREURS
// ===================

// Middleware pour gérer les erreurs 404
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Route non trouvée',
        path: req.path 
    });
});

// Middleware pour gérer les erreurs générales
app.use((err, req, res, next) => {
    console.error('Erreur serveur:', err);
    res.status(500).json({ 
        error: 'Erreur interne du serveur',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Une erreur est survenue'
    });
});

// Gestion de la fermeture propre de la base de données
process.on('SIGINT', () => {
    console.log('Fermeture de la base de données...');
    db.close((err) => {
        if (err) {
            console.error('Erreur lors de la fermeture de la base de données:', err);
        } else {
            console.log('Base de données fermée.');
        }
        process.exit(0);
    });
});

// ===================
// DÉMARRAGE DU SERVEUR
// ===================

app.listen(port, () => {
    console.log(`🚗 Serveur VIN Tracker en écoute sur http://localhost:${port}`);
    console.log(`📊 API disponible sur http://localhost:${port}/api`);
    console.log(`📱 Routes VINs:`);
    console.log(`   GET    /api/vins          - Lister tous les VINs`);
    console.log(`   POST   /api/vins          - Créer un VIN`);
    console.log(`   DELETE /api/vins/:id      - Supprimer un VIN`);
    console.log(`   GET    /api/vins/search   - Rechercher des VINs`);
    console.log(`   GET    /api/vins/stats    - Statistiques des VINs`);
    console.log(`   POST   /api/ocr/process   - Traitement OCR`);
});
