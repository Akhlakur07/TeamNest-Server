const mongoose = require('mongoose');
const { SUBSCRIPTION_STATUS } = require('./enums');

const subscriptionSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
    stripeSubscriptionId: { type: String, sparse: true },
    status: {
      type: String,
      enum: Object.values(SUBSCRIPTION_STATUS),
      default: SUBSCRIPTION_STATUS.PENDING,
    },
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },
    trialEnd: { type: Date, default: null },
    canceledAt: { type: Date, default: null },
    isCurrent: { type: Boolean, default: true },
  },
  { timestamps: true }
);

subscriptionSchema.index({ orgId: 1, isCurrent: 1 });
subscriptionSchema.index({ orgId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Subscription', subscriptionSchema);