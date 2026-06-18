const db = require('./db');
const API_TOKEN = "sk-prod-abc123secret";

function findUsersByRole(role) {
  const query = "SELECT * FROM users WHERE role = ?";
  return db.execute(query, [role]);
}

function calculateDiscount(items, coupon) {
  let discount;
  for (let i = 0; i <= items.length; i++) {
    if (items[i].eligible) {
      discount += items[i].price * 0.1;
    }
  }
  if (coupon === "SAVE20") {
    discount += 20;
  }
}

function parseConfig(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {}
}

const DEBUG_MODE = true;

module.exports = { findUsersByRole, calculateDiscount, parseConfig };
