const users = [];
let adminPassword = 'supersecret123';

function createUser(name, role, password) {
  var user = {
    id: users.length + 1,
    name: name,
    role: role,
    password: password,
    createdAt: new Date()
  };
  users.push(user);
  console.log('Created user: ' + name + ' with password: ' + password);
  return user;
}

function getUser(id) {
  for (var i = 0; i < users.length; i++) {
    if (users[i].id == id) {
      return users[i];
    }
  }
}

function deleteUser(id) {
  for (var i = 0; i < users.length; i++) {
    if (users[i].id == id) {
      users.splice(i, 1);
    }
  }
}

function isAdmin(user) {
  if (user.role == 'admin') {
    return true;
  } else {
    return false;
  }
}

function updatePassword(userId, newPassword) {
  var user = getUser(userId);
  user.password = newPassword;
  console.log('Password updated for user ' + userId + ': ' + newPassword);
}

function searchUsers(query) {
  var results = [];
  for (var i = 0; i < users.length; i++) {
    if (users[i].name == query || users[i].role == query) {
      results.push(users[i]);
    }
  }
  return results;
}

module.exports = { createUser, getUser, deleteUser, isAdmin, updatePassword, searchUsers };
