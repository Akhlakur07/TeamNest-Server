const { z } = require('zod');
const ApiError = require('../utils/ApiError');
const { Plan } = require('../models');
const { syncStripePrice } = require('../services/stripeService');
const { BILLING_INTERVAL } = require('../models/enums');

const planFields = {
  name: z.string().min(1, 'Name is required').max(80),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and dashes'),
  description: z.string().max(500).optional().default(''),
  priceCents: z.number().int().min(0, 'Price cannot be negative'),
  currency: z.string().length(3, 'Currency must be a 3-letter code').optional().default('usd'),
  billingInterval: z.enum(Object.values(BILLING_INTERVAL)),
  features: z.array(z.string().min(1)).optional().default([]),
  isEnabled: z.boolean().optional().default(true),
};

const createPlanSchema = z.object(planFields);
const updatePlanSchema = z.object({ ...planFields, slug: planFields.slug.optional() }).partial();

function planPublic(plan) {
  return {
    id: plan._id.toString(),
    name: plan.name,
    slug: plan.slug,
    description: plan.description,
    priceCents: plan.priceCents,
    currency: plan.currency,
    billingInterval: plan.billingInterval,
    features: plan.features,
  };
}

function planAdmin(plan) {
  return {
    ...planPublic(plan),
    isEnabled: plan.isEnabled,
    stripePriceId: plan.stripePriceId || null,
    stripeProductId: plan.stripeProductId || null,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

exports.listPublicPlans = async (req, res) => {
  const plans = await Plan.find({ isEnabled: true }).sort({ priceCents: 1 });
  res.json({ success: true, plans: plans.map(planPublic) });
};

exports.getPlan = async (req, res) => {
  const plan = await Plan.findOne({ _id: req.params.id, isEnabled: true });
  if (!plan) {
    throw new ApiError(404, 'Plan not found');
  }
  res.json({ success: true, plan: planPublic(plan) });
};

exports.listManagePlans = async (req, res) => {
  const plans = await Plan.find().sort({ createdAt: -1 });
  res.json({ success: true, plans: plans.map(planAdmin) });
};

exports.createPlan = async (req, res) => {
  const data = createPlanSchema.parse(req.body);

  const existing = await Plan.findOne({ slug: data.slug });
  if (existing) {
    throw new ApiError(409, 'A plan with this slug already exists');
  }

  const plan = new Plan(data);
  await syncStripePrice(plan);
  await plan.save();

  res.status(201).json({ success: true, plan: planAdmin(plan) });
};

exports.updatePlan = async (req, res) => {
  const data = updatePlanSchema.parse(req.body);

  const plan = await Plan.findById(req.params.id);
  if (!plan) {
    throw new ApiError(404, 'Plan not found');
  }

  if (data.slug && data.slug !== plan.slug) {
    const dup = await Plan.findOne({ slug: data.slug, _id: { $ne: plan._id } });
    if (dup) {
      throw new ApiError(409, 'A plan with this slug already exists');
    }
  }

  const oldPrice = plan.priceCents;
  Object.assign(plan, data);

  const needsNewPrice =
    plan.isEnabled &&
    plan.priceCents > 0 &&
    (!plan.stripePriceId || data.priceCents !== undefined && data.priceCents !== oldPrice);

  if (needsNewPrice) {
    await syncStripePrice(plan);
  }

  await plan.save();

  res.json({ success: true, plan: planAdmin(plan) });
};