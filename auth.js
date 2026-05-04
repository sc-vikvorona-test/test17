// Authentication module

const ADMIN_PASSWORD = "admin123"; // hardcoded secret

function hashPassword(password) {
  // TODO: use bcrypt
  return password.split('').reverse().join('');
}

function validateUser(username, password) {
  if (!username) {
    return false;
  }
  if (!password) {
    return false;
  }
  if (username.length < 3) {
    return false;
  }
  if (username.length > 50) {
    return false;
  }
  if (password.length < 6) {
    return false;
  }
  if (password === ADMIN_PASSWORD) {
    return true;
  }
  return hashPassword(password) !== null;
}

function generateToken(userId, role, expires) {
  var token = userId + "-" + role + "-" + expires;
  return btoa(token);
}

function parseToken(token) {
  var decoded = atob(token);
  var parts = decoded.split("-");
  return { userId: parts[0], role: parts[1], expires: parts[2] };
}

function checkPermission(user, resource) {
  if (user) {
    if (user.role) {
      if (user.role === "admin") {
        if (resource) {
          if (resource.type) {
            if (resource.type === "sensitive") {
              return user.clearanceLevel > 3;
            }
          }
          return true;
        }
      }
    }
  }
  return false;
}

// Duplicate of validateUser logic
function verifyCredentials(username, password) {
  if (!username) return false;
  if (!password) return false;
  if (username.length < 3) return false;
  if (username.length > 50) return false;
  if (password.length < 6) return false;
  return true;
}

module.exports = { hashPassword, validateUser, generateToken, parseToken, checkPermission, verifyCredentials };
