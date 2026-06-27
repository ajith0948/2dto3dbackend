/**
 * routes/config.js
 * GET /api/config - Return current data.txt configuration
 * This is the live mirror of data.txt for the frontend
 */

const express = require('express');
const router = express.Router();
const { readDataFile, updateDataFile, updateModelConfig } = require('../utils/dataManager');

// GET /api/config - Full config from data.txt
router.get('/', (req, res) => {
  const cfg = readDataFile();
  // Filter out LOG_ entries for API response
  const clean = Object.fromEntries(
    Object.entries(cfg).filter(([k]) => !k.startsWith('LOG_'))
  );
  res.json({ success: true, config: clean });
});

// GET /api/config/model - Just model config
router.get('/model', (req, res) => {
  const cfg = readDataFile();
  res.json({
    success: true,
    model: {
      name: cfg.MODEL_NAME,
      version: cfg.MODEL_VERSION,
      status: cfg.MODEL_STATUS,
      lastUpdated: cfg.MODEL_LAST_UPDATED,
      path: cfg.MODEL_PATH,
    }
  });
});

// PATCH /api/config/model - Update model in data.txt
router.patch('/model', (req, res) => {
  const { modelName, modelVersion, modelPath } = req.body;
  if (!modelName) {
    return res.status(400).json({ error: 'modelName is required' });
  }
  
  updateModelConfig({
    modelName,
    modelVersion: modelVersion || '1.0',
    modelPath: modelPath || `D:/2d-to-3d/ai-service/models/${modelName.toLowerCase()}`,
    modelStatus: 'not_installed',
  });
  
  const updated = readDataFile();
  res.json({
    success: true,
    message: `Model updated to ${modelName} in data.txt`,
    model: {
      name: updated.MODEL_NAME,
      status: updated.MODEL_STATUS,
      lastUpdated: updated.MODEL_LAST_UPDATED,
    }
  });
});

// GET /api/config/stats - Conversion stats
router.get('/stats', (req, res) => {
  const cfg = readDataFile();
  res.json({
    success: true,
    stats: {
      total: cfg.TOTAL_CONVERSIONS,
      successful: cfg.SUCCESSFUL_CONVERSIONS,
      failed: cfg.FAILED_CONVERSIONS,
      lastConversionId: cfg.LAST_CONVERSION_ID,
      lastConversionTime: cfg.LAST_CONVERSION_TIME,
      systemStatus: cfg.SYSTEM_STATUS,
      mongodbStatus: cfg.MONGODB_STATUS,
      aiServiceStatus: cfg.AI_SERVICE_STATUS,
    }
  });
});

module.exports = router;
