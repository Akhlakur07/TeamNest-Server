const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const authenticate = require('../middleware/authenticate');
const { login, me, resetPassword, join } = require('../controllers/authController');
const {
  register,
  retryCheckout,
  registrationStatus,
  registrationStatusPublic,
} = require('../controllers/registrationController');

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Try again later.' },
});

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many reset requests. Try again later.' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many registration attempts. Try again later.' },
});

router.post('/login', loginLimiter, login);
router.post('/password-reset', resetLimiter, resetPassword);
router.post('/register', registerLimiter, register);
router.post('/join', registerLimiter, join);
router.post('/retry-checkout', authenticate, registerLimiter, retryCheckout);
router.get('/registration-status', authenticate, registrationStatus);
router.get('/registration/status', registerLimiter, registrationStatusPublic);
router.get('/me', authenticate, me);

module.exports = router;