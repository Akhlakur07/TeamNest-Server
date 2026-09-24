const admin = require('../config/firebaseAdmin');
const ApiError = require('../utils/ApiError');
const { getAppUserByFirebase } = require('../services/authService');
const { Organization } = require('../models');
const { USER_STATUS, ORG_STATUS } = require('../models/enums');

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      throw new ApiError(401, 'Authentication required');
    }

    if (!admin) {
      throw new ApiError(500, 'Authentication service is not configured');
    }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(token);
    } catch (error) {
      throw new ApiError(401, 'Session expired or invalid token');
    }

    const user = await getAppUserByFirebase(decoded);
    if (!user) {
      throw new ApiError(403, 'No TeamNest account found for this login');
    }

    if (user.status === USER_STATUS.SUSPENDED) {
      throw new ApiError(403, 'This account has been suspended');
    }

    if (user.orgId) {
      const org = await Organization.findById(user.orgId);
      if (org && org.status === ORG_STATUS.SUSPENDED) {
        throw new ApiError(403, 'Your organization has been suspended');
      }
    }

    req.user = { uid: decoded.uid, email: decoded.email };
    req.dbUser = user;
    req.orgId = user.orgId || null;

    next();
  } catch (error) {
    next(error);
  }
}

module.exports = authenticate;