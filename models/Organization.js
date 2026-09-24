const mongoose = require('mongoose');
const { ORG_STATUS } = require('./enums');

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    contactName: { type: String, trim: true, default: '' },
    contactEmail: { type: String, required: true, lowercase: true, trim: true },
    billingEmail: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true, default: '' },
    status: {
      type: String,
      enum: Object.values(ORG_STATUS),
      default: ORG_STATUS.PENDING,
    },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', default: null },
    stripeCustomerId: { type: String, sparse: true },
    stripeSubscriptionId: { type: String, sparse: true },
    checkoutSessionId: { type: String, sparse: true },
    signupDate: { type: Date, default: Date.now },
    activatedAt: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
    maxMembers: { type: Number, default: 50, min: 1 },
  },
  { timestamps: true }
);

organizationSchema.index({ status: 1, signupDate: -1 });

module.exports = mongoose.model('Organization', organizationSchema);