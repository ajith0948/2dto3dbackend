/**
 * routes/history.js
 * GET /api/history - Get conversion history from MongoDB + data.txt
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { readDataFile } = require('../utils/dataManager');
const Conversion = require('../models/Conversion');
const { optionalAuth } = require('../middleware/auth');
const { historyCache } = require('../utils/cache');

// GET /api/history
router.get('/', optionalAuth, async (req, res) => {
  // FIRST PRIORITY: read data.txt
  const cfg = readDataFile();
  
  try {
    const userIdStr = req.user ? req.user.id : 'anonymous';
    const limit = parseInt(req.query.limit) || 20;
    const cacheKey = `history_${userIdStr}_${limit}`;

    // Check Cache
    const cachedHistory = historyCache.get(cacheKey);
    if (cachedHistory) {
      return res.json({ ...cachedHistory, cached: true });
    }

    const filter = req.user ? { userId: req.user.id } : { userId: { $exists: false } };
    const conversions = await Conversion.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('-__v');

    const aiServiceUrl = cfg.AI_SERVICE_URL || 'http://localhost:8000';

    // Proactively check status of any queued or processing jobs in the returned list
    const updatedConversions = await Promise.all(
      conversions.map(async (conv) => {
        if (conv.status === 'queued' || conv.status === 'processing') {
          try {
            const aiRes = await axios.get(`${aiServiceUrl}/status/${conv.jobId}`, { timeout: 2000 });
            const jobData = aiRes.data;
            if (jobData.status !== conv.status) {
              const outputUrl = jobData.output_file
                ? `/uploads/models/${path.basename(jobData.output_file)}`
                : null;
              
              const updated = await Conversion.findOneAndUpdate(
                { jobId: conv.jobId },
                {
                  status: jobData.status,
                  progress: jobData.progress,
                  message: jobData.message,
                  outputFilePath: jobData.output_file,
                  outputFileUrl: outputUrl,
                  completedAt: jobData.status === 'completed' || jobData.status === 'failed' ? new Date() : undefined,
                },
                { new: true }
              );
              return updated || conv;
            }
          } catch (err) {
            // If the AI service does not know about the job (e.g. server restarted and wiped in-memory job state),
            // and the job has been queued/processing for a long time, we can mark it as failed.
            if (err.response?.status === 404) {
              const ageMs = Date.now() - new Date(conv.createdAt).getTime();
              if (ageMs > 5 * 60 * 1000) {
                const updated = await Conversion.findOneAndUpdate(
                  { jobId: conv.jobId },
                  {
                    status: 'failed',
                    message: 'Job lost due to service restart',
                    completedAt: new Date(),
                  },
                  { new: true }
                );
                return updated || conv;
              }
            }
          }
        }
        return conv;
      })
    );
    
    const responsePayload = {
      success: true,
      total: await Conversion.countDocuments(filter),
      totalFromDataTxt: cfg.TOTAL_CONVERSIONS,
      conversions: updatedConversions,
    };

    // Only cache if there are no active jobs running, to preserve real-time polling UX
    const hasActiveJobs = updatedConversions.some(c => c.status === 'queued' || c.status === 'processing');
    if (!hasActiveJobs) {
      historyCache.set(cacheKey, responsePayload);
    }

    res.json({ ...responsePayload, cached: false });
  } catch (err) {
    // If MongoDB is down, return stats from data.txt
    res.json({
      success: true,
      source: 'data.txt (MongoDB unavailable)',
      totalConversions: cfg.TOTAL_CONVERSIONS,
      successfulConversions: cfg.SUCCESSFUL_CONVERSIONS,
      failedConversions: cfg.FAILED_CONVERSIONS,
      lastConversion: {
        id: cfg.LAST_CONVERSION_ID,
        time: cfg.LAST_CONVERSION_TIME,
        input: cfg.LAST_CONVERSION_INPUT,
        output: cfg.LAST_CONVERSION_OUTPUT,
      },
      conversions: [],
    });
  }
});

// GET /api/history/:jobId
router.get('/:jobId', async (req, res) => {
  readDataFile(); // Always read first
  try {
    const conv = await Conversion.findOne({ jobId: req.params.jobId });
    if (!conv) return res.status(404).json({ error: 'Job not found' });
    res.json({ success: true, conversion: conv });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/history/:jobId
router.delete('/:jobId', optionalAuth, async (req, res) => {
  try {
    const { jobId } = req.params;
    const filter = { jobId };
    if (req.user) {
      filter.userId = req.user.id;
    } else {
      filter.userId = { $exists: false };
    }
    const conv = await Conversion.findOne(filter);
    if (!conv) {
      return res.status(404).json({ error: 'Job not found in history or unauthorized' });
    }

    // Clean up files on disk to save space
    if (conv.inputFilePath && fs.existsSync(conv.inputFilePath)) {
      try {
        fs.unlinkSync(conv.inputFilePath);
      } catch (err) {
        console.warn(`[History Delete] Failed to delete input file: ${conv.inputFilePath}`, err.message);
      }
    }

    if (conv.outputFilePath && fs.existsSync(conv.outputFilePath)) {
      try {
        fs.unlinkSync(conv.outputFilePath);
      } catch (err) {
        console.warn(`[History Delete] Failed to delete output file: ${conv.outputFilePath}`, err.message);
      }
    }

    // Delete document from MongoDB
    await Conversion.deleteOne({ jobId });

    // Invalidate Cache for this user
    const userIdStr = req.user ? req.user.id : 'anonymous';
    const keysToDel = historyCache.keys().filter(k => k.startsWith(`history_${userIdStr}`));
    if (keysToDel.length > 0) historyCache.del(keysToDel);

    res.json({ success: true, message: `Job ${jobId} deleted successfully` });
  } catch (err) {
    console.error('[History Delete] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
