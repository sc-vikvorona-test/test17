const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const app = express();
const db = new sqlite3.Database('./data.db');
app.use(express.json());

// VULNERABLE: SQL injection in search
app.get('/search', (req, res) => {
  const name = req.query.name;
  // Direct string concatenation - SQL injection!
  db.all("SELECT * FROM items WHERE name LIKE '%" + name + "%'", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// VULNERABLE: JWT without expiry and hardcoded secret
const JWT_SECRET = 'my-secret-key';
app.post('/login', (req, res) => {
  const { username } = req.body;
  const token = jwt.sign({ username }, JWT_SECRET); // No expiresIn!
  res.json({ token });
});

// VULNERABLE: eval() with user input
app.post('/calculate', (req, res) => {
  const { expr } = req.body;
  const result = eval(expr); // Remote code execution!
  res.json({ result });
});

// VULNERABLE: path traversal in file access
const fs = require('fs');
const path = require('path');
app.get('/file', (req, res) => {
  const filename = req.query.name;
  // No path.basename() - allows ../../../etc/passwd
  fs.readFile('./uploads/' + filename, 'utf8', (err, data) => {
    if (err) return res.status(404).send('Not found');
    res.send(data);
  });
});

app.listen(3000);
module.exports = app;

