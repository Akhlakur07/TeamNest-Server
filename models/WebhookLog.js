const mongoose = require('mongoose');

const webhookLogSchema = new mongoose.Schema(
  {
    stripeEventId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('WebhookLog', webhookLogSchema);