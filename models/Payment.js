const mongoose = require('mongoose');
const { PAYMENT_STATUS } = require('./enums');

const paymentSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
      default: null,
    },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', default: null },
    amountCents: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'usd' },
    status: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.SUCCESS,
    },
    stripePaymentIntentId: { type: String, unique: true, sparse: true },
    stripeInvoiceId: { type: String, sparse: true },
    stripeChargeId: { type: String, default: null },
    invoiceNumber: { type: String, unique: true, sparse: true },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true }
);

paymentSchema.index({ orgId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Payment', paymentSchema);