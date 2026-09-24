const mongoose = require('mongoose');
const { INVITATION_STATUS, ROLES } = require('./enums');

const invitationSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    token: { type: String, required: true, unique: true },
    role: {
      type: String,
      required: true,
      enum: [ROLES.ORG_ADMIN, ROLES.ORG_MEMBER],
      default: ROLES.ORG_MEMBER,
    },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: {
      type: String,
      enum: Object.values(INVITATION_STATUS),
      default: INVITATION_STATUS.PENDING,
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

invitationSchema.index(
  { orgId: 1, email: 1 },
  {
    unique: true,
    partialFilterExpression: { status: INVITATION_STATUS.PENDING },
  }
);

module.exports = mongoose.model('Invitation', invitationSchema);