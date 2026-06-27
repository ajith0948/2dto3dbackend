/**
 * routes/auth.js - Authentication Endpoints
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');

const User = require('../models/User');
const { requireAuth, getJwtSecret } = require('../middleware/auth');
const { readDataFile } = require('../utils/dataManager');

// User profile cache (5 minutes TTL)
const authCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// OTP Cache (10 minutes TTL)
const otpCache = new NodeCache({ stdTTL: 600, checkperiod: 60 });

// Configure Nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Strict rate limiter for auth endpoints (10 req / 15 mins)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many authentication attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Zod Validation Schemas
const registerSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters").max(30).trim(),
  email: z.string().email("Invalid email address").trim().toLowerCase(),
  password: z.string().min(6, "Password must be at least 6 characters").max(100)
});

const loginSchema = z.object({
  emailOrUsername: z.string().min(3, "Email or Username is required").trim(),
  password: z.string().min(6, "Password is required")
});

const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email address").trim().toLowerCase()
});

const resetPasswordSchema = z.object({
  password: z.string().min(6, "Password must be at least 6 characters").max(100)
});

// Helper to get refresh secret with a fallback
const getRefreshSecret = () => {
  if (process.env.JWT_REFRESH_SECRET) return process.env.JWT_REFRESH_SECRET;
  try {
    const config = readDataFile();
    return config.JWT_REFRESH_SECRET || 'antigravity-refresh-secret-key-2026-default';
  } catch (err) {
    return 'antigravity-refresh-secret-key-2026-default';
  }
};

// Helper to generate access token (15 minutes expiry)
const generateAccessToken = (user) => {
  const secret = getJwtSecret();
  return jwt.sign(
    { id: user._id, username: user.username, email: user.email },
    secret,
    { expiresIn: '15m' }
  );
};

// Helper to generate refresh token (7 days expiry)
const generateRefreshToken = (user) => {
  const secret = getRefreshSecret();
  return jwt.sign(
    { id: user._id },
    secret,
    { expiresIn: '7d' }
  );
};

// POST /api/auth/register/request-otp
router.post('/register/request-otp', authLimiter, async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const { username, email, password } = parsed.data;

    // Check if user exists
    const existingUser = await User.findOne({
      $or: [
        { email: email.toLowerCase() },
        { username: username.toLowerCase() }
      ]
    });

    if (existingUser) {
      return res.status(400).json({ error: 'Username or Email is already registered' });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Cache the registration details and OTP against the email
    otpCache.set(email.toLowerCase(), {
      username: username.trim(),
      email: email.toLowerCase().trim(),
      password, // Note: storing raw password temporarily in memory cache
      otp
    });

    // Send email
    const mailOptions = {
      from: `"2D to 3D Studio" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Your Sign Up Verification Code',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
          <h2 style="color: #6378ff;">Welcome to the 3D Studio!</h2>
          <p>Hi ${username},</p>
          <p>Please use the following 6-digit OTP to complete your registration:</p>
          <h1 style="letter-spacing: 5px; color: #a855f7;">${otp}</h1>
          <p>This code will expire in 10 minutes.</p>
          <p>If you did not request this, please ignore this email.</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);

    res.json({ success: true, message: 'OTP sent to email' });
  } catch (err) {
    console.error('[Register Request OTP] Error:', err.message);
    res.status(500).json({ error: 'Failed to send OTP email. Please check server logs.' });
  }
});

// POST /api/auth/register/verify-otp
router.post('/register/verify-otp', authLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP are required' });
    }

    const cachedData = otpCache.get(email.toLowerCase());
    if (!cachedData) {
      return res.status(400).json({ error: 'OTP expired or not requested' });
    }

    if (cachedData.otp !== otp) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    // OTP is valid, create user
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(cachedData.password, salt);

    const newUser = new User({
      username: cachedData.username,
      email: cachedData.email,
      password: hashedPassword,
    });

    const accessToken = generateAccessToken(newUser);
    const refreshToken = generateRefreshToken(newUser);

    newUser.refreshTokens.push(refreshToken);
    await newUser.save();

    // Clear cache
    otpCache.del(email.toLowerCase());

    res.status(201).json({
      success: true,
      accessToken,
      refreshToken,
      user: {
        id: newUser._id,
        username: newUser.username,
        email: newUser.email,
      }
    });
  } catch (err) {
    console.error('[Register Verify OTP] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post('/login', authLimiter, async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const { emailOrUsername, password } = parsed.data;

    // Find user by either email or username
    const user = await User.findOne({
      $or: [
        { email: emailOrUsername.toLowerCase().trim() },
        { username: emailOrUsername.trim() }
      ]
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    user.refreshTokens.push(refreshToken);
    await user.save();

    res.json({
      success: true,
      accessToken,
      refreshToken,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
      }
    });
  } catch (err) {
    console.error('[Login] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/google
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Google credential ID token is required' });
    }

    // Verify token with Google's API
    let googleUser;
    try {
      const response = await axios.get(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`, { timeout: 5000 });
      googleUser = response.data;
    } catch (err) {
      console.error('[Google Auth] Verification failed:', err.message);
      return res.status(400).json({ error: 'Failed to verify Google credentials' });
    }

    if (!googleUser || !googleUser.email) {
      return res.status(400).json({ error: 'Invalid Google payload' });
    }

    const email = googleUser.email.toLowerCase();
    
    // Check if user already exists
    let user = await User.findOne({ email });

    if (!user) {
      // Create user with a random username and password
      const username = googleUser.name ? googleUser.name.replace(/\s+/g, '').toLowerCase() + crypto.randomBytes(2).toString('hex') : 'user_' + crypto.randomBytes(4).toString('hex');
      const randomPassword = crypto.randomBytes(16).toString('hex');
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(randomPassword, salt);

      user = new User({
        username,
        email,
        password: hashedPassword,
      });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    user.refreshTokens.push(refreshToken);
    await user.save();

    res.json({
      success: true,
      accessToken,
      refreshToken,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
      }
    });
  } catch (err) {
    console.error('[Google OAuth] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token is required' });
    }

    const refreshSecret = getRefreshSecret();
    let decoded;
    
    try {
      decoded = jwt.verify(refreshToken, refreshSecret);
    } catch (err) {
      return res.status(403).json({ error: 'Invalid or expired refresh token' });
    }

    const user = await User.findById(decoded.id);
    if (!user || !user.refreshTokens.includes(refreshToken)) {
      return res.status(403).json({ error: 'Refresh token revoked or invalid' });
    }

    const newAccessToken = generateAccessToken(user);

    res.json({
      success: true,
      accessToken: newAccessToken
    });
  } catch (err) {
    console.error('[Refresh] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      // Find the user with this refresh token and remove it
      await User.updateOne(
        { refreshTokens: refreshToken },
        { $pull: { refreshTokens: refreshToken } }
      );
    }

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    console.error('[Logout] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const { email } = parsed.data;

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      // Return 200/success even if user not found to prevent user enumeration attacks
      return res.json({
        success: true,
        message: 'If that email exists, a reset link has been generated.'
      });
    }

    // Generate random 40-character hex token
    const resetToken = crypto.randomBytes(20).toString('hex');
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 604800000; // 7 days expiry
    await user.save();

    // Create reset URL
    const config = readDataFile();
    const frontendUrl = config.FRONTEND_URL || 'http://localhost:5174';
    const resetUrl = `${frontendUrl}?page=reset-password&token=${resetToken}`;

    // Standard local terminal output is CRITICAL so the developer can run resets easily
    console.log('\n' + '*'.repeat(80));
    console.log(`[PASSWORD RESET REQUEST] User: ${user.username} (${user.email})`);
    console.log(`Reset URL: ${resetUrl}`);
    console.log('*'.repeat(80) + '\n');

    // Attempt to send email via NodeMailer using real Gmail SMTP
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });

      const mailOptions = {
        from: '"2D-to-3D Converter" <noreply@2dto3d.local>',
        to: user.email,
        subject: 'Password Reset Request - 2D-to-3D AI Converter',
        text: `Hello ${user.username},\n\nYou requested a password reset. Please click on the link below or copy and paste it into your browser to reset your password (valid for 7 days):\n\n${resetUrl}\n\nIf you did not request this, please ignore this email.\n`,
        html: `<p>Hello ${user.username},</p>
               <p>You requested a password reset. Please click the button below to reset your password (valid for 7 days):</p>
               <p><a href="${resetUrl}" style="background-color:#6378ff;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;">Reset Password</a></p>
               <p>Or paste this link into your browser:</p>
               <p><a href="${resetUrl}">${resetUrl}</a></p>
               <p>If you did not request this, please ignore this email.</p>`
      };

      const info = await transporter.sendMail(mailOptions);
      console.log('[Nodemailer] Email sent successfully to:', user.email);

      return res.json({
        success: true,
        message: 'Password reset link sent successfully.'
      });
    } catch (mailErr) {
      console.warn('[Nodemailer] Failed to send email via SMTP, falling back to console log only:', mailErr.message);
      return res.json({
        success: true,
        message: 'Password reset link generated. Check backend terminal console.',
        resetLink: resetUrl // Fallback so developers/users can use it locally
      });
    }
  } catch (err) {
    console.error('[Forgot Password] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/reset-password/:token
router.post('/reset-password/:token', authLimiter, async (req, res) => {
  try {
    const { token } = req.params;
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const { password } = parsed.data;

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({ error: 'Password reset token is invalid or has expired' });
    }

    // Update password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    user.password = hashedPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    
    // Revoke all existing refresh tokens on password change for security
    user.refreshTokens = [];
    
    await user.save();

    res.json({ success: true, message: 'Password has been reset successfully. Please log in.' });
  } catch (err) {
    console.error('[Reset Password] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    // Check Cache
    const cacheKey = `user_profile_${req.user.id}`;
    const cachedUser = authCache.get(cacheKey);
    if (cachedUser) {
      return res.json({ success: true, user: cachedUser, cached: true });
    }

    const user = await User.findById(req.user.id).select('-password -refreshTokens');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Set Cache
    authCache.set(cacheKey, user);
    
    res.json({ success: true, user, cached: false });
  } catch (err) {
    console.error('[Get Profile] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
