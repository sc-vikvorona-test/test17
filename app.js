function requireNonZero(b) {
  if (b === 0) {
    throw new Error('Division by zero');
  }
}

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
  requireNonZero(b);
  return a / b;
}

function modulo(a, b) {
  requireNonZero(b);
  return a % b;
}

module.exports = { add, subtract, multiply, divide, modulo };
