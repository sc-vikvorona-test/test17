function add(a, b) { return a + b; }
function subtract(a, b) { return a - b; }
function multiply(a, b) { return a * b; }
function divide(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('Expected numbers');
  if (b === 0) throw new Error('Division by zero');
  return a / b;
}
module.exports = { add, subtract, multiply, divide };
// variant 3
