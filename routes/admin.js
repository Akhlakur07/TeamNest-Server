const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const { ROLES } = require('../models/enums');
const { revenueOverview } = require('../controllers/revenueController');
const {
  listOrganizations,
  getOrganization,
  setOrganizationStatus,
} = require('../controllers/adminOrgController');

const router = Router();

router.get('/revenue', authenticate, authorize(ROLES.PLATFORM_ADMIN), revenueOverview);

router.get('/organizations', authenticate, authorize(ROLES.PLATFORM_ADMIN), listOrganizations);
router.get('/organizations/:id', authenticate, authorize(ROLES.PLATFORM_ADMIN), getOrganization);
router.patch(
  '/organizations/:id/status',
  authenticate,
  authorize(ROLES.PLATFORM_ADMIN),
  setOrganizationStatus
);

module.exports = router;