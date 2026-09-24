const { Transaction, Organization, Plan } = require('../models');
const { TRANSACTION_STATUS, TRANSACTION_TYPE, ORG_STATUS } = require('../models/enums');

const REVENUE_TYPES = [TRANSACTION_TYPE.CHECKOUT, TRANSACTION_TYPE.RENEWAL];

exports.revenueOverview = async (req, res) => {
  const successMatch = { status: TRANSACTION_STATUS.SUCCESS };

  const [grossResult, activeOrganizations, totalOrganizations] = await Promise.all([
    Transaction.aggregate([
      { $match: successMatch },
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
    Organization.countDocuments({ status: ORG_STATUS.ACTIVE }),
    Organization.countDocuments(),
  ]);

  const grossTotal = grossResult?.[0]?.gross || 0;
  const refundTotal = grossResult?.[0]?.refunds || 0;

  const sixMonths = new Date();
  sixMonths.setMonth(sixMonths.getMonth() - 5);
  sixMonths.setDate(1);
  sixMonths.setHours(0, 0, 0, 0);

  const [monthly, byPlanRows, recentRows] = await Promise.all([
    Transaction.aggregate([
      { $match: { ...successMatch, createdAt: { $gte: sixMonths } } },
      {
        $project: {
          month: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          amountCents: 1,
          type: 1,
        },
      },
      {
        $group: {
          _id: '$month',
          revenue: {
            $sum: {
              $cond: [{ $eq: ['$type', TRANSACTION_TYPE.REFUND] }, 0, '$amountCents'],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Transaction.aggregate([
      { $match: { ...successMatch, planId: { $ne: null }, type: { $in: REVENUE_TYPES } } },
      {
        $group: {
          _id: '$planId',
          revenue: { $sum: '$amountCents' },
          count: { $sum: 1 },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
    ]),
    Transaction.find(successMatch).sort({ createdAt: -1 }).limit(15).lean(),
  ]);

  const planIds = byPlanRows.map((r) => r._id);
  const plans = await Plan.find({ _id: { $in: planIds } }).lean();
  const planNames = new Map(plans.map((p) => [p._id.toString(), p.name || p.slug]));

  const byPlan = byPlanRows.map((row) => ({
    planId: row._id.toString(),
    planName: planNames.get(row._id.toString()) || 'Unknown plan',
    revenue: row.revenue,
    count: row.count,
  }));

  const recentOrgIds = [...new Set(recentRows.map((r) => r.orgId?.toString()).filter(Boolean))];
  const orgs = await Organization.find({ _id: { $in: recentOrgIds } }).lean();
  const orgNames = new Map(orgs.map((o) => [o._id.toString(), o.name]));

  const recent = recentRows.map((tx) => ({
    id: tx._id.toString(),
    date: tx.createdAt,
    type: tx.type,
    status: tx.status,
    amountCents: tx.amountCents,
    currency: tx.currency,
    orgId: tx.orgId?.toString() || null,
    orgName: tx.orgId ? orgNames.get(tx.orgId.toString()) || 'Unknown' : '—',
  }));

  res.json({
    success: true,
    grossCents: grossTotal,
    refundsCents: refundTotal,
    netCents: grossTotal - refundTotal,
    transactionCount: grossResult?.[0]?.count || 0,
    activeOrganizations,
    totalOrganizations,
    monthly,
    byPlan,
    recent,
  });
};