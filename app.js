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

// compute the square of a number
function square(n) {
  return n * n;
}

module.exports = { add, subtract, multiply, divide, square };
