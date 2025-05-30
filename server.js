const express = require('express');
const cors = require('cors');
const vision = require('@google-cloud/vision');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const ExcelJS = require('exceljs');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Récupérer les credentials depuis une variable d'environnement
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
const client = new vision.ImageAnnotatorClient({ credentials });

// Initialiser la base de données avec la nouvelle table VINs
const db = new sqlite3.Database('./vins.db');

// Créer les tables nécessaires
db.serialize(() => {
    // Table originale (si vous en avez besoin)
    db.run(`
        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            price REAL NOT NULL
        )
    `);
    
    // Nouvelle table pour les VINs
    db.run(`
        CREATE TABLE IF NOT EXISTS vins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            date_created TEXT NOT NULL,
            image_data TEXT,
            user_agent TEXT,
            ip_address TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// Configurer multer
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: function(req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// ========== ROUTES OCR (INTOUCHÉES) ==========
app.post('/api/ocr/process', async (req, res) => {
    try {
        const { image } = req.body;
        const base64Image = image.replace(/^data:image\/\w+;base64,/, '');
        const imageBuffer = Buffer.from(base64Image, 'base64');

        const [result] = await client.textDetection({ image: { content: imageBuffer } });
        const detections = result.textAnnotations;

        if (detections && detections.length > 0) {
            const fullText = detections[0].description;
            const vinRegex = /[A-HJ-NPR-Z0-9]{17}/g;
            const matches = fullText.match(vinRegex);
            if (matches && matches.length > 0) {
                res.json({ success: true, vin: matches[0], allText: fullText });
            } else {
                res.json({ success: false, message: 'Aucun VIN trouvé', allText: fullText });
            }
        } else {
            res.json({ success: false, message: 'Aucun texte détecté' });
        }
    } catch (error) {
        console.error('Erreur OCR :', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== NOUVELLES ROUTES VINS ==========

// Récupérer tous les VINs
app.get('/api/vins', (req, res) => {
    const query = `
        SELECT id, code, date_created, image_data, user_agent, ip_address, created_at 
        FROM vins 
        ORDER BY created_at DESC
    `;
    
    db.all(query, [], (err, rows) => {
        if (err) {
            console.error('Erreur lors de la récupération des VINs :', err);
            res.status(500).json({ success: false, error: err.message });
        } else {
            // Transformer les données pour correspondre au format frontend
            const vins = rows.map(row => ({
                id: row.id,
                code: row.code,
                date: row.date_created,
                image: row.image_data,
                userAgent: row.user_agent,
                ipAddress: row.ip_address,
                createdAt: row.created_at
            }));
            res.json({ success: true, vins: vins });
        }
    });
});

// Créer un nouveau VIN
app.post('/api/vins', (req, res) => {
    const { code, date, image, userAgent } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
    
    // Validation basique
    if (!code || !isValidVIN(code)) {
        return res.status(400).json({ 
            success: false, 
            error: 'Code VIN invalide ou manquant' 
        });
    }
    
    const query = `
        INSERT INTO vins (code, date_created, image_data, user_agent, ip_address)
        VALUES (?, ?, ?, ?, ?)
    `;
    
    db.run(query, [code.toUpperCase(), date || new Date().toISOString(), image || null, userAgent || null, ipAddress], function(err) {
        if (err) {
            if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                res.status(409).json({ 
                    success: false, 
                    error: 'Ce VIN existe déjà dans la base de données' 
                });
            } else {
                console.error('Erreur lors de la création du VIN :', err);
                res.status(500).json({ success: false, error: err.message });
            }
        } else {
            // Récupérer le VIN créé
            db.get('SELECT * FROM vins WHERE id = ?', [this.lastID], (err, row) => {
                if (err) {
                    res.status(500).json({ success: false, error: err.message });
                } else {
                    res.status(201).json({ 
                        success: true, 
                        message: 'VIN enregistré avec succès',
                        vin: {
                            id: row.id,
                            code: row.code,
                            date: row.date_created,
                            image: row.image_data,
                            userAgent: row.user_agent,
                            ipAddress: row.ip_address,
                            createdAt: row.created_at
                        }
                    });
                }
            });
        }
    });
});

// Supprimer un VIN
app.delete('/api/vins/:id', (req, res) => {
    const vinId = req.params.id;
    
    if (!vinId || isNaN(vinId)) {
        return res.status(400).json({ 
            success: false, 
            error: 'ID de VIN invalide' 
        });
    }
    
    // Vérifier si le VIN existe
    db.get('SELECT * FROM vins WHERE id = ?', [vinId], (err, row) => {
        if (err) {
            res.status(500).json({ success: false, error: err.message });
        } else if (!row) {
            res.status(404).json({ 
                success: false, 
                error: 'VIN non trouvé' 
            });
        } else {
            // Supprimer le VIN
            db.run('DELETE FROM vins WHERE id = ?', [vinId], function(err) {
                if (err) {
                    console.error('Erreur lors de la suppression du VIN :', err);
                    res.status(500).json({ success: false, error: err.message });
                } else {
                    res.json({ 
                        success: true, 
                        message: 'VIN supprimé avec succès',
                        deletedVin: row
                    });
                }
            });
        }
    });
});

// Rechercher des VINs
app.get('/api/vins/search', (req, res) => {
    const { q, dateFrom, dateTo } = req.query;
    
    let query = 'SELECT * FROM vins WHERE 1=1';
    let params = [];
    
    if (q) {
        query += ' AND code LIKE ?';
        params.push(`%${q.toUpperCase()}%`);
    }
    
    if (dateFrom) {
        query += ' AND date(date_created) >= date(?)';
        params.push(dateFrom);
    }
    
    if (dateTo) {
        query += ' AND date(date_created) <= date(?)';
        params.push(dateTo);
    }
    
    query += ' ORDER BY created_at DESC';
    
    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('Erreur lors de la recherche des VINs :', err);
            res.status(500).json({ success: false, error: err.message });
        } else {
            const vins = rows.map(row => ({
                id: row.id,
                code: row.code,
                date: row.date_created,
                image: row.image_data,
                userAgent: row.user_agent,
                ipAddress: row.ip_address,
                createdAt: row.created_at
            }));
            res.json({ success: true, vins: vins });
        }
    });
});

// Export Excel
app.get('/api/vins/export', async (req, res) => {
    try {
        // Récupérer tous les VINs
        db.all('SELECT * FROM vins ORDER BY created_at DESC', [], async (err, rows) => {
            if (err) {
                console.error('Erreur lors de l\'export :', err);
                res.status(500).json({ success: false, error: err.message });
                return;
            }
            
            // Créer un nouveau workbook
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('VINs Enregistrés');
            
            // Définir les colonnes
            worksheet.columns = [
                { header: 'ID', key: 'id', width: 10 },
                { header: 'Code VIN', key: 'code', width: 20 },
                { header: 'Date d\'Enregistrement', key: 'date_created', width: 25 },
                { header: 'Date de Création', key: 'created_at', width: 25 },
                { header: 'Navigateur', key: 'user_agent', width: 30 },
                { header: 'Adresse IP', key: 'ip_address', width: 15 },
                { header: 'Image Disponible', key: 'has_image', width: 15 }
            ];
            
            // Ajouter les données
            rows.forEach(row => {
                worksheet.addRow({
                    id: row.id,
                    code: row.code,
                    date_created: new Date(row.date_created).toLocaleString('fr-FR'),
                    created_at: new Date(row.created_at).toLocaleString('fr-FR'),
                    user_agent: row.user_agent || 'Non spécifié',
                    ip_address: row.ip_address || 'Non spécifié',
                    has_image: row.image_data ? 'Oui' : 'Non'
                });
            });
            
            // Styliser l'en-tête
            worksheet.getRow(1).eachCell((cell) => {
                cell.font = { bold: true };
                cell.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFE0E0E0' }
                };
            });
            
            // Générer le fichier
            const fileName = `vins_export_${new Date().toISOString().slice(0, 10)}.xlsx`;
            
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
            
            await workbook.xlsx.write(res);
            res.end();
        });
    } catch (error) {
        console.error('Erreur lors de l\'export Excel :', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Statistiques
app.get('/api/vins/stats', (req, res) => {
    const queries = {
        total: 'SELECT COUNT(*) as count FROM vins',
        today: `SELECT COUNT(*) as count FROM vins WHERE date(created_at) = date('now')`,
        thisMonth: `SELECT COUNT(*) as count FROM vins WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`,
        thisWeek: `SELECT COUNT(*) as count FROM vins WHERE created_at >= date('now', '-7 days')`
    };
    
    const stats = {};
    let completed = 0;
    
    Object.keys(queries).forEach(key => {
        db.get(queries[key], [], (err, row) => {
            if (!err) {
                stats[key] = row.count;
            } else {
                stats[key] = 0;
            }
            completed++;
            
            if (completed === Object.keys(queries).length) {
                res.json({ success: true, stats: stats });
            }
        });
    });
});

// ========== FONCTIONS UTILITAIRES ==========

function isValidVIN(vin) {
    // Validation VIN : 17 caractères, pas de I, O, ou Q
    const vinRegex = /^[A-HJ-NPR-Z0-9]{17}$/;
    return vinRegex.test(vin);
}

// ========== DÉMARRAGE SERVEUR ==========

app.listen(port, () => {
    console.log(`🚗 Serveur VIN Tracker en écoute sur http://localhost:${port}`);
    console.log(`📊 Base de données initialisée`);
    console.log(`🔍 OCR Google Vision API configuré`);
    console.log(`📁 Export Excel disponible sur /api/vins/export`);
});

// Gestion gracieuse de l'arrêt
process.on('SIGINT', () => {
    console.log('\n🛑 Arrêt du serveur...');
    db.close((err) => {
        if (err) {
            console.error('Erreur lors de la fermeture de la base de données :', err);
        } else {
            console.log('📊 Base de données fermée');
        }
        process.exit(0);
    });
});
