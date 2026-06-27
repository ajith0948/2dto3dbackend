/**
 * server.js - Express Backend for 2D to 3D MERN App
 * READS data.txt FIRST on startup before anything else.
 */

const express = require('express');
require('dotenv').config();
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// ── FIRST PRIORITY: Read data.txt ─────────────────────────────────────
const { readDataFile, updateDataFile } = require('./utils/dataManager');

console.log('\n' + '='.repeat(60));
console.log('  2D-to-3D Backend Starting Up');
console.log('  STEP 1: Reading data.txt configuration...');
console.log('='.repeat(60));

let config;
try {
  config = readDataFile();
  console.log(`  Active Model   : ${config.MODEL_NAME}`);
  console.log(`  AI Service URL : ${config.AI_SERVICE_URL}`);
  console.log(`  MongoDB URI    : ${process.env.MONGODB_URI || config.MONGODB_URI}`);
  console.log('='.repeat(60) + '\n');
} catch (err) {
  console.error('FATAL: Cannot read data.txt -', err.message);
  process.exit(1);
}

const app = express();

// ── Security & Rate Limiting ──────────────────────────────────────────
// Apply Helmet for robust security headers
app.use(helmet());
// Allow cross-origin resources for 3D model sharing
app.use(helmet.crossOriginResourcePolicy({ policy: "cross-origin" }));

// Global Rate Limiter: Maximum 150 requests per 15 minutes
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// ── Middleware ────────────────────────────────────────────────────────
// Allow any localhost port (Vite picks 5173, 5174, etc. automatically)
app.use(cors({
  origin: (origin, callback) => {
    const allowedFrontend = process.env.FRONTEND_URL;
    if (!origin || origin.match(/^http:\/\/localhost:\d+$/) || origin === allowedFrontend) {
      callback(null, true);
    } else {
      callback(new Error('CORS: origin not allowed'));
    }
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded models statically
app.use('/uploads', express.static(path.join(config.UPLOAD_DIR || 'D:/2d-to-3d/uploads')));

// ── Routes ────────────────────────────────────────────────────────────
const convertRoutes = require('./routes/convert');
const historyRoutes = require('./routes/history');
const configRoutes  = require('./routes/config');
const authRoutes    = require('./routes/auth');

app.use('/api/convert', convertRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/config',  configRoutes);
app.use('/api/auth',    authRoutes);

// ── Root ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const cfg = readDataFile(); // Always re-read for freshness
  res.json({
    message: '2D-to-3D Backend API',
    model: cfg.MODEL_NAME,
    status: cfg.SYSTEM_STATUS,
    totalConversions: cfg.TOTAL_CONVERSIONS,
    endpoints: [
      'POST /api/convert - Upload image for conversion',
      'GET  /api/history - Get conversion history',
      'GET  /api/config  - Get current data.txt config',
    ]
  });
});

// ── MongoDB Connection ────────────────────────────────────────────────
const mongoUri = process.env.MONGODB_URI || config.MONGODB_URI || 'mongodb://localhost:27017/2d-to-3d';

mongoose.connect(mongoUri)
  .then(() => {
    console.log('[MongoDB] Connected to:', mongoUri);
    updateDataFile({ MONGODB_STATUS: 'connected' });
  })
  .catch(err => {
    console.warn('[MongoDB] Connection failed:', err.message);
    console.warn('[MongoDB] Continuing without DB - history will be in-memory only');
    updateDataFile({ MONGODB_STATUS: 'disconnected' });
  });

// ── Start Server ──────────────────────────────────────────────────────
const PORT = process.env.PORT || parseInt(config.BACKEND_PORT || '5000');
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`[Server] Backend running at http://${HOST}:${PORT}`);
  updateDataFile({ BACKEND_STATUS: 'running' });
});

// Graceful shutdown
process.on('SIGINT', () => {
  updateDataFile({ BACKEND_STATUS: 'stopped' });
  console.log('\n[Server] Shutting down gracefully...');
  process.exit(0);
});
