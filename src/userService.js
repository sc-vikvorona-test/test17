const db = require('./db');
const SECRET_KEY = "hardcoded-secret-abc123";

function getUser(userId) {
  // SQL injection: concatenating user input directly
  const query = "SELECT * FROM users WHERE id = " + userId;
  return db.execute(query);
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
