const { constructEvent } = require('../services/stripeService');
const subscriptionService = require('../services/subscriptionService');

const HANDLERS = {
  'checkout.session.completed': subscriptionService.handleCheckoutCompleted,
  'invoice.paid': subscriptionService.handleInvoicePaid,
  'invoice.payment_failed': subscriptionService.handleInvoicePaymentFailed,
  'customer.subscription.updated': subscriptionService.handleSubscriptionUpdated,
  'customer.subscription.deleted': subscriptionService.handleSubscriptionDeleted,
  'charge.refunded': subscriptionService.handleChargeRefunded,
};

exports.stripeWebhook = async (req, res) => {
  let event;
  try {
    event = constructEvent(req.rawBody, req.headers['stripe-signature']);
  } catch (error) {
    console.error('[webhook] Signature verification failed:', error.message);
    return res.status(400).json({ error: `Webhook signature error: ${error.message}` });
  }

  const handler = HANDLERS[event.type];
  if (!handler) {
    // Stripe expects a 2xx for events we choose not to handle.
    return res.json({ received: true, ignored: true, type: event.type });
  }

  try {
    const outcome = await handler(event);
    res.json({ received: true, ...outcome });
  } catch (error) {
    // Non-2xx tells Stripe to retry this delivery later.
    console.error(`[webhook] Handler failed for ${event.type}:`, error.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
};