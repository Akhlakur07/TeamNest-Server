const mongoose = require('mongoose');
const { TRANSACTION_STATUS, TRANSACTION_TYPE } = require('./enums');

const transactionSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
    type: { type: String, required: true, enum: Object.values(TRANSACTION_TYPE) },
    status: {
      type: String,
      required: true,
      enum: Object.values(TRANSACTION_STATUS),
      default: TRANSACTION_STATUS.PENDING,
    },
    amountCents: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'usd' },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
      default: null,
    },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', default: null },
    stripeEventId: { type: String, unique: true, sparse: true },
    gateway: { type: String, default: 'stripe' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    errorMessage: { type: String, default: null },
  },
  { timestamps: true }
);

transactionSchema.index({ orgId: 1, status: 1, createdAt: -1 });
transactionSchema.index({ type: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);