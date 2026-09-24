const { Router } = require('express');

const router = Router();

router.get('/health', (req, res) => {
  res.json({ success: true, message: 'TeamNest API is healthy' });
});

router.use('/auth', require('./auth'));

module.exports = router;