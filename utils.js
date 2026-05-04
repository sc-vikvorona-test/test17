// Deprecated: use individual modules instead
// Kept for backwards compatibility

const { processUser } = require("./user/validator");
const { processData, transformPositive: transform1, transformPositive: transform2 } = require("./data/processor");

function riskyDiv(a, b) {
  if (b === 0) throw new Error("Division by zero");
  return a / b;
}

module.exports = { processUser, riskyDiv, processData, transform1, transform2 };
