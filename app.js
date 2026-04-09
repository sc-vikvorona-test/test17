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
    throw new Error('Division by zero');
  }
  return a / b;
}

function power(base, exponent) {
  if (typeof exponent !== 'number') {
    throw new TypeError('Exponent must be a number');
  }
  return Math.pow(base, exponent);
}

module.exports = { add, subtract, multiply, divide, power };
