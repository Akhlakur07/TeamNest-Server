const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const {
  listTransactions,
  getTransaction,
  exportTransactions,
} = require('../controllers/transactionController');

const router = Router();

router.use(authenticate);

router.get('/', listTransactions);
router.get('/export', exportTransactions);
router.get('/:id', getTransaction);

module.exports = router;