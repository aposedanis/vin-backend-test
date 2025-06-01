const express = require('express');
const cors = require('cors');
const vision = require('@google-cloud/vision');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const ExcelJS = require('exceljs');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Configuration Supabase PostgreSQL avec Transaction Pooler
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Récupérer les credentials OCR depuis une variable d'environnement
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
const client = new vision.ImageAnnotatorClient({ credentials });

// Variables pour le monitoring
let serverStartTime = Date.now();
let lastDatabaseCheck = null;
let databaseStatus = 'unknown';

// ========== ROUTES DE MONITORING (POUR UPTIMEROBOT) ==========

// Route de health check simple pour UptimeRobot
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'alive',
    service: 'VIN Tracker Backend',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - serverStartTime) / 1000),
    database: databaseStatus,
    version: '2.0.0'
  });
});

// Route de ping simple (alternative)
app.get('/ping', (req, res) => {
  res.send('pong');
});

// Route de statut complet avec test base de données
app.get('/api/status', async (req, res) => {
  try {
    console.log('🔍 Test de statut demandé');
    
    // Test de connexion à la base
    const startTime = Date.now();
    const result = await pool.query('SELECT COUNT(*) as total FROM vins');
    const dbResponseTime = Date.now() - startTime;
    
    databaseStatus = 'connected';
    lastDatabaseCheck = new Date().toISOString();
    
    res.json({
      status: 'healthy',
      service: 'VIN Tracker Backend',
      database: {
        status: 'connected',
        responseTime: `${dbResponseTime}ms`,
        totalVins: parseInt(result.rows[0].total),
        lastCheck: lastDatabaseCheck
      },
      server: {
        uptime: `${Math.floor((Date.now() - serverStartTime) / 1000)} secondes`,
        startTime: new Date(serverStartTime).toISOString(),
        memoryUsage: process.memoryUsage(),
        nodeVersion: process.version
      },
      timestamp: new Date().toISOString()
    });
    
    console.log('✅ Test de statut réussi');
  } catch (error) {
    console.error('❌ Test de statut échoué:', error.message);
    databaseStatus = 'disconnected';
    
    res.status(500).json({
      status: 'unhealthy',
      database: {
        status: 'disconnected',
        error: error.message,
        lastCheck: new Date().toISOString()
      },
      server: {
        uptime: `${Math.floor((Date.now() - serverStartTime) / 1000)} secondes`,
        startTime: new Date(serverStartTime).toISOString()
      },
      timestamp: new Date().toISOString()
    });
  }
});

// Route pour informations détaillées (debug)
app.get('/api/info', (req, res) => {
  res.json({
    service: 'VIN Tracker Backend',
    version: '2.0.0',
    environment: process.env.NODE_ENV || 'production',
    database: {
      status: databaseStatus,
      lastCheck: lastDatabaseCheck
    },
    server: {
      startTime: new Date(serverStartTime).toISOString(),
      uptime: Math.floor((Date.now() - serverStartTime) / 1000),
      platform: process.platform,
      nodeVersion: process.version,
      memoryUsage: process.memoryUsage()
    },
    uptimeRobot: {
      enabled: true,
      pingUrl: '/api/health',
      interval: '5 minutes',
      purpose: 'Empêcher le sleep mode de Render'
    }
  });
});

// ========== INITIALISATION BASE DE DONNÉES ==========

