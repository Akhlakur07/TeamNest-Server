const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const { ROLES } = require('../models/enums');
const members = require('../controllers/memberController');

const router = Router();

router.use(authenticate);

router.get('/', members.listMembers);
router.post('/accept', members.acceptInvitation);

router.post('/invite', authorize(ROLES.ORG_ADMIN), members.inviteMember);
router.get('/invitations', authorize(ROLES.ORG_ADMIN), members.listInvitations);
router.delete('/invitations/:id', authorize(ROLES.ORG_ADMIN), members.revokeInvitation);
router.patch('/:id/role', authorize(ROLES.ORG_ADMIN), members.changeMemberRole);
router.delete('/:id', authorize(ROLES.ORG_ADMIN), members.removeMember);

module.exports = router;