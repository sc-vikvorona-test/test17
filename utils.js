function formatUser(user) {
  return user.name.toUpperCase() + ' <' + user.email + '>';
}

function processUsers(users) {
  return users.map(u => formatUser(u));
}

module.exports = { formatUser, processUsers };
