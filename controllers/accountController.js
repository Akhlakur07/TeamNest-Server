const { z } = require('zod');
const admin = require('../config/firebaseAdmin');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { userProfile } = require('../utils/serializers');
const { Organization } = require('../models');

const profileSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters').max(128),
});

const emailOrEmpty = z
  .string()
  .trim()
  .max(128)
  .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid billing email');

const orgProfileSchema = z.object({
  contactName: z.string().trim().min(2, 'Contact name must be at least 2 characters').max(80).optional(),
  contactEmail: z.email('Enter a valid contact email').optional(),
  phone: z.string().trim().max(30, 'Phone number is too long').optional(),
  billingEmail: emailOrEmpty.optional(),
});

exports.updateOrganizationProfile = async (req, res) => {
  if (!req.dbUser.orgId) throw new ApiError(400, 'No organization linked to this account');

  const data = orgProfileSchema.parse(req.body);
  const org = await Organization.findById(req.dbUser.orgId);
  if (!org) throw new ApiError(404, 'Organization not found');

  if (data.contactName !== undefined) org.contactName = data.contactName;
  if (data.contactEmail !== undefined) org.contactEmail = data.contactEmail.toLowerCase().trim();
  if (data.phone !== undefined) org.phone = data.phone.trim();
  if (data.billingEmail !== undefined)
    org.billingEmail = data.billingEmail === '' ? '' : data.billingEmail.toLowerCase().trim();

  await org.save();

  res.json({
    success: true,
    org: {
      id: org._id.toString(),
      name: org.name,
      status: org.status,
      contactName: org.contactName,
      contactEmail: org.contactEmail,
      phone: org.phone,
      billingEmail: org.billingEmail,
    },
  });
};

exports.updateProfile = async (req, res) => {
  const { name } = profileSchema.parse(req.body);

  req.dbUser.name = name;
  await req.dbUser.save();

  if (admin && req.dbUser.firebaseUid) {
    await admin
      .auth()
      .updateUser(req.dbUser.firebaseUid, { displayName: name })
      .catch(() => null);
  }

  res.json({ success: true, user: userProfile(req.dbUser) });
};

exports.changePassword = async (req, res) => {
  const { currentPassword, newPassword } = passwordSchema.parse(req.body);

  if (!env.WEB_API_KEY) {
    throw new ApiError(500, 'Password verification is not configured on the server');
  }
  if (!admin) {
    throw new ApiError(500, 'Authentication service is not configured');
  }

  const verify = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.WEB_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: req.user.email,
        password: currentPassword,
        returnSecureToken: true,
      }),
    }
  );

  if (verify.status !== 200) {
    throw new ApiError(400, 'Current password is incorrect');
  }

  await admin.auth().updateUser(req.dbUser.firebaseUid, { password: newPassword });

  res.json({ success: true, message: 'Password updated successfully.' });
};