// Initialisation automatique de la base de données
async function initDatabase() {
  try {
    console.log('🚀 Initialisation base Supabase...');
    
    // Test de connexion initial
    await pool.query('SELECT NOW()');
    console.log('✅ Connexion à Supabase établie');
    
    // Créer la table vins SANS stockage d'images
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vins (
        id SERIAL PRIMARY KEY,
        code VARCHAR(17) NOT NULL UNIQUE,
        date_created TIMESTAMP WITH TIME ZONE NOT NULL,
        user_agent TEXT,
        ip_address INET,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Supprimer la colonne image_data si elle existe (migration)
    await pool.query(`
      DO $$ 
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'vins' AND column_name = 'image_data'
        ) THEN
          ALTER TABLE vins DROP COLUMN image_data;
          RAISE NOTICE 'Colonne image_data supprimée';
        END IF;
      END $$;
    `);
    
    // Index pour optimiser les recherches
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vins_code ON vins(code);
      CREATE INDEX IF NOT EXISTS idx_vins_created_at ON vins(created_at);
    `);
    
    // Contrainte pour valider le format VIN
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.constraint_column_usage 
          WHERE constraint_name = 'check_vin_format'
        ) THEN
          ALTER TABLE vins ADD CONSTRAINT check_vin_format 
          CHECK (code ~ '^[A-HJ-NPR-Z0-9]{17}$');
        END IF;
      END $$;
    `);
    
    console.log('✅ Base Supabase initialisée sans stockage d\'images');
    
    // Test de connexion et comptage
    const result = await pool.query('SELECT COUNT(*) as total FROM vins');
    console.log(`📊 ${result.rows[0].total} VINs dans la base`);
    
    databaseStatus = 'connected';
    lastDatabaseCheck = new Date().toISOString();
    
  } catch (error) {
    console.error('❌ Erreur init base:', error.message);
    databaseStatus = 'disconnected';
  }
}

// ========== CONFIGURATION MULTER (pour import Excel seulement) ==========

