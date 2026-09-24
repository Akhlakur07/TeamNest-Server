const { z } = require('zod');
const mongoose = require('mongoose');
const stripe = require('../config/stripe');
const admin = require('../config/firebaseAdmin');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { Plan, Organization, Subscription, User } = require('../models');
const { ROLES, USER_STATUS, ORG_STATUS, SUBSCRIPTION_STATUS } = require('../models/enums');

const registerSchema = z.object({
  organizationName: z.string().trim().min(2, 'Organization name is required').max(100),
  adminName: z.string().trim().min(2, 'Admin name is required').max(80),
  email: z.email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  planId: z.string().min(1, 'A plan is required'),
});

async function deleteFirebaseUser(uid) {
  if (admin && uid) {
    await admin.auth().deleteUser(uid).catch(() => null);
  }
}

async function createCheckoutSession({ plan, orgId, email }) {
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: email,
    client_reference_id: orgId,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    metadata: { orgId, planId: plan._id.toString() },
    subscription_data: {
      metadata: { orgId, planId: plan._id.toString() },
    },
    success_url: `${env.FRONTEND_URL}/registration/status?status=success&orgId=${orgId}`,
    cancel_url: `${env.FRONTEND_URL}/registration/status?status=cancelled&orgId=${orgId}`,
  });
}

exports.register = async (req, res) => {
  const data = registerSchema.parse(req.body);
  const email = data.email.toLowerCase().trim();

  if (!admin) {
    throw new ApiError(500, 'Authentication service is not configured');
  }

  const [existingUser, existingOrg, plan] = await Promise.all([
    User.findOne({ email }),
    Organization.findOne({ name: data.organizationName }),
    Plan.findById(data.planId),
  ]);

  if (existingUser) throw new ApiError(409, 'An account with this email already exists');
  if (existingOrg) throw new ApiError(409, 'An organization with this name already exists');
  if (!plan || !plan.isEnabled) throw new ApiError(400, 'Selected plan is not available');
  if (!plan.stripePriceId) {
    throw new ApiError(400, 'This plan cannot be used for checkout yet');
  }

  let firebaseUser;
  try {
    firebaseUser = await admin.auth().createUser({
      email,
      password: data.password,
      displayName: data.adminName,
    });
  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      throw new ApiError(409, 'An account with this email already exists');
    }
    throw error;
  }

  const orgId = new mongoose.Types.ObjectId();

  let checkout;
  try {
    checkout = await createCheckoutSession({ plan, orgId: orgId.toString(), email });
  } catch (error) {
    await deleteFirebaseUser(firebaseUser.uid);
    console.error('Checkout session creation failed:', error);
    throw new ApiError(502, 'Payment setup failed. Please try again.');
  }

  const sess = await mongoose.startSession();
  try {
    sess.startTransaction();
    await Organization.create(
      [
        {
          _id: orgId,
          name: data.organizationName,
          contactName: data.adminName,
          contactEmail: email,
          billingEmail: email,
          status: ORG_STATUS.PENDING,
          planId: plan._id,
          checkoutSessionId: checkout.id,
        },
      ],
      { session: sess }
    );
    await Subscription.create(
      [{ orgId, planId: plan._id, status: SUBSCRIPTION_STATUS.PENDING }],
      { session: sess }
    );
    await User.create(
      [
        {
          email,
          name: data.adminName,
          role: ROLES.ORG_ADMIN,
          orgId,
          status: USER_STATUS.ACTIVE,
          firebaseUid: firebaseUser.uid,
        },
      ],
      { session: sess }
    );
    await sess.commitTransaction();
  } catch (error) {
    await sess.abortTransaction();
    await deleteFirebaseUser(firebaseUser.uid);
    await stripe.checkout.sessions.expire(checkout.id).catch(() => null);
    console.error('Registration transaction failed:', error);
    throw new ApiError(502, 'Registration could not be completed. Please try again.');
  } finally {
    sess.endSession();
  }

  res.status(201).json({ success: true, orgId: orgId.toString(), checkoutUrl: checkout.url });
};

exports.retryCheckout = async (req, res) => {
  const user = req.dbUser;
  if (!user.orgId) throw new ApiError(400, 'No organization linked to this account');

  const org = await Organization.findById(user.orgId);
  if (!org) throw new ApiError(404, 'Organization not found');
  if (org.status !== ORG_STATUS.PENDING) {
    throw new ApiError(400, 'Only pending organizations can retry checkout');
  }

  const plan = await Plan.findById(org.planId);
  if (!plan || !plan.stripePriceId) {
    throw new ApiError(400, 'Selected plan cannot be used for checkout');
  }

  if (org.checkoutSessionId) {
    await stripe.checkout.sessions.expire(org.checkoutSessionId).catch(() => null);
  }

  const checkout = await createCheckoutSession({
    plan,
    orgId: org._id.toString(),
    email: user.email,
  });
  org.checkoutSessionId = checkout.id;
  await org.save();

  res.json({ success: true, orgId: org._id.toString(), checkoutUrl: checkout.url });
};

exports.registrationStatus = async (req, res) => {
  const user = req.dbUser;
  if (!user.orgId) throw new ApiError(400, 'No organization linked to this account');

  const org = await Organization.findById(user.orgId);
  if (!org) throw new ApiError(404, 'Organization not found');

  const subscription = await Subscription.findOne({ orgId: org._id, isCurrent: true });

  res.json({
    success: true,
    org: {
      id: org._id.toString(),
      name: org.name,
      status: org.status,
      planId: org.planId ? org.planId.toString() : null,
    },
    subscription: subscription ? { status: subscription.status } : null,
  });
};