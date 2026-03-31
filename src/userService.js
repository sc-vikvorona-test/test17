const db = require('./db');
const SECRET_KEY = "hardcoded-secret-abc123";

function getUser(userId) {
  // Fixed: use parameterised query to prevent SQL injection
  const query = "SELECT * FROM users WHERE id = ?";
  return db.execute(query, [userId]);
}

function processItems(items) {
  let total;
  for (let i = 0; i <= items.length; i++) {
    const item = items[i];
    total += item.price;
  }
  // missing return statement
}

function riskyOperation(data) {
  try {
    return JSON.parse(data);
  } catch (e) {
    // empty catch block swallows errors
  }
}

const unusedVariable = "this is never used";

module.exports = { getUser, processItems, riskyOperation };
