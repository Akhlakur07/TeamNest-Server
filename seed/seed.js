const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const admin = require('../config/firebaseAdmin');
const { Plan, User } = require('../models');
const { syncStripePrice } = require('../services/stripeService');
const { ROLES, USER_STATUS } = require('../models/enums');

const DEFAULT_PLANS = [
  {
    name: 'Free',
    slug: 'free',
    description: 'For small teams getting started',
    priceCents: 0,
    billingInterval: 'monthly',
    features: ['Up to 5 members', '1 active project', 'Community support'],
  },
  {
    name: 'Pro',
    slug: 'pro',
    description: 'For growing teams',
    priceCents: 1999,
    billingInterval: 'monthly',
    features: ['Up to 50 members', 'Unlimited projects', 'Priority support'],
  },
  {
    name: 'Enterprise',
    slug: 'enterprise',
    description: 'For large organizations',
    priceCents: 49900,
    billingInterval: 'yearly',
    features: ['Unlimited members', 'Custom integrations', 'Dedicated support'],
  },
];

async function seedPlans() {
  for (const planData of DEFAULT_PLANS) {
    const existing = await Plan.findOne({ slug: planData.slug });
    if (existing) {
      await Plan.updateOne({ _id: existing._id }, planData);
      console.log(`Plan "${planData.name}" updated`);
    } else {
      await Plan.create(planData);
      console.log(`Plan "${planData.name}" created`);
    }

    const plan = await Plan.findOne({ slug: planData.slug });
    if (plan.isEnabled && plan.priceCents > 0 && !plan.stripePriceId) {
      await syncStripePrice(plan);
      await plan.save();
      console.log(`Stripe price synced for "${plan.name}": ${plan.stripePriceId}`);
    }
  }
}

async function seedPlatformAdmin() {
  const email = process.env.PLATFORM_ADMIN_EMAIL;
  const password = process.env.PLATFORM_ADMIN_PASSWORD;

  if (!admin) {
    console.warn(
      'Skipping Platform Admin seed: Firebase Admin not configured (add serviceAccountKey.json / FIREBASE_SERVICE_ACCOUNT_PATH).'
    );
    return;
  }

  if (!email || !password) {
    console.warn(
      'Skipping Platform Admin seed: PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD not set in env.'
    );
    return;
  }

  let firebaseUser;
  try {
    firebaseUser = await admin.auth().getUserByEmail(email);
    console.log(`Firebase user found: ${email}`);
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      firebaseUser = await admin.auth().createUser({
        email,
        password,
        emailVerified: true,
      });
      console.log(`Firebase user created: ${email}`);
    } else {
      throw error;
    }
  }

  const existing = await User.findOne({ email });
  const payload = {
    email,
    name: 'Platform Admin',
    role: ROLES.PLATFORM_ADMIN,
    orgId: null,
    status: USER_STATUS.ACTIVE,
    firebaseUid: firebaseUser.uid,
  };

  if (existing) {
    await User.updateOne({ _id: existing._id }, { $set: payload });
  } else {
    await User.create(payload);
  }
  console.log(`Platform Admin seeded: ${email}`);
}

async function ensureIndexes() {
  const { Plan, Organization, User, Subscription, Payment, Transaction, Invitation } =
    require('../models');
  for (const model of [
    Plan,
    Organization,
    User,
    Subscription,
    Payment,
    Transaction,
    Invitation,
  ]) {
    await model.init();
  }
  console.log('All indexes ensured.');
}

async function seed() {
  await connectDB();
  try {
    await ensureIndexes();
    await seedPlans();
    await seedPlatformAdmin();
    console.log('Seeding complete.');
  } catch (error) {
    console.error('Seeding failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

seed();