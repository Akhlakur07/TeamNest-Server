const crypto = require('crypto');
const { z } = require('zod');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { Organization, User, Invitation } = require('../models');
const { ROLES, ORG_STATUS, INVITATION_STATUS } = require('../models/enums');
const { acceptInviteByToken, memberSummary } = require('../services/memberService');
const { userProfile } = require('../utils/serializers');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function requireOrg(user) {
  if (!user.orgId) throw new ApiError(400, 'No organization linked to this account');
  return user.orgId;
}

async function loadOrg(orgId) {
  const org = await Organization.findById(orgId);
  if (!org) throw new ApiError(404, 'Organization not found');
  return org;
}

async function inviteUrl(invite) {
  return `${env.FRONTEND_URL}/invite/accept?token=${invite.token}`;
}

exports.listMembers = async (req, res) => {
  const orgId = requireOrg(req.dbUser);
  const org = await loadOrg(orgId);

  const members = await User.find({ orgId }).sort({ role: 1, name: 1 });

  res.json({
    success: true,
    org: {
      id: org._id.toString(),
      name: org.name,
      status: org.status,
      maxMembers: org.maxMembers,
      memberCount: members.length,
    },
    members: members.map((m) => memberSummary(m)),
  });
};

const inviteSchema = z.object({
  email: z.email('Enter a valid email address'),
  role: z.enum([ROLES.ORG_ADMIN, ROLES.ORG_MEMBER]).default(ROLES.ORG_MEMBER),
});

exports.inviteMember = async (req, res) => {
  const { email, role } = inviteSchema.parse(req.body);
  const orgId = requireOrg(req.dbUser);
  const org = await loadOrg(orgId);

  if (org.status !== ORG_STATUS.ACTIVE) {
    throw new ApiError(400, 'Invitations require an active organization');
  }
  const normalized = email.toLowerCase().trim();

  const existingMember = await User.findOne({ email: normalized, orgId });
  if (existingMember) throw new ApiError(400, 'This email is already a member of the organization');

  const existingPending = await Invitation.findOne({ orgId, email: normalized, status: INVITATION_STATUS.PENDING });
  if (existingPending) {
    throw new ApiError(409, 'A pending invitation already exists for this email');
  }

  const invite = await Invitation.create({
    orgId,
    email: normalized,
    token: crypto.randomBytes(32).toString('hex'),
    role,
    invitedBy: req.dbUser._id,
    status: INVITATION_STATUS.PENDING,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
  });

  res.status(201).json({
    success: true,
    message: `Invitation sent to ${normalized}.`,
    invite: {
      id: invite._id.toString(),
      email: invite.email,
      role: invite.role,
      status: invite.status,
      expiresAt: invite.expiresAt,
      url: await inviteUrl(invite),
    },
  });
};

exports.listInvitations = async (req, res) => {
  const orgId = requireOrg(req.dbUser);

  const invitations = await Invitation.find({ orgId, status: INVITATION_STATUS.PENDING }).sort(
    '-createdAt'
  );

  res.json({
    success: true,
    invitations: invitations.map((invite) => ({
      id: invite._id.toString(),
      email: invite.email,
      role: invite.role,
      status: invite.status,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
    })),
  });
};

exports.revokeInvitation = async (req, res) => {
  const orgId = requireOrg(req.dbUser);
  const { id } = req.params;

  const invite = await Invitation.findOneAndDelete({ _id: id, orgId });
  if (!invite) throw new ApiError(404, 'Invitation not found');

  res.json({ success: true, message: 'Invitation revoked.' });
};

const acceptSchema = z.object({ token: z.string().min(10) });

exports.acceptInvitation = async (req, res) => {
  const { token } = acceptSchema.parse(req.body);
  const currentUser = req.dbUser;

  const result = await acceptInviteByToken(token, { email: currentUser.email, name: currentUser.name });
  if (result.alreadyAccepted) {
    return res.json({
      success: true,
      alreadyAccepted: true,
      message: 'Invitation already accepted. Welcome aboard!',
    });
  }

  await currentUser.reload();
  res.json({
    success: true,
    message: 'Invitation accepted.',
    user: userProfile(result.user),
    org: {
      id: result.org._id.toString(),
      name: result.org.name,
      status: result.org.status,
      role: result.user.role,
    },
  });
};

const changeRoleSchema = z.object({
  role: z.enum([ROLES.ORG_ADMIN, ROLES.ORG_MEMBER]),
});

exports.changeMemberRole = async (req, res) => {
  const { role } = changeRoleSchema.parse(req.body);
  const orgId = requireOrg(req.dbUser);
  const { id } = req.params;

  const target = await User.findOne({ _id: id, orgId });
  if (!target) throw new ApiError(404, 'Member not found');
  if (target._id.toString() === req.dbUser._id.toString()) {
    throw new ApiError(400, 'You cannot change your own role');
  }
  if (target.role === ROLES.ORG_ADMIN && role !== ROLES.ORG_ADMIN) {
    const adminCount = await User.countDocuments({ orgId, role: ROLES.ORG_ADMIN });
    if (adminCount <= 1) throw new ApiError(400, 'Cannot demote the last organization admin');
  }

  target.role = role;
  await target.save();

  res.json({ success: true, member: memberSummary(target) });
};

exports.removeMember = async (req, res) => {
  const orgId = requireOrg(req.dbUser);
  const { id } = req.params;
  const self = req.dbUser;

  const target = await User.findOne({ _id: id, orgId });
  if (!target) throw new ApiError(404, 'Member not found');
  if (target._id.toString() === self._id.toString()) {
    throw new ApiError(400, 'You cannot remove yourself');
  }
  if (target.role === ROLES.ORG_ADMIN) {
    const adminCount = await User.countDocuments({ orgId, role: ROLES.ORG_ADMIN });
    if (adminCount <= 1) throw new ApiError(400, 'Cannot remove the last organization admin');
  }

  await User.deleteOne({ _id: target._id, orgId });
  await Invitation.deleteMany({ orgId, email: target.email, status: INVITATION_STATUS.PENDING });

  res.json({ success: true, message: 'Member removed.' });
};