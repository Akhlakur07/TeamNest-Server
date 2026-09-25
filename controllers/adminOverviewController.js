const { z } = require('zod');
const { Transaction, Organization, Plan, User } = require('../models');
const {
  TRANSACTION_STATUS,
  TRANSACTION_TYPE,
  ORG_STATUS,
} = require('../models/enums');

const TYPE_VALUES = Object.values(TRANSACTION_TYPE);
const STATUS_VALUES = Object.values(TRANSACTION_STATUS);

function isDateString(value) {
  return !Number.isNaN(Date.parse(value));
}

function escapeRegExp(value) {
  return value.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

const emptyToMissing = (value) => (value === '' ? undefined : value);

const listSchema = z.object({
  type: z.preprocess(emptyToMissing, z.enum(TYPE_VALUES).optional()),
  status: z.preprocess(emptyToMissing, z.enum(STATUS_VALUES).optional()),
  search: z.preprocess(emptyToMissing, z.string().trim().max(100).optional()),
  from: z.preprocess(
    emptyToMissing,
    z.string().refine(isDateString, 'Invalid "from" date').optional()
  ),
  to: z.preprocess(
    emptyToMissing,
    z.string().refine(isDateString, 'Invalid "to" date').optional()
  ),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

async function resolveOrgNames(transactions) {
  const orgIds = [
    ...new Set(transactions.map((tx) => tx.orgId?.toString()).filter(Boolean)),
  ];
  const orgs =
    orgIds.length > 0
      ? await Organization.find({ _id: { $in: orgIds } }).select('name').lean()
      : [];
  const names = new Map(orgs.map((o) => [o._id.toString(), o.name]));
  return names;
}

function serialize(tx, names) {
  return {
    id: tx._id.toString(),
    type: tx.type,
    status: tx.status,
    amountCents: tx.amountCents,
    currency: tx.currency,
    createdAt: tx.createdAt,
    orgId: tx.orgId?.toString() || null,
    orgName: tx.orgId ? names.get(tx.orgId.toString()) || 'Unknown' : '—',
    plan: tx.planId
      ? {
          id: tx.planId._id.toString(),
          name: tx.planId.name,
          slug: tx.planId.slug,
        }
      : null,
    metadata: tx.metadata || {},
  };
}

exports.listAllTransactions = async (req, res) => {
  const query = listSchema.parse(req.query);
  const match = {};

  if (query.type) match.type = query.type;
  if (query.status) match.status = query.status;
  if (query.from || query.to) {
    match.createdAt = {};
    if (query.from) match.createdAt.$gte = new Date(query.from);
    if (query.to) match.createdAt.$lte = new Date(query.to);
  }
  if (query.search) {
    const pattern = new RegExp(escapeRegExp(query.search), 'i');
    const orgs = await Organization.find({
      $or: [{ name: pattern }, { contactEmail: pattern }],
    })
      .select('_id')
      .lean();
    const ids = orgs.map((o) => o._id);
    if (ids.length === 0) {
      return res.json({
        success: true,
        total: 0,
        page: query.page,
        limit: query.limit,
        transactions: [],
      });
    }
    match.orgId = { $in: ids };
  }

  const skip = (query.page - 1) * query.limit;
  const [total, rows] = await Promise.all([
    Transaction.countDocuments(match),
    Transaction.find(match)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(query.limit)
      .populate('planId', 'name slug'),
  ]);

  const names = await resolveOrgNames(rows);

  res.json({
    success: true,
    total,
    page: query.page,
    limit: query.limit,
    transactions: rows.map((tx) => serialize(tx, names)),
  });
};

exports.statsOverview = async (req, res) => {
  const [orgByStatus, revenue, planCount, memberCount] = await Promise.all([
    Organization.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Transaction.aggregate([
      { $match: { status: TRANSACTION_STATUS.SUCCESS } },
      {
        $group: {
          _id: null,
          gross: {
            $sum: {
              $cond: [{ $eq: ['$type', TRANSACTION_TYPE.REFUND] }, 0, '$amountCents'],
            },
          },
          refunds: {
            $sum: {
              $cond: [{ $eq: ['$type', TRANSACTION_TYPE.REFUND] }, '$amountCents', 0],
            },
          },
          count: { $sum: 1 },
        },
      },
    ]),
    Plan.countDocuments(),
    User.countDocuments({ orgId: { $ne: null } }),
  ]);

  const statusCounts = {};
  for (const row of orgByStatus) statusCounts[row._id] = row.count;
  const totals = revenue[0] || { gross: 0, refunds: 0, count: 0 };

  const recentRows = await Transaction.find({
    status: TRANSACTION_STATUS.SUCCESS,
  })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();
  const names = await resolveOrgNames(recentRows);

  res.json({
    success: true,
    organizations: { total: orgByStatus.reduce((sum, r) => sum + r.count, 0), ...statusCounts },
    planCount,
    memberCount,
    grossCents: totals.gross,
    refundsCents: totals.refunds,
    netCents: totals.gross - totals.refunds,
    transactionCount: totals.count,
    recentTransactions: recentRows.map((tx) => serialize(tx, names)),
  });
};