const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 1. KONEKSI KE TIDB CLOUD DATABASE
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 4000,
  ssl: { rejectUnauthorized: true }
});

db.connect(err => {
  if (err) {
    console.error('❌ Gagal terhubung ke TiDB Cloud:', err);
  } else {
    console.log('✅ Berhasil terhubung ke TiDB Cloud Database.');

    const initSettingsSql = `
      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key VARCHAR(100) PRIMARY KEY,
        setting_value LONGTEXT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `;
    db.query(initSettingsSql, (tblErr) => {
      if (tblErr) console.error('Error inisialisasi tabel app_settings:', tblErr.message);
      else console.log('✅ Tabel app_settings siap digunakan.');
    });
  }
});

// 2. KONFIGURASI MULTER & GOOGLE DRIVE OAUTH2
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // Dukungan hingga 2 GB
});

let driveClient = null;
let oauth2Client = null;
const oauthPath = path.join(__dirname, 'oauth-credentials.json');
const tokenPath = path.join(__dirname, 'drive-token.json');

function initDriveOAuth() {
  if (!fs.existsSync(oauthPath)) {
    console.warn('⚠️ File oauth-credentials.json belum ditemukan.');
    return;
  }
  const raw = JSON.parse(fs.readFileSync(oauthPath, 'utf8'));
  const creds = raw.web || raw.installed;
  oauth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    'http://localhost:3000/oauth2callback'
  );

  if (fs.existsSync(tokenPath)) {
    const savedTokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    oauth2Client.setCredentials(savedTokens);
    driveClient = google.drive({ version: 'v3', auth: oauth2Client });
    console.log('✅ Google Drive OAuth2 siap digunakan (Kuota Pribadi Aktif).');
  } else {
    console.log('👉 Buka http://localhost:3000/auth-drive di browser untuk menghubungkan akun Google Drive Anda.');
  }
}
initDriveOAuth();

app.get('/auth-drive', (req, res) => {
  if (!oauth2Client) {
    initDriveOAuth();
    if (!oauth2Client) return res.send('File oauth-credentials.json belum ditemukan.');
  }
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive']
  });
  res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
    driveClient = google.drive({ version: 'v3', auth: oauth2Client });
    res.send('<h2 style="font-family:sans-serif; color:#0D9488; text-align:center; margin-top:50px;">✅ Google Drive Berhasil Terhubung! Silakan tutup tab ini dan kembali ke aplikasi Amanah Scene Vault.</h2>');
  } catch (err) {
    res.status(500).send('Gagal otorisasi Drive: ' + err.message);
  }
});

// 3. API ROUTES (DATABASE SCENES)
app.get('/api/scenes', (req, res) => {
  const query = 'SELECT * FROM scenes ORDER BY id DESC';
  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching scenes:', err);
      return res.status(500).json({ error: err.message });
    }

    const formatted = results.map(row => ({
      id: row.id,
      folder: row.folder || row.folder_name || 'Folder Utama',
      category: row.category || row.category_name || 'Kategori Umum',
      fileName: row.fileName || row.file_name || 'Untitled Video',
      driveLink: row.driveLink || row.drive_link || '',
      fileId: row.fileId || row.drive_file_id || '',
      timestamp: row.timestamp || row.timestamp_label || '-',
      description: row.description || '',
      tags: row.tags ? (Array.isArray(row.tags) ? row.tags : row.tags.split(',').map(t => t.trim()).filter(Boolean)) : []
    }));

    res.json(formatted);
  });
});

app.post('/api/scenes', (req, res) => {
  const { folder, category, fileName, driveLink, timestamp, description, tags } = req.body;
  let fileId = null;

  if (driveLink) {
    const match = driveLink.match(/(?:id=|folders\/|d\/)([a-zA-Z0-9_-]+)/);
    fileId = match ? match[1] : null;
  }

  const query = `
    INSERT INTO scenes (folder_name, category_name, file_name, drive_link, drive_file_id, timestamp_label, description, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.query(query, [
    folder || 'Folder Utama',
    category || 'Kategori Umum',
    fileName || 'Untitled Scene',
    driveLink || '',
    fileId,
    timestamp || '-',
    description || '',
    Array.isArray(tags) ? tags.join(',') : (tags || '')
  ], (err, result) => {
    if (err) {
      console.error('Error insert scene:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true, id: result.insertId });
  });
});

app.put('/api/scenes/:id', (req, res) => {
  const { id } = req.params;
  const { folder, category, fileName, driveLink, timestamp, description, tags } = req.body;
  let fileId = null;

  if (driveLink) {
    const match = driveLink.match(/(?:id=|folders\/|d\/)([a-zA-Z0-9_-]+)/);
    fileId = match ? match[1] : null;
  }

  const query = `
    UPDATE scenes 
    SET folder_name = ?, category_name = ?, file_name = ?, drive_link = ?, drive_file_id = ?, timestamp_label = ?, description = ?, tags = ?
    WHERE id = ?
  `;

  db.query(query, [
    folder, category, fileName, driveLink, fileId, timestamp, description,
    Array.isArray(tags) ? tags.join(',') : (tags || ''),
    id
  ], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.delete('/api/scenes/:id', (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM scenes WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// 4. API SETTINGS
app.get('/api/settings', (req, res) => {
  db.query('SELECT setting_key, setting_value FROM app_settings', (err, results) => {
    if (err) {
      console.error('Error fetching app_settings:', err);
      return res.json({});
    }
    const settings = {};
    results.forEach(row => {
      settings[row.setting_key] = row.setting_value;
    });
    res.json(settings);
  });
});

app.post('/api/settings', (req, res) => {
  const payload = req.body || {};
  const entries = Object.entries(payload);
  if (entries.length === 0) return res.json({ success: true });

  let completed = 0;
  entries.forEach(([k, v]) => {
    const valStr = typeof v === 'string' ? v : JSON.stringify(v);
    const query = `
      INSERT INTO app_settings (setting_key, setting_value)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
    `;
    db.query(query, [k, valStr], (dbErr) => {
      if (dbErr) console.error('Gagal update setting:', dbErr.message);
      completed++;
      if (completed === entries.length) {
        res.json({ success: true });
      }
    });
  });
});

// 5. API UPLOAD VIDEO KE GOOGLE DRIVE OAUTH2
app.post('/api/upload-video', upload.single('videoFile'), async (req, res) => {
  try {
    if (!driveClient) {
      return res.status(500).json({ error: 'Google Drive OAuth2 belum terhubung. Buka http://localhost:3000/auth-drive' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'Tidak ada file video yang dikirim.' });
    }

    const { folder, category, customFileName, targetDriveLink } = req.body;

    let parentFolderId = null;
    if (targetDriveLink) {
      const match = targetDriveLink.match(/folders\/([a-zA-Z0-9_-]+)/);
      parentFolderId = match ? match[1] : targetDriveLink.trim();
    }

    const bufferStream = new stream.PassThrough();
    bufferStream.end(file.buffer);

    const fileName = customFileName || file.originalname;

    const driveRes = await driveClient.files.create({
      requestBody: {
        name: fileName,
        parents: parentFolderId ? [parentFolderId] : []
      },
      media: {
        mimeType: file.mimetype || 'video/mp4',
        body: bufferStream
      },
      fields: 'id, name, webViewLink'
    });

    const fileId = driveRes.data.id;

    try {
      await driveClient.permissions.create({
        fileId: fileId,
        requestBody: { role: 'reader', type: 'anyone' }
      });
    } catch (permErr) {
      console.warn('Izin akses Drive publik:', permErr.message);
    }

    const fullDriveLink = `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;

    db.query('SHOW COLUMNS FROM scenes LIKE "folder"', (colErr, cols) => {
      const isCamelCase = cols && cols.length > 0;
      const insertQuery = isCamelCase
        ? `INSERT INTO scenes (folder, category, fileName, driveLink, fileId, timestamp, description, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        : `INSERT INTO scenes (folder_name, category_name, file_name, drive_link, drive_file_id, timestamp_label, description, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

      db.query(insertQuery, [
        folder || 'Folder Utama',
        category || 'Kategori Umum',
        fileName,
        fullDriveLink,
        fileId,
        '-',
        'Uploaded via OAuth2',
        ''
      ], (dbErr, dbResult) => {
        if (dbErr) {
          return res.status(500).json({ error: 'Gagal simpan ke database: ' + dbErr.message });
        }

        res.json({
          success: true,
          message: 'Video berhasil diunggah ke Google Drive!',
          fileId: fileId,
          fileName: fileName,
          id: dbResult.insertId
        });
      });
    });

  } catch (error) {
    console.error('Error saat upload video:', error);
    res.status(500).json({ error: error.message || 'Gagal mengunggah file ke Google Drive' });
  }
});

// 6. MENJALANKAN SERVER
const PORT = process.env.PORT || 3000;
// Tambahkan baris ini agar server otomatis membaca file di folder public
app.use(express.static('public'));

// Atau jika root route belum diset:
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});
