/**
 * dataManager.js
 * FIRST PRIORITY UTILITY - reads and writes to data.txt
 * Called before any major operation in the backend.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE_PATH = process.env.DATA_FILE_PATH || path.join(__dirname, '..', '..', 'data.txt');

let _cloudModeLogged = false;

/**
 * Read and parse data.txt into a key-value object.
 * Lines starting with # are comments and are skipped.
 * Returns empty config if data.txt is missing (expected on cloud deployments).
 */
function readDataFile() {
  try {
    if (!fs.existsSync(DATA_FILE_PATH)) {
      if (!_cloudModeLogged) {
        console.warn('[dataManager] data.txt not found — using environment variables only (cloud mode).');
        _cloudModeLogged = true;
      }
      return {};
    }
    const content = fs.readFileSync(DATA_FILE_PATH, 'utf-8');
    const config = {};
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      const value = trimmed.substring(eqIdx + 1).trim();
      config[key] = value;
    }
    return config;
  } catch (err) {
    console.error('[dataManager] Error reading data.txt:', err.message);
    throw err;
  }
}

/**
 * Update one or more key-value pairs in data.txt.
 * Preserves all comments and structure.
 * @param {Object} updates - key:value pairs to update
 */
function updateDataFile(updates) {
  try {
    if (!fs.existsSync(DATA_FILE_PATH)) {
      // Cloud mode — no data.txt, skip silently
      return;
    }
    let content = fs.readFileSync(DATA_FILE_PATH, 'utf-8');
    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        // Append new key at end if not found
        content += `\n${key}=${value}`;
      }
    }
    // Always update LAST_SYSTEM_CHECK
    const now = new Date().toISOString().split('T')[0];
    content = content.replace(/^LAST_SYSTEM_CHECK=.*$/m, `LAST_SYSTEM_CHECK=${now}`);
    fs.writeFileSync(DATA_FILE_PATH, content, 'utf-8');
    console.log('[dataManager] data.txt updated:', Object.keys(updates).join(', '));
  } catch (err) {
    console.error('[dataManager] Error updating data.txt:', err.message);
  }
}

/**
 * Append a new conversion log entry to data.txt.
 * @param {string} id - conversion ID
 * @param {string} input - input filename
 * @param {string} output - output .glb filename
 * @param {string} status - 'success' | 'failed'
 * @param {number} durationSec - time taken
 */
function logConversion(id, input, output, status, durationSec) {
  try {
    if (!fs.existsSync(DATA_FILE_PATH)) {
      console.log(`[dataManager] Conversion #${id} logged (cloud mode, skipping data.txt) - ${status}`);
      return;
    }
    const timestamp = new Date().toISOString();
    const logLine = `\nLOG_${id}=${timestamp}|${input}|${output}|${status}|${durationSec}s`;
    fs.appendFileSync(DATA_FILE_PATH, logLine, 'utf-8');

    // Update stats
    const config = readDataFile();
    const total = parseInt(config.TOTAL_CONVERSIONS || '0') + 1;
    const successful = parseInt(config.SUCCESSFUL_CONVERSIONS || '0') + (status === 'success' ? 1 : 0);
    const failed = parseInt(config.FAILED_CONVERSIONS || '0') + (status === 'failed' ? 1 : 0);

    updateDataFile({
      TOTAL_CONVERSIONS: total,
      SUCCESSFUL_CONVERSIONS: successful,
      FAILED_CONVERSIONS: failed,
      LAST_CONVERSION_ID: id,
      LAST_CONVERSION_TIME: timestamp,
      LAST_CONVERSION_INPUT: input,
      LAST_CONVERSION_OUTPUT: output,
    });
    console.log(`[dataManager] Conversion #${id} logged - ${status}`);
  } catch (err) {
    console.error('[dataManager] Error logging conversion:', err.message);
  }
}

/**
 * Get the current model configuration from data.txt.
 */
function getModelConfig() {
  const config = readDataFile();
  return {
    modelName: config.MODEL_NAME,
    modelVersion: config.MODEL_VERSION,
    modelPath: config.MODEL_PATH,
    modelStatus: config.MODEL_STATUS,
    aiServiceUrl: config.AI_SERVICE_URL,
    outputFormat: config.OUTPUT_FORMAT,
    meshResolution: config.MESH_RESOLUTION,
    textureResolution: config.TEXTURE_RESOLUTION,
    numViews: config.NUM_VIEWS,
  };
}

/**
 * Update model configuration in data.txt.
 * Call this whenever the AI model is changed.
 */
function updateModelConfig(newModelData) {
  updateDataFile({
    MODEL_NAME: newModelData.modelName || 'InstantMesh',
    MODEL_VERSION: newModelData.modelVersion || '1.0',
    MODEL_PATH: newModelData.modelPath || 'D:/2d-to-3d/ai-service/models/instant-mesh',
    MODEL_STATUS: newModelData.modelStatus || 'not_installed',
    MODEL_LAST_UPDATED: new Date().toISOString().split('T')[0],
  });
}

module.exports = {
  readDataFile,
  updateDataFile,
  logConversion,
  getModelConfig,
  updateModelConfig,
  DATA_FILE_PATH,
};
