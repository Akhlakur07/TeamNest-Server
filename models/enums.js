const ROLES = Object.freeze({
  PLATFORM_ADMIN: 'platform_admin',
  ORG_ADMIN: 'org_admin',
  ORG_MEMBER: 'org_member',
});

const USER_STATUS = Object.freeze({
  ACTIVE: 'active',
  INVITED: 'invited',
  SUSPENDED: 'suspended',
});

const ORG_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  TRIAL: 'TRIAL',
  SUSPENDED: 'SUSPENDED',
  CANCELLED: 'CANCELLED',
});

const SUBSCRIPTION_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  PENDING: 'PENDING',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
});

const PAYMENT_STATUS = Object.freeze({
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
});

const TRANSACTION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
  ROLLED_BACK: 'ROLLED_BACK',
});

const TRANSACTION_TYPE = Object.freeze({
  CHECKOUT: 'checkout',
  RENEWAL: 'renewal',
  UPGRADE: 'upgrade',
  DOWNGRADE: 'downgrade',
  CANCEL: 'cancel',
  REFUND: 'refund',
});

const INVITATION_STATUS = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  EXPIRED: 'expired',
});

const BILLING_INTERVAL = Object.freeze({
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
});

module.exports = {
  ROLES,
  USER_STATUS,
  ORG_STATUS,
  SUBSCRIPTION_STATUS,
  PAYMENT_STATUS,
  TRANSACTION_STATUS,
  TRANSACTION_TYPE,
  INVITATION_STATUS,
  BILLING_INTERVAL,
};