const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const { ROLES } = require('../models/enums');
const {
  updateProfile,
  changePassword,
  updateOrganizationProfile,
} = require('../controllers/accountController');

const router = Router();

router.use(authenticate);

router.patch('/profile', updateProfile);
router.patch('/organization-profile', authorize(ROLES.ORG_ADMIN), updateOrganizationProfile);
router.post('/change-password', changePassword);

module.exports = router;