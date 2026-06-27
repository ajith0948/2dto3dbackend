/**
 * Conversion model - MongoDB schema
 */

const mongoose = require('mongoose');

const conversionSchema = new mongoose.Schema({
  jobId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
  },
  inputFileName: { type: String, required: true },
  inputFilePath: { type: String },
  outputFilePath: { type: String },
  outputFileUrl:  { type: String },
  status: {
    type: String,
    enum: ['queued', 'processing', 'completed', 'failed'],
    default: 'queued',
  },
  progress: { type: Number, default: 0 },
  message:  { type: String, default: '' },
  errorMsg: { type: String },
  modelUsed: { type: String, default: 'InstantMesh' }, // from data.txt
  durationSec: { type: Number },
  createdAt: { type: Date, default: Date.now },
  completedAt: { type: Date },
});

module.exports = mongoose.model('Conversion', conversionSchema);
