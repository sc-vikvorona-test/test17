const { add, subtract, multiply, divide } = require("./math/operations");
const { processData, transformPositive } = require("./data/processor");
const { processUser } = require("./user/validator");

module.exports = { add, subtract, multiply, divide, processData, transformPositive, processUser };