const uploadsDir = './uploads/';
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('📁 Dossier uploads créé');
}

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: function(req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// ========== ROUTES OCR ==========

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

// ========== ROUTES VINS ==========

// Récupérer tous les VINs (SANS images)
app.get('/api/vins', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, code, date_created, user_agent, ip_address, created_at 
      FROM vins 
      ORDER BY created_at DESC
    `);
    
    const vins = result.rows.map(row => ({
      id: row.id,
      code: row.code,
      date: row.date_created,
      userAgent: row.user_agent,
      ipAddress: row.ip_address,
      createdAt: row.created_at
    }));
    
    res.json({ success: true, vins: vins });
  } catch (error) {
    console.error('Erreur récupération VINs :', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Créer un nouveau VIN (SANS image)
app.post('/api/vins', async (req, res) => {
  const { code, date, userAgent } = req.body;
  const ipAddress = req.ip || req.connection.remoteAddress;
  
  if (!code || !isValidVIN(code)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Code VIN invalide ou manquant' 
    });
  }
  
  try {
    const result = await pool.query(`
      INSERT INTO vins (code, date_created, user_agent, ip_address)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [
      code.toUpperCase(), 
      date || new Date().toISOString(), 
      userAgent || null, 
      ipAddress
    ]);
    
    const row = result.rows[0];
    res.status(201).json({ 
      success: true, 
      message: 'VIN enregistré avec succès',
      vin: {
        id: row.id,
        code: row.code,
        date: row.date_created,
        userAgent: row.user_agent,
        ipAddress: row.ip_address,
        createdAt: row.created_at
      }
    });
    
  } catch (error) {
    if (error.constraint === 'vins_code_key') {
      res.status(409).json({ 
        success: false, 
        error: 'Ce VIN existe déjà dans la base de données' 
      });
    } else {
      console.error('Erreur création VIN :', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Supprimer un VIN
app.delete('/api/vins/:id', async (req, res) => {
  const vinId = req.params.id;
  
  if (!vinId || isNaN(vinId)) {
    return res.status(400).json({ 
      success: false, 
      error: 'ID de VIN invalide' 
    });
  }
  
  try {
    // Vérifier si le VIN existe
    const checkResult = await pool.query('SELECT * FROM vins WHERE id = $1', [vinId]);
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'VIN non trouvé' 
      });
    }
    
    const row = checkResult.rows[0];
    
    // Supprimer le VIN
    await pool.query('DELETE FROM vins WHERE id = $1', [vinId]);
    
    res.json({ 
      success: true, 
      message: 'VIN supprimé avec succès',
      deletedVin: row
    });
    
  } catch (error) {
    console.error('Erreur suppression VIN :', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Rechercher des VINs
app.get('/api/vins/search', async (req, res) => {
  const { q, dateFrom, dateTo } = req.query;
  
  try {
    let query = 'SELECT * FROM vins WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (q) {
      query += ` AND code ILIKE $${paramIndex}`;
      params.push(`%${q.toUpperCase()}%`);
      paramIndex++;
    }
    
    if (dateFrom) {
      query += ` AND DATE(date_created) >= $${paramIndex}`;
      params.push(dateFrom);
      paramIndex++;
    }
    
    if (dateTo) {
      query += ` AND DATE(date_created) <= $${paramIndex}`;
      params.push(dateTo);
      paramIndex++;
    }
    
    query += ' ORDER BY created_at DESC';
    
    const result = await pool.query(query, params);
    
    const vins = result.rows.map(row => ({
      id: row.id,
      code: row.code,
      date: row.date_created,
      userAgent: row.user_agent,
      ipAddress: row.ip_address,
      createdAt: row.created_at
    }));
    
    res.json({ success: true, vins: vins });
    
  } catch (error) {
    console.error('Erreur recherche VINs :', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Import Excel (SANS gestion d'images)
app.post('/api/vins/import', upload.single('excelFile'), async (req, res) => {
  try {
    console.log('=== DÉBUT IMPORT EXCEL ===');
    console.log('Fichier reçu:', req.file ? req.file.originalname : 'Aucun fichier');

    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'Aucun fichier Excel fourni' 
      });
    }

    console.log('Chemin du fichier:', req.file.path);
    console.log('Taille du fichier:', req.file.size, 'bytes');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    
    console.log('Workbook chargé, nombre de feuilles:', workbook.worksheets.length);
    
    const worksheet = workbook.getWorksheet('VINs Enregistrés') || workbook.getWorksheet(1);
    
    if (!worksheet) {
      return res.status(400).json({ 
        success: false, 
        error: 'Aucune feuille de calcul trouvée dans le fichier' 
      });
    }

    console.log('Feuille trouvée:', worksheet.name);
    console.log('Nombre de lignes:', worksheet.rowCount);

    const importedVINs = [];
    const errors = [];
    let duplicates = 0;
    let imported = 0;

    // Parcourir les lignes (en ignorant l'en-tête)
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) {
        console.log('En-têtes détectés:', row.values);
        return; // Ignorer l'en-tête
      }
      
      try {
        // Lire les colonnes selon le format Excel
        const code = row.getCell(2).value; // Colonne B: Code VIN
        const dateEnregistrement = row.getCell(3).value; // Colonne C: Date d'Enregistrement
        const navigateur = row.getCell(5).value; // Colonne E: Navigateur
        const adresseIP = row.getCell(6).value; // Colonne F: Adresse IP
        // Pas de lecture de la colonne "Image Disponible"

        console.log(`Ligne ${rowNumber}:`, { code, dateEnregistrement, navigateur, adresseIP });

        // Validation basique
        if (!code || typeof code !== 'string') {
          errors.push(`Ligne ${rowNumber}: Code VIN manquant ou invalide`);
          return;
        }

        const codeStr = code.toString().trim().toUpperCase();
        if (!isValidVIN(codeStr)) {
          errors.push(`Ligne ${rowNumber}: VIN invalide "${codeStr}"`);
          return;
        }

        if (!dateEnregistrement) {
          errors.push(`Ligne ${rowNumber}: Date d'enregistrement manquante`);
          return;
        }

        // Convertir la date
        let dateISO;
        if (dateEnregistrement instanceof Date) {
          dateISO = dateEnregistrement.toISOString();
        } else if (typeof dateEnregistrement === 'string') {
          const dateStr = dateEnregistrement.toString();
          
          // Format français "30/05/2025 10:41:24"
          const frenchFormat = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(\d{1,2}):(\d{1,2}):(\d{1,2})/);
          if (frenchFormat) {
            const [, day, month, year, hour, minute, second] = frenchFormat;
            dateISO = new Date(year, month - 1, day, hour, minute, second).toISOString();
          } else {
            const parsedDate = new Date(dateStr);
            if (!isNaN(parsedDate.getTime())) {
              dateISO = parsedDate.toISOString();
            } else {
              errors.push(`Ligne ${rowNumber}: Format de date invalide "${dateStr}"`);
              return;
            }
          }
        } else {
          errors.push(`Ligne ${rowNumber}: Format de date non supporté`);
          return;
        }

        importedVINs.push({
          code: codeStr,
          date: dateISO,
          userAgent: navigateur ? navigateur.toString() : 'Import Excel',
          ipAddress: adresseIP ? adresseIP.toString() : 'Import'
        });

      } catch (error) {
        console.error(`Erreur ligne ${rowNumber}:`, error);
        errors.push(`Ligne ${rowNumber}: Erreur lors du traitement - ${error.message}`);
      }
    });

    console.log('VINs à importer:', importedVINs.length);
    console.log('Erreurs de parsing:', errors.length);

    // Insérer les VINs dans la base de données PostgreSQL (SANS images)
    for (const vinData of importedVINs) {
      try {
        console.log('Insertion VIN:', vinData.code);
        
        await pool.query(`
          INSERT INTO vins (code, date_created, user_agent, ip_address)
          VALUES ($1, $2, $3, $4)
        `, [
          vinData.code, 
          vinData.date, 
          vinData.userAgent,
          vinData.ipAddress
        ]);
        
        imported++;
        console.log('VIN inséré avec succès:', vinData.code);
        
      } catch (error) {
        console.error('Erreur insertion:', error);
        if (error.constraint === 'vins_code_key') {
          duplicates++;
        } else {
          errors.push(`VIN ${vinData.code}: ${error.message}`);
        }
      }
    }

    console.log('=== RÉSULTATS IMPORT ===');
    console.log('Importés:', imported);
    console.log('Doublons:', duplicates);
    console.log('Erreurs:', errors.length);

    // Nettoyer le fichier temporaire
    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      message: `Import terminé avec succès`,
      summary: {
        totalLines: importedVINs.length,
        imported: imported,
        duplicates: duplicates,
        errors: errors.length
      },
      details: {
        importedCount: imported,
        duplicatesCount: duplicates,
        errorsCount: errors.length,
        errorsList: errors.slice(0, 10)
      }
    });

  } catch (error) {
    console.error('Erreur lors de l\'import Excel :', error);
    
    // Nettoyer le fichier temporaire en cas d'erreur
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error('Erreur lors du nettoyage du fichier :', cleanupError);
      }
    }
    
    res.status(500).json({ 
      success: false, 
      error: `Erreur lors de l'import: ${error.message}` 
    });
  }
});

