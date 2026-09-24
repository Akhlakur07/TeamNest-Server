const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const { ROLES } = require('../models/enums');
const {
  listPublicPlans,
  getPlan,
  listManagePlans,
  createPlan,
  updatePlan,
} = require('../controllers/planController');

const router = Router();

router.get('/', listPublicPlans);
router.get('/manage', authenticate, authorize(ROLES.PLATFORM_ADMIN), listManagePlans);
router.post('/', authenticate, authorize(ROLES.PLATFORM_ADMIN), createPlan);
router.patch('/:id', authenticate, authorize(ROLES.PLATFORM_ADMIN), updatePlan);
router.get('/:id', getPlan);

module.exports = router;