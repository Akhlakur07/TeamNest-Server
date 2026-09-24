const { z } = require('zod');
const ApiError = require('../utils/ApiError');
const { Transaction } = require('../models');
const { TRANSACTION_STATUS, TRANSACTION_TYPE } = require('../models/enums');

const TYPE_VALUES = Object.values(TRANSACTION_TYPE);
const STATUS_VALUES = Object.values(TRANSACTION_STATUS);

function requireOrgId(user) {
  if (!user.orgId) throw new ApiError(400, 'No organization linked to this account');
  return user.orgId;
}

function isDateString(value) {
  return !Number.isNaN(Date.parse(value));
}

const listQuerySchema = z.object({
  type: z.enum(TYPE_VALUES).optional(),
  status: z.enum(STATUS_VALUES).optional(),
  from: z.string().refine(isDateString, 'Invalid "from" date').optional(),
  to: z.string().refine(isDateString, 'Invalid "to" date').optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

function buildMatch(orgId, query) {
  const match = { orgId };
  if (query.type) match.type = query.type;
  if (query.status) match.status = query.status;
  if (query.from || query.to) {
    match.createdAt = {};
    if (query.from) match.createdAt.$gte = new Date(query.from);
    if (query.to) match.createdAt.$lte = new Date(query.to);
  }
  return match;
}

function serialize(tx) {
  return {
    id: tx._id.toString(),
    type: tx.type,
    status: tx.status,
    amountCents: tx.amountCents,
    currency: tx.currency,
    createdAt: tx.createdAt,
    errorMessage: tx.errorMessage,
    plan: tx.planId
      ? { id: tx.planId._id.toString(), name: tx.planId.name, slug: tx.planId.slug }
      : null,
    paymentId: tx.paymentId || null,
    subscriptionId: tx.subscriptionId || null,
    metadata: tx.metadata || {},
  };
}

async function buildSummary(match) {
  const rows = await Transaction.aggregate([
    { $match: match },
    {
      $group: {
        _id: { type: '$type', status: '$status' },
        amount: { $sum: '$amountCents' },
        count: { $sum: 1 },
      },
    },
  ]);

  const byType = {};
  const byStatus = {};
  let collected = 0;
  let refunded = 0;

  for (const row of rows) {
    const { type, status } = row._id;
    byType[type] = (byType[type] || 0) + row.count;
    byStatus[status] = (byStatus[status] || 0) + row.count;
    if (type === TRANSACTION_TYPE.REFUND) {
      refunded += row.amount;
    } else if (status === TRANSACTION_STATUS.SUCCESS) {
      collected += row.amount;
    }
  }

  return {
    count: rows.reduce((sum, r) => sum + r.count, 0),
    collected,
    refunded,
    net: collected - refunded,
    byType,
    byStatus,
  };
}

exports.listTransactions = async (req, res) => {
  const orgId = requireOrgId(req.dbUser);
  const query = listQuerySchema.parse(req.query);
  const match = buildMatch(orgId, query);
  const skip = (query.page - 1) * query.limit;

  const [total, transactions, summary] = await Promise.all([
    Transaction.countDocuments(match),
    Transaction.find(match)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(query.limit)
      .populate('planId', 'name slug'),
    buildSummary(match),
  ]);

  res.json({
    success: true,
    total,
    page: query.page,
    limit: query.limit,
    summary,
    transactions: transactions.map(serialize),
  });
};

exports.getTransaction = async (req, res) => {
  const orgId = requireOrgId(req.dbUser);
  const { id } = req.params;

  const tx = await Transaction.findOne({ _id: id, orgId }).populate('planId', 'name slug');
  if (!tx) throw new ApiError(404, 'Transaction not found');

  res.json({ success: true, transaction: serialize(tx) });
};

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

exports.exportTransactions = async (req, res) => {
  const orgId = requireOrgId(req.dbUser);
  const query = listQuerySchema.parse(req.query);
  const match = buildMatch(orgId, query);

  const rows = await Transaction.find(match)
    .sort({ createdAt: -1 })
    .limit(10000)
    .populate('planId', 'name slug')
    .lean();

  const header = [
    'date',
    'type',
    'status',
    'amount',
    'currency',
    'plan',
    'payment_id',
    'error',
  ];
  const lines = rows.map((tx) =>
    [
      tx.createdAt ? tx.createdAt.toISOString() : '',
      tx.type,
      tx.status,
      tx.amountCents,
      tx.currency,
      tx.planId?.slug || '',
      tx.paymentId || '',
      tx.errorMessage || '',
    ]
      .map(csvEscape)
      .join(',')
  );

  const csv = [header.join(','), ...lines].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="transactions-${new Date().toISOString().slice(0, 10)}.csv"`
  );
  res.status(200).send(csv);
};