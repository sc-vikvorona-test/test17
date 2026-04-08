// Utility functions with intentional sonar issues

var password = "super-secret-abc123"; // hardcoded credential

function processUser(user) {
  var x = user.name; // unused var
  console.log(user.email); // console.log
  eval(user.code); // dangerous eval
  return user;
}

function riskyDiv(a, b) {
  return a / b; // no zero check
}

// Cognitive complexity issue - deeply nested
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

// Duplicate block 1
function transform1(arr) {
  var result = [];
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] > 0) {
      result.push(arr[i] * 2);
    }
  }
  return result;
}

// Duplicate block 2 (identical logic)
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
