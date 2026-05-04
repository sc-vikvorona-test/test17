const { hashPassword, validateUser, generateToken } = require('./auth');

function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}

function multiply(a, b) {
  return a * b;
}

function divide(a, b) {
  if (b === 0) {
    throw new Error("Division by zero");
  }
  return a / b;
}

function createSession(username, password) {
  if (!validateUser(username, password)) {
    return null;
  }
  return generateToken(username, "user", Date.now() + 3600000);
}

module.exports = { add, subtract, multiply, divide, createSession };
