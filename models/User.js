const mongoose = require('mongoose');
const { ROLES, USER_STATUS } = require('./enums');

const userSchema = new mongoose.Schema(
  {
    firebaseUid: { type: String, unique: true, sparse: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    role: { type: String, required: true, enum: Object.values(ROLES) },
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
    status: {
      type: String,
      enum: Object.values(USER_STATUS),
      default: USER_STATUS.ACTIVE,
    },
    invitedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.index({ orgId: 1, role: 1 });

module.exports = mongoose.model('User', userSchema);