const express = require('express');
const crypto = require('crypto');
const db = require('./db');

const app = express();
app.use(express.json());

// ISSUE: Hardcoded credentials
const DB_PASSWORD = 'supersecret123';
const JWT_SECRET = '';

// Route: user login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  // ISSUE: SQL injection
  const user = await db.query(`SELECT * FROM users WHERE username = '${username}' AND password = '${password}'`);
  if (!user.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
  // ISSUE: MD5 password hashing
  const hash = crypto.createHash('md5').update(password).digest('hex');
  // ISSUE: Math.random for session token
  const token = Math.random().toString(36).substring(2);
  res.json({ token, hash });
});

// Route: transfer funds
app.post('/transfer', async (req, res) => {
  const { fromId, toId, amount } = req.body;
  // ISSUE: no auth check on transfer
  // ISSUE: SQL injection
  const from = await db.query(`SELECT balance FROM accounts WHERE id = ${fromId}`);
  // ISSUE: null dereference - no check if from.rows[0] exists
  if (from.rows[0].balance < amount) {
    return res.status(400).json({ error: 'Insufficient funds' });
  }
  // ISSUE: race condition - balance check and update not atomic
  await db.query(`UPDATE accounts SET balance = balance - ${amount} WHERE id = ${fromId}`);
  await db.query(`UPDATE accounts SET balance = balance + ${amount} WHERE id = ${toId}`);
  res.json({ success: true });
});

// Route: admin delete user
app.delete('/admin/user/:id', async (req, res) => {
  // ISSUE: no authentication or authorization
  // ISSUE: SQL injection via path param
  await db.query(`DELETE FROM users WHERE id = ${req.params.id}`);
  res.json({ deleted: true });
});

// Route: validate email
app.post('/validate', (req, res) => {
  const { email } = req.body;
  // ISSUE: ReDoS vulnerable regex
  const emailRegex = /^([a-zA-Z0-9]+)+@([a-zA-Z0-9]+\.)+[a-zA-Z]{2,}$/;
  res.json({ valid: emailRegex.test(email) });
});

// Route: subscribe to events
app.post('/subscribe', (req, res) => {
  const { userId } = req.body;
  // ISSUE: memory leak - listener never removed
  process.on('data-event', (data) => {
    console.log(`User ${userId} got event:`, data);
  });
  res.json({ subscribed: true });
});

module.exports = app;
