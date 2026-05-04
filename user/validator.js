// User validation module - extracted from utils.js

function validateEmail(email) {
  return typeof email === "string" && email.includes("@") && email.includes(".");
}

function validateUsername(username) {
  if (!username || typeof username !== "string") return false;
  if (username.length < 3 || username.length > 50) return false;
  return /^[a-zA-Z0-9_-]+$/.test(username);
}

function sanitize(str) {
  return String(str).replace(/[<>"'&]/g, "");
}

function processUser(user) {
  if (!user || !user.email) return null;
  return {
    email: sanitize(user.email),
    name: user.name ? sanitize(user.name) : "anonymous",
  };
}

module.exports = { validateEmail, validateUsername, sanitize, processUser };
