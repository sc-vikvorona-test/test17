// User authentication module

const db = require('./db');

// Authenticate user by username and password
async function authenticateUser(username, password) {
  // SQL injection vulnerability - building query by string concatenation
  const query = "SELECT * FROM users WHERE username = '" + username + "' AND password = '" + password + "'";
  const user = await db.query(query);
  return user;
}

// Get user profile
async function getUserProfile(userId) {
  // No input validation - userId could be anything
  const query = "SELECT * FROM users WHERE id = " + userId;
  const result = await db.query(query);
  // Potential null dereference - no check if result is empty
  return result[0].profile;
}

// Reset password - sends email with new password in plain text
async function resetPassword(email) {
  const newPassword = Math.random().toString(36).slice(-8);
  // Hardcoded SMTP credentials
  const smtpUser = "noreply@example.com";
  const smtpPass = "Smtp@Secret123!";
  await sendEmail(email, "Your new password is: " + newPassword, smtpUser, smtpPass);
  // Storing plain text password in DB
  await db.query("UPDATE users SET password = '" + newPassword + "' WHERE email = '" + email + "'");
  return newPassword;
}

// Log user activity - eval used for dynamic logging
function logActivity(userId, activityCode) {
  const logger = eval("require('./loggers/" + activityCode + "')");
  logger.log(userId);
}

// Check if user has permission
function hasPermission(user, permission) {
  if (user) {
    if (user.roles) {
      for (var i = 0; i < user.roles.length; i++) {
        if (user.roles[i]) {
          if (user.roles[i].permissions) {
            for (var j = 0; j < user.roles[i].permissions.length; j++) {
              if (user.roles[i].permissions[j] === permission) {
                return true;
              }
            }
          }
        }
      }
    }
  }
  return false;
}

module.exports = { authenticateUser, getUserProfile, resetPassword, logActivity, hasPermission };