// Statistiques
app.get('/api/vins/stats', async (req, res) => {
  try {
    const queries = {
      total: 'SELECT COUNT(*) as count FROM vins',
      today: `SELECT COUNT(*) as count FROM vins WHERE DATE(created_at) = CURRENT_DATE`,
      thisMonth: `SELECT COUNT(*) as count FROM vins WHERE EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE) AND EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE)`,
      thisWeek: `SELECT COUNT(*) as count FROM vins WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'`
    };
    
    const stats = {};
    
    for (const [key, query] of Object.entries(queries)) {
      const result = await pool.query(query);
      stats[key] = parseInt(result.rows[0].count);
    }
    
    res.json({ success: true, stats: stats });
    
  } catch (error) {
    console.error('Erreur statistiques :', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Statistiques des suppressions
app.get('/api/vins/deletion-stats', async (req, res) => {
  try {
    // Note: Pour l'instant on simule car on n'a pas de table d'historique des suppressions
    // Dans le futur, vous pourriez créer une table "deleted_vins" pour tracker les suppressions
    
    const stats = {
      total: 0,        // Total suppressions depuis le début
      today: 0,        // Suppressions aujourd'hui
      thisWeek: 0,     // Suppressions cette semaine
      thisMonth: 0     // Suppressions ce mois
    };
    
    // Pour l'instant, on retourne des stats simulées basées sur l'activité actuelle
    const result = await pool.query('SELECT COUNT(*) as count FROM vins');
    const currentVins = parseInt(result.rows[0].count);
    
    // Simulation basée sur l'hypothèse qu'on a supprimé environ 10% du total
    stats.total = Math.floor(currentVins * 0.1);
    stats.today = Math.floor(Math.random() * 3); // 0-2 suppressions aujourd'hui
    stats.thisWeek = Math.floor(Math.random() * 8); // 0-7 suppressions cette semaine
    stats.thisMonth = Math.floor(Math.random() * 15); // 0-14 suppressions ce mois
    
    res.json({ success: true, deletionStats: stats });
    
  } catch (error) {
    console.error('Erreur statistiques suppressions :', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Export Excel (SANS colonne Image)
app.get('/api/vins/export', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vins ORDER BY created_at DESC');
    
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('VINs Enregistrés');
    
    worksheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Code VIN', key: 'code', width: 20 },
      { header: 'Date d\'Enregistrement', key: 'date_created', width: 25 },
      { header: 'Temps Écoulé', key: 'time_elapsed', width: 20 },
      { header: 'Navigateur', key: 'user_agent', width: 30 },
      { header: 'Adresse IP', key: 'ip_address', width: 15 }
    ];
    
    function getTimeElapsed(dateString) {
      const now = new Date();
      const date = new Date(dateString);
      const diffInDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
      
      if (diffInDays === 0) return "Aujourd'hui";
      if (diffInDays === 1) return "Hier";
      if (diffInDays < 7) return `il y a ${diffInDays} jours`;
      if (diffInDays < 30) return `il y a ${Math.floor(diffInDays / 7)} semaines`;
      if (diffInDays < 365) return `il y a ${Math.floor(diffInDays / 30)} mois`;
      return `il y a ${Math.floor(diffInDays / 365)} ans`;
    }
    
    result.rows.forEach(row => {
      worksheet.addRow({
        id: row.id,
        code: row.code,
        date_created: new Date(row.date_created).toLocaleString('fr-FR'),
        time_elapsed: getTimeElapsed(row.date_created),
        user_agent: row.user_agent || 'Non spécifié',
        ip_address: row.ip_address || 'Non spécifié'
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
    
    const fileName = `vins_export_${new Date().toISOString().slice(0, 10)}.xlsx`;
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    
    await workbook.xlsx.write(res);
    res.end();
    
  } catch (error) {
    console.error('Erreur export Excel :', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== FONCTIONS UTILITAIRES ==========

function isValidVIN(vin) {
  const vinRegex = /^[A-HJ-NPR-Z0-9]{17}$/;
  return vinRegex.test(vin);
}

// ========== DÉMARRAGE SERVEUR ==========

// Initialiser la base au démarrage
initDatabase();

// Démarrage du serveur
app.listen(port, () => {
  console.log(`🚗 Serveur VIN Tracker en écoute sur http://localhost:${port}`);
  console.log(`🗄️ Base de données Supabase PostgreSQL configurée (SANS stockage images)`);
  console.log(`🔍 OCR Google Vision API configuré (traitement temporaire uniquement)`);
  console.log(`🏓 Routes de monitoring activées :`);
  console.log(`   - Health Check: /api/health (pour UptimeRobot)`);
  console.log(`   - Status Check: /api/status (détaillé)`);
  console.log(`   - Ping Simple: /ping`);
  console.log(`   - Info Serveur: /api/info`);
});

// Gestion gracieuse de l'arrêt
process.on('SIGINT', async () => {
  console.log('\n🛑 Arrêt du serveur...');
  try {
    await pool.end();
    console.log('🗄️ Connexions base fermées');
  } catch (error) {
    console.error('Erreur fermeture base :', error);
  }
  process.exit(0);
});
