const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const { ROLES } = require('../models/enums');
const billing = require('../controllers/billingController');

const router = Router();

router.use(authenticate);

router.get('/current', billing.currentSubscription);

router.post('/portal', authorize(ROLES.ORG_ADMIN), billing.billingPortal);
router.post('/change-plan', authorize(ROLES.ORG_ADMIN), billing.changePlan);
router.post('/cancel', authorize(ROLES.ORG_ADMIN), billing.cancelAtPeriodEnd);
router.post('/reactivate', authorize(ROLES.ORG_ADMIN), billing.reactivateSubscription);

module.exports = router;