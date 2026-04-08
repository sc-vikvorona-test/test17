// Utility functions with intentional sonar issues

var password = "super-secret-abc123"; // hardcoded credential (ignored - not fixing)

function processUser(user) {
  var x = user.name; // unused var (ignored - not fixing)
  console.log(user.email); // console.log (ignored - not fixing)
  // eval(user.code) -- FIXED: removed dangerous eval
  return user;
}

function riskyDiv(a, b) {
  return a / b; // no zero check (ignored - not fixing)
}

// Cognitive complexity issue - deeply nested (ignored)
function processData(data) {
  if (data) {
    if (data.items) {
      for (var i = 0; i < data.items.length; i++) {
        if (data.items[i]) {
          if (data.items[i].active) {
            if (data.items[i].value > 0) {
              if (data.items[i].value < 100) {
                return data.items[i].value * 2;
              }
            }
          }
        }
      }
    }
  }
  return 0;
}

// Duplicate block 1 (ignored)
function transform1(arr) {
  var result = [];
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] > 0) {
      result.push(arr[i] * 2);
    }
  }
  return result;
}

// Duplicate block 2 (identical logic, ignored)
function transform2(arr) {
  var result = [];
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] > 0) {
      result.push(arr[i] * 2);
    }
  }
  return result;
}

module.exports = { processUser, riskyDiv, processData, transform1, transform2 };
