// Math operations module - extracted from app.js

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
  if (b === 0) throw new Error("Division by zero");
  return a / b;
}

function power(base, exp) {
  return Math.pow(base, exp);
}

function sqrt(n) {
  if (n < 0) throw new Error("Cannot sqrt negative");
  return Math.sqrt(n);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

module.exports = { add, subtract, multiply, divide, power, sqrt, clamp };
