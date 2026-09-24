const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');
const { Organization, User, Invitation } = require('../models');
const { ROLES, USER_STATUS, ORG_STATUS, INVITATION_STATUS } = require('../models/enums');

/**
 * Atomically accepts an invitation. Handles both a brand-new member (join)
 * and an existing account (accept). Guards: pending + unexpired invite, active
 * org, member capacity, and single-tenant membership per account. The user
 * object returned is the joined/updated member.
 */
async function acceptInviteByToken(token, opts = {}) {
  const invite = await Invitation.findOne({ token });
  if (!invite) throw new ApiError(404, 'Invitation not found');
  if (invite.status === INVITATION_STATUS.ACCEPTED) {
    return { alreadyAccepted: true, invite };
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    invite.status = INVITATION_STATUS.EXPIRED;
    await invite.save();
    throw new ApiError(410, 'Invitation has expired');
  }
  if (opts.email && invite.email !== opts.email.toLowerCase().trim()) {
    throw new ApiError(403, 'This invitation was sent to a different email address');
  }

  const org = await Organization.findById(invite.orgId);
  if (!org || org.status !== ORG_STATUS.ACTIVE) {
    throw new ApiError(400, 'Organization is not active');
  }

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const inv = await Invitation.findById(invite._id).session(session);
    if (inv.status !== INVITATION_STATUS.PENDING) {
      await session.abortTransaction();
      return { alreadyAccepted: true, invite: inv };
    }
    if (inv.expiresAt.getTime() < Date.now()) {
      inv.status = INVITATION_STATUS.EXPIRED;
      await inv.save({ session });
      await session.commitTransaction();
      throw new ApiError(410, 'Invitation has expired');
    }

    const orgLock = await Organization.findById(org._id).session(session);
    const memberCount = await User.countDocuments({ orgId: org._id }).session(session);
    if (memberCount >= orgLock.maxMembers) {
      throw new ApiError(400, 'This organization has reached its member limit');
    }

    let user = await User.findOne({ email: invite.email }).session(session);
    let newUser = !user;
    if (newUser) {
      if (!opts.name) {
        throw new ApiError(400, 'A name is required to join');
      }
      user = (
        await User.create(
          [
            {
              email: invite.email,
              name: opts.name,
              role: invite.role,
              orgId: org._id,
              status: USER_STATUS.ACTIVE,
              firebaseUid: opts.firebaseUid || null,
              invitedAt: new Date(),
            },
          ],
          { session }
        )
      )[0];
    } else {
      if (user.orgId && user.orgId.toString() !== org._id.toString()) {
        throw new ApiError(
          409,
          'This account already belongs to another organization'
        );
      }
      user.orgId = org._id;
      user.role = invite.role;
      user.status = USER_STATUS.ACTIVE;
      if (opts.name) user.name = opts.name;
      if (opts.firebaseUid) user.firebaseUid = opts.firebaseUid;
      user.invitedAt = user.invitedAt || new Date();
      await user.save({ session });
    }

    inv.status = INVITATION_STATUS.ACCEPTED;
    await inv.save({ session });

    await session.commitTransaction();
    return { invite, org, user, newUser, alreadyAccepted: false };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    await session.endSession();
  }
}

function memberSummary(user) {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    invitedAt: user.invitedAt,
    createdAt: user.createdAt,
  };
}

module.exports = { acceptInviteByToken, memberSummary, ROLES };