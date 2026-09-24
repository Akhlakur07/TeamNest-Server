const { User } = require('../models');

async function getAppUserByFirebase(decoded) {
  const { uid, email } = decoded;
  let user = await User.findOne({ firebaseUid: uid });
  if (user) return user;
  if (email) return User.findOne({ email });
  return null;
}

module.exports = { getAppUserByFirebase };