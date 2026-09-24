const mongoose = require('mongoose');
const { BILLING_INTERVAL } = require('./enums');

const planSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    description: { type: String, default: '' },
    priceCents: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'usd' },
    billingInterval: {
      type: String,
      required: true,
      enum: Object.values(BILLING_INTERVAL),
    },
    features: { type: [String], default: [] },
    isEnabled: { type: Boolean, default: true },
    stripeProductId: { type: String, sparse: true },
    stripePriceId: { type: String, sparse: true },
  },
  { timestamps: true }
);

planSchema.index({ isEnabled: 1, billingInterval: 1 });
planSchema.index({ priceCents: 1 });

module.exports = mongoose.model('Plan', planSchema);