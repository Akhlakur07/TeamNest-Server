const { Router } = require('express');
const { stripeWebhook } = require('../controllers/webhookController');

const router = Router();

router.post('/stripe', stripeWebhook);

module.exports = router;