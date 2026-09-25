const { z } = require('zod');
const ApiError = require('../utils/ApiError');
const { Organization, Plan, Subscription, Payment, User } = require('../models');
const { ORG_STATUS, SUBSCRIPTION_STATUS } = require('../models/enums');
const { memberSummary } = require('../services/memberService');

const STATUS_VALUES = Object.values(ORG_STATUS);

const emptyToMissing = (value) => (value === '' ? undefined : value);

const listQuerySchema = z.object({
  search: z.preprocess(emptyToMissing, z.string().trim().max(120).optional()),
  status: z.preprocess(emptyToMissing, z.enum(STATUS_VALUES).optional()),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const statusSchema = z.object({
  status: z.enum([ORG_STATUS.ACTIVE, ORG_STATUS.SUSPENDED]),
});

async function pageMeta(orgs) {
  const ids = orgs.map((o) => o._id);
  const planIds = [...new Set(orgs.map((o) => o.planId?.toString()).filter(Boolean))];
  const [plans, subs, memberCounts] = await Promise.all([
    planIds.length ? Plan.find({ _id: { $in: planIds } }).lean() : [],
    Subscription.find({ orgId: { $in: ids }, isCurrent: true }).lean(),
    User.aggregate([
      { $match: { orgId: { $in: ids } } },
      { $group: { _id: '$orgId', count: { $sum: 1 } } },
    ]),
  ]);
  const planNames = new Map(plans.map((p) => [p._id.toString(), p]));
  const subMap = new Map(subs.map((s) => [s.orgId.toString(), s]));
  const countMap = new Map(memberCounts.map((m) => [m._id.toString(), m.count]));

  return orgs.map((org) => {
    const plan = planNames.get(org.planId?.toString()) || null;
    const sub = subMap.get(org._id.toString()) || null;
    return {
      id: org._id.toString(),
      name: org.name,
      contactName: org.contactName,
      contactEmail: org.contactEmail,
      status: org.status,
      memberCount: countMap.get(org._id.toString()) || 0,
      plan: plan ? { id: plan._id.toString(), name: plan.name, slug: plan.slug } : null,
      subscriptionStatus: sub?.status || null,
      activatedAt: org.activatedAt || null,
      signupDate: org.signupDate,
      createdAt: org.createdAt,
    };
  });
}

exports.listOrganizations = async (req, res) => {
  const query = listQuerySchema.parse(req.query);
  const match = {};
  if (query.search) {
    const re = new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    match.$or = [{ name: re }, { contactEmail: re }, { billingEmail: re }];
  }
  if (query.status) match.status = query.status;

  const skip = (query.page - 1) * query.limit;
  const [total, orgs] = await Promise.all([
    Organization.countDocuments(match),
    Organization.find(match).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
  ]);

  res.json({
    success: true,
    total,
    page: query.page,
    limit: query.limit,
    organizations: await pageMeta(orgs),
  });
};

exports.getOrganization = async (req, res) => {
  const { id } = req.params;

  const org = await Organization.findById(id);
  if (!org) throw new ApiError(404, 'Organization not found');

  const [plan, subscription, members, payments] = await Promise.all([
    org.planId ? Plan.findById(org.planId) : null,
    Subscription.findOne({ orgId: org._id, isCurrent: true }),
    User.find({ orgId: org._id }).sort({ role: 1, name: 1 }),
    Payment.find({ orgId: org._id }).sort({ paidAt: -1 }).limit(10),
  ]);

  res.json({
    success: true,
    organization: {
      id: org._id.toString(),
      name: org.name,
      contactName: org.contactName,
      contactEmail: org.contactEmail,
      billingEmail: org.billingEmail,
      phone: org.phone,
      status: org.status,
      plan: plan
        ? { id: plan._id.toString(), name: plan.name, slug: plan.slug }
        : null,
      stripeCustomerId: org.stripeCustomerId,
      stripeSubscriptionId: org.stripeSubscriptionId,
      activatedAt: org.activatedAt,
      suspendedAt: org.suspendedAt,
      signupDate: org.signupDate,
      createdAt: org.createdAt,
    },
    subscription: subscription
      ? {
          id: subscription._id.toString(),
          status: subscription.status,
          planId: subscription.planId,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
          canceledAt: subscription.canceledAt,
          trialEnd: subscription.trialEnd,
        }
      : null,
    members: members.map(memberSummary),
    recentPayments: payments.map((p) => ({
      id: p._id.toString(),
      invoiceNumber: p.invoiceNumber,
      amountCents: p.amountCents,
      currency: p.currency,
      status: p.status,
      paidAt: p.paidAt,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
    })),
  });
};

exports.setOrganizationStatus = async (req, res) => {
  const { status } = statusSchema.parse(req.body);
  const { id } = req.params;

  const org = await Organization.findById(id);
  if (!org) throw new ApiError(404, 'Organization not found');

  if (org.status === ORG_STATUS.CANCELLED) {
    throw new ApiError(400, 'Cannot change the status of a cancelled organization');
  }

  if (status === ORG_STATUS.SUSPENDED) {
    if (org.status === ORG_STATUS.SUSPENDED) {
      throw new ApiError(400, 'Organization is already suspended');
    }
    org.status = ORG_STATUS.SUSPENDED;
    org.suspendedAt = new Date();
  } else {
    if (org.status !== ORG_STATUS.SUSPENDED) {
      throw new ApiError(400, 'Only a suspended organization can be reactivated');
    }
    org.status = ORG_STATUS.ACTIVE;
    org.suspendedAt = null;
    const sub = await Subscription.findOne({ orgId: org._id, isCurrent: true });
    if (sub && sub.status !== SUBSCRIPTION_STATUS.ACTIVE) {
      sub.status = SUBSCRIPTION_STATUS.ACTIVE;
      sub.save();
    }
  }

  await org.save();

  res.json({
    success: true,
    message:
      status === ORG_STATUS.SUSPENDED
        ? 'Organization suspended. Members are blocked until reactivated.'
        : 'Organization reactivated.',
    organization: {
      id: org._id.toString(),
      name: org.name,
      status: org.status,
      suspendedAt: org.suspendedAt,
    },
  });
};