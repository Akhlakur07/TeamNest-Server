const { z } = require('zod');
const admin = require('../config/firebaseAdmin');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { userProfile } = require('../utils/serializers');
const { Organization, User } = require('../models');
const { getAppUserByFirebase } = require('../services/authService');
const { ORG_STATUS, USER_STATUS } = require('../models/enums');

const loginSchema = z.object({
  token: z.string().min(10),
});

const resetSchema = z.object({
  email: z.email(),
});

async function orgSummary(orgId) {
  if (!orgId) return null;
  const org = await Organization.findById(orgId).select('name status planId');
  return org
    ? {
        id: org._id.toString(),
        name: org.name,
        status: org.status,
        planId: org.planId ? org.planId.toString() : null,
      }
    : null;
}

async function assertAccountAccessible(user) {
  if (user.status === USER_STATUS.SUSPENDED) {
    throw new ApiError(403, 'This account has been suspended');
  }

  if (user.orgId) {
    const org = await Organization.findById(user.orgId);
    if (org && org.status === ORG_STATUS.SUSPENDED) {
      throw new ApiError(403, 'Your organization has been suspended');
    }
    if (org && org.status === ORG_STATUS.CANCELLED) {
      throw new ApiError(403, 'Your organization has been cancelled');
    }
  }
}

exports.login = async (req, res) => {
  const { token } = loginSchema.parse(req.body);

  if (!admin) {
    throw new ApiError(500, 'Authentication service is not configured');
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch (error) {
    throw new ApiError(401, 'Session expired or invalid token');
  }

  const user = await getAppUserByFirebase(decoded);
  if (!user) {
    throw new ApiError(
      403,
      'No TeamNest account found for this login. Complete registration or accept your invitation first.'
    );
  }

  await assertAccountAccessible(user);

  res.json({ success: true, user: userProfile(user), org: await orgSummary(user.orgId) });
};

exports.me = async (req, res) => {
  await assertAccountAccessible(req.dbUser);
  res.json({
    success: true,
    user: userProfile(req.dbUser),
    org: await orgSummary(req.dbUser.orgId),
  });
};

exports.resetPassword = async (req, res) => {
  const { email } = resetSchema.parse(req.body);

  if (!admin) {
    throw new ApiError(500, 'Authentication service is not configured');
  }

  const resetLink = await admin.auth().generatePasswordResetLink(email);

  res.json({
    success: true,
    message:
      'If that email belongs to a registered account, a password reset link has been sent.',
    ...(env.NODE_ENV === 'development' ? { resetLink } : {}),
  });
};