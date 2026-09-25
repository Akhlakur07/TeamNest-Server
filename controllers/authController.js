const { z } = require('zod');
const admin = require('../config/firebaseAdmin');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { userProfile } = require('../utils/serializers');
const { Organization, User, Invitation } = require('../models');
const { getAppUserByFirebase } = require('../services/authService');
const { acceptInviteByToken } = require('../services/memberService');
const { ORG_STATUS, USER_STATUS, INVITATION_STATUS } = require('../models/enums');

const loginSchema = z.object({
  token: z.string().min(10),
});

const resetSchema = z.object({
  email: z.email(),
});

const joinSchema = z.object({
  token: z.string().min(10),
  name: z.string().trim().min(2, 'Name is required').max(80),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

async function orgSummary(orgId) {
  if (!orgId) return null;
  const org = await Organization.findById(orgId).select(
    'name status planId contactName contactEmail phone billingEmail'
  );
  return org
    ? {
        id: org._id.toString(),
        name: org.name,
        status: org.status,
        planId: org.planId ? org.planId.toString() : null,
        contactName: org.contactName,
        contactEmail: org.contactEmail,
        phone: org.phone,
        billingEmail: org.billingEmail,
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

// Join via invitation token for a brand-new account (no paid onboarding).
exports.join = async (req, res) => {
  const { token, name, password } = joinSchema.parse(req.body);

  if (!admin) {
    throw new ApiError(500, 'Authentication service is not configured');
  }

  const invite = await Invitation.findOne({ token });
  if (!invite) throw new ApiError(404, 'Invitation not found');
  if (invite.status === INVITATION_STATUS.ACCEPTED) {
    throw new ApiError(400, 'Invitation has already been accepted');
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    invite.status = INVITATION_STATUS.EXPIRED;
    await invite.save();
    throw new ApiError(410, 'Invitation has expired');
  }
  if (await User.exists({ email: invite.email })) {
    throw new ApiError(
      409,
      'An account with this email already exists. Log in and accept the invitation instead.'
    );
  }

  let firebaseUser;
  try {
    firebaseUser = await admin.auth().createUser({
      email: invite.email,
      password,
      displayName: name,
    });
  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      throw new ApiError(
        409,
        'An account with this email already exists. Log in and accept the invitation instead.'
      );
    }
    throw error;
  }

  try {
    const result = await acceptInviteByToken(token, {
      email: invite.email,
      name,
      firebaseUid: firebaseUser.uid,
    });
    if (result.alreadyAccepted) {
      throw new ApiError(409, 'Invitation has already been accepted');
    }
    res.status(201).json({
      success: true,
      user: userProfile(result.user),
      org: {
        id: result.org._id.toString(),
        name: result.org.name,
        status: result.org.status,
        role: result.user.role,
      },
    });
  } catch (error) {
    await admin.auth().deleteUser(firebaseUser.uid).catch(() => null);
    throw error;
  }
};