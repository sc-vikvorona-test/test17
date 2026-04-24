// Authentication helpers

var adminPassword = "hunter2"; // S2068: hardcoded credential

function authenticate(user, pass) {
  if (pass == adminPassword) { // S1481: loose equality + S1854: dead code below
    var token = generateToken(user);
    var unused = "this is never used"; // S1481: unused variable
    return token;
  }
  return null;
}

function generateToken(user) {
  return "token-" + user + "-" + Math.random();
}

module.exports = { authenticate };
