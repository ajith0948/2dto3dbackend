/**
 * routes/convert.js
 * POST /api/convert - Upload image, save to GridFS, and queue for AI Worker
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { Readable } = require('stream');

const { readDataFile, getModelConfig } = require('../utils/dataManager');
const Conversion = require('../models/Conversion');
const { optionalAuth } = require('../middleware/auth');

// ── Multer Setup (Memory Storage) ──────────────────────────────────────
const storage = multer.memoryStorage();
const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPG, PNG, WebP allowed.'), false);
  }
};
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

// Helper to get GridFS bucket
const getGridFS = () => {
  if (!mongoose.connection.db) throw new Error('Database not connected');
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: 'uploads'
  });
};

// ── POST /api/convert ─────────────────────────────────────────────────
router.post('/', optionalAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    const cfg = readDataFile();
    const modelCfg = getModelConfig();
    const jobId = uuidv4().slice(0, 8).toUpperCase();
    
    // Save image to GridFS
    const bucket = getGridFS();
    const ext = path.extname(req.file.originalname).toLowerCase();
    const filename = `${jobId}_input${ext}`;
    
    const uploadStream = bucket.openUploadStream(filename, {
      contentType: req.file.mimetype
    });
    
    const readable = new Readable();
    readable.push(req.file.buffer);
    readable.push(null);
    readable.pipe(uploadStream);

    await new Promise((resolve, reject) => {
      uploadStream.on('finish', resolve);
      uploadStream.on('error', reject);
    });

    // Save Job to MongoDB
    await Conversion.create({
      jobId: jobId,
      userId: req.user ? req.user.id : undefined,
      inputFileName: filename,
      inputFilePath: `gridfs://${uploadStream.id}`, 
      status: 'queued',
      message: 'Job queued. Waiting for AI server to start...',
      modelUsed: modelCfg.modelName,
    });

    // Invalidate Cache for this user
    try {
      const { historyCache } = require('../utils/cache');
      const userIdStr = req.user ? req.user.id : 'anonymous';
      const keysToDel = historyCache.keys().filter(k => k.startsWith(`history_${userIdStr}`));
      if (keysToDel.length > 0) historyCache.del(keysToDel);
    } catch (e) {
      // cache invalidation optional if module not found
    }
    
    res.json({
      success: true,
      jobId: jobId,
      status: 'queued',
      message: 'Job queued successfully',
      pollUrl: `/api/convert/status/${jobId}`,
      model: modelCfg.modelName,
    });

  } catch (err) {
    console.error('[/api/convert] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/convert/status/:jobId ───────────────────────────────────
router.get('/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await Conversion.findOne({ jobId });
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    res.json({
      job_id: jobId,
      status: job.status,
      progress: job.progress || 0,
      message: job.message,
      downloadUrl: job.status === 'completed' ? `/api/convert/download/${jobId}` : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/convert/download/:jobId ─────────────────────────────────
router.get('/download/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const format = (req.query.format || 'glb').toLowerCase();
    
    const bucket = getGridFS();
    const filename = `${jobId}_output.${format}`;
    
    // Check if file exists
    const files = await bucket.find({ filename }).toArray();
    if (!files || files.length === 0) {
      return res.status(404).json({ error: 'Model file not found. AI might not have generated this format.' });
    }
    
    let contentType = 'model/gltf-binary';
    if (format === 'obj') contentType = 'model/obj';
    else if (format === 'stl') contentType = 'model/stl';
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="model_${jobId}.${format}"`);
    
    const downloadStream = bucket.openDownloadStreamByName(filename);
    downloadStream.pipe(res);
 
  } catch (err) {
    console.error(`[/api/convert/download] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/queue/pending (Worker Only) ──────────────────────────────
// Laptop fetches pending jobs here
router.get('/queue/pending', async (req, res) => {
  try {
    const job = await Conversion.findOneAndUpdate(
      { status: 'queued' },
      { 
        status: 'processing', 
        message: 'AI worker picked up job', 
        progress: 10 
      },
      { sort: { createdAt: 1 }, new: true } // oldest first
    );

    if (!job) {
      return res.json({ job: null });
    }
    
    res.json({ job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/queue/image/:filename (Worker Only) ──────────────────────
router.get('/queue/image/:filename', async (req, res) => {
  try {
    const bucket = getGridFS();
    const downloadStream = bucket.openDownloadStreamByName(req.params.filename);
    
    downloadStream.on('error', () => {
      res.status(404).json({ error: 'Image not found in GridFS' });
    });
    
    downloadStream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/queue/complete/:jobId (Worker Only) ─────────────────────
// Worker uploads the finished GLB model here
const workerUpload = multer({ storage: multer.memoryStorage() });
router.post('/queue/complete/:jobId', workerUpload.single('model'), async (req, res) => {
  try {
    const { jobId } = req.params;
    const { status, message, error } = req.body;
    
    if (status === 'failed') {
      await Conversion.findOneAndUpdate(
        { jobId },
        { status: 'failed', message: error || 'Worker failed', progress: 0 }
      );
      return res.json({ success: true });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No model file provided' });
    }

    const bucket = getGridFS();
    const filename = `${jobId}_output.glb`;
    
    // First remove any existing with this name
    const existing = await bucket.find({ filename }).toArray();
    for (const doc of existing) {
      await bucket.delete(doc._id);
    }
    
    const uploadStream = bucket.openUploadStream(filename, {
      contentType: 'model/gltf-binary'
    });
    
    const readable = new Readable();
    readable.push(req.file.buffer);
    readable.push(null);
    readable.pipe(uploadStream);

    await new Promise((resolve, reject) => {
      uploadStream.on('finish', resolve);
      uploadStream.on('error', reject);
    });

    await Conversion.findOneAndUpdate(
      { jobId },
      { 
        status: 'completed', 
        message: message || 'Conversion completed successfully', 
        progress: 100,
        outputFileUrl: `/api/convert/download/${jobId}`,
        completedAt: new Date()
      }
    );
    
    res.json({ success: true });
  } catch (err) {
    console.error(`[/api/queue/complete] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
