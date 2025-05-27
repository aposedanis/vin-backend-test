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

// Initialiser la base de données
const db = new sqlite3.Database('./vins.db');
db.run(\`
    CREATE TABLE IF NOT EXISTS vins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        date TEXT NOT NULL,
        image TEXT
    )
\`);

// Configurer multer
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: function(req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Routes API
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

app.listen(port, () => {
    console.log(`Serveur VIN Tracker en écoute sur http://localhost:${port}`);
});