const ApiError = require('../utils/ApiError');

const authorize =
  (...roles) =>
  (req, res, next) => {
    if (!req.dbUser) {
      return next(new ApiError(401, 'Authentication required'));
    }
    if (!roles.includes(req.dbUser.role)) {
      return next(
        new ApiError(403, 'You do not have permission to perform this action')
      );
    }
    next();
  };

module.exports = authorize;