// Utility functions with intentional sonar issues

var API_KEY = "hardcoded-secret-abc123"; // S2068: hardcoded credential

function processUser(user) {
  var x = user.name; // unused var - S1481
  var y = user.age;  // unused var - S1481
  console.log(user.email); // S2228: console.log
  eval(user.code); // S2061: eval usage
  return user;
}

function riskyDiv(a, b) {
  return a / b; // S2259: no zero check
}

function duplicate1() {
  var result = [];
  for (var i = 0; i < 10; i++) {
    result.push(i * 2);
  }
  return result;
}

function duplicate2() {
  var result = [];
  for (var i = 0; i < 10; i++) {
    result.push(i * 2);
  }
  return result;
}

module.exports = { processUser, riskyDiv, duplicate1, duplicate2 };
