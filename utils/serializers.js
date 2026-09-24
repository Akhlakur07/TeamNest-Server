function userProfile(user) {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    role: user.role,
    orgId: user.orgId ? user.orgId.toString() : null,
    status: user.status,
    createdAt: user.createdAt,
  };
}

module.exports = { userProfile };