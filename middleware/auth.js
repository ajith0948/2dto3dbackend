/**
 * auth.js - JWT Authentication Middleware
 */

const jwt = require('jsonwebtoken');
const { readDataFile } = require('../utils/dataManager');

// Get secret key with a default fallback
const getJwtSecret = () => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try {
    const config = readDataFile();
    return config.JWT_SECRET || 'antigravity-secret-key-2026-default';
  } catch (err) {
    return 'antigravity-secret-key-2026-default';
  }
};

/**
 * Middleware to require authentication (blocks if not logged in)
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required. Please log in.' });
  }

  try {
    const secret = getJwtSecret();
    const decoded = jwt.verify(token, secret);
    req.user = decoded; // Contains id, username, email
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(403).json({ error: 'Invalid or tampered token' });
  }
}

/**
 * Middleware to optionally parse authentication (does NOT block if not logged in)
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return next();
  }

  try {
    const secret = getJwtSecret();
    const decoded = jwt.verify(token, secret);
    req.user = decoded;
  } catch (err) {
    // Ignore error, proceed as anonymous
  }
  next();
}

module.exports = {
  requireAuth,
  optionalAuth,
  getJwtSecret,
};
