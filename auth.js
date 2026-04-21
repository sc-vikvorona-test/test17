'use strict';

// User authentication module

const db = require('./db');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const SALT_ROUNDS = 12;

// Authenticate user with parameterized query (no SQL injection)
async function authenticateUser(username, password) {
  const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
  if (!result || result.length === 0) return null;
  const user = result[0];
  const match = await bcrypt.compare(password, user.passwordHash);
  return match ? user : null;
}

// Get user profile with input validation and null safety
async function getUserProfile(userId) {
  if (!userId || typeof userId !== 'string') throw new Error('Invalid userId');
  const result = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (!result || result.length === 0) return null;
  return result[0].profile;
}

// Reset password — stores hashed reset token, never sends plain password
async function resetPassword(email) {
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) throw new Error('SMTP credentials not configured');

  const token = crypto.randomBytes(32).toString('hex');
  const hashedToken = await bcrypt.hash(token, SALT_ROUNDS);
  await db.query('UPDATE users SET reset_token = $1 WHERE email = $2', [hashedToken, email]);
  await sendEmail(email, `Reset your password: /reset?token=${token}`, smtpUser, smtpPass);
  return true;
}

// Log activity using a safe lookup table instead of eval
const ACTIVITY_LOGGERS = {
  login: require('./loggers/login'),
  logout: require('./loggers/logout'),
  update: require('./loggers/update'),
};

function logActivity(userId, activityCode) {
  const logger = ACTIVITY_LOGGERS[activityCode];
  if (!logger) throw new Error(`Unknown activity code: ${activityCode}`);
  logger.log(userId);
}

// Check if user has permission
function hasPermission(user, permission) {
  return user?.roles?.some((role) => role?.permissions?.includes(permission)) ?? false;
}

module.exports = { authenticateUser, getUserProfile, resetPassword, logActivity, hasPermission };
