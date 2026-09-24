const mongoose = require('mongoose');
const api = require('../test/helpers/api');
const env = require('../config/env');
const { Plan, Organization, User, Invitation, WebhookLog } = require('../models');
const { ORG_STATUS } = require('../models/enums');

let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name} ${extra}`);
  }
}

async function firebaseToken(email, password) {
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=AIzaSyCeIgzJIm9GKOlZyTsT-fwcf7kotL0J8e0',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error(`firebase sign-in failed: ${data.error?.message || res.status}`);
  return data.idToken;
}

async function login(email, password) {
  const token = await firebaseToken(email, password);
  const res = await api.post('/auth/login', { token });
  if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.body)}`);
  return token;
}

async function registerAndActivate(name, email, plan, idSuffix) {
  const reg = await api.post('/auth/register', {
    organizationName: name,
    adminName: 'Org Admin',
    email,
    password: 'Passw0rd!123',
    planId: plan._id.toString(),
  });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const orgId = reg.body.orgId;
  const checkout = {
    id: `evt_checkout_${idSuffix}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${idSuffix}`,
        customer: `cus_${idSuffix}`,
        subscription: `sub_${idSuffix}`,
        payment_status: 'paid',
        client_reference_id: orgId,
        metadata: { orgId, planId: plan._id.toString() },
      },
    },
  };
  await fetch('http://localhost:5000/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(checkout),
  });
  const org = await Organization.findById(orgId);
  if (org.status !== ORG_STATUS.ACTIVE) throw new Error('org did not activate');
  return { orgId, adminEmail: email, adminToken: await login(email, 'Passw0rd!123') };
}

(async () => {
  await mongoose.connect(env.MONGO_URI, { dbName: env.DB_NAME });
  for (const col of ['organizations', 'subscriptions', 'users', 'invitations', 'webhooklogs', 'payments', 'transactions']) {
    await mongoose.connection.dropCollection(col).catch(() => {});
  }

  const pro = await Plan.findOne({ slug: 'pro' });
  const stamp = Date.now();
  const ZED_EMAIL = `zed-${stamp}@tenantisolation.com`;
  const ALICE_EMAIL = `alice-${stamp}@other.com`;
  const DAVE_EMAIL = `dave-${stamp}@revoke.com`;
  const EVE_EMAIL = `eve-${stamp}@limit.com`;

  console.log('\n--- setup two ACTIVE organizations ---');
  const orgA = await registerAndActivate(`OrgA ${stamp}`, `admin-a-${stamp}@example.com`, pro, `A${stamp}`);
  const orgB = await registerAndActivate(`OrgB ${stamp}`, `admin-b-${stamp}@example.com`, pro, `B${stamp}`);
  check('org A admin token works', typeof orgA.adminToken === 'string');
  check('org B active', !!orgB.orgId);

  console.log('\n--- org A invites & lists ---');
  const inviteRes = await api.post('/members/invite', { email: ZED_EMAIL, role: 'org_member' }, orgA.adminToken);
  check('invite -> 201', inviteRes.status === 201, `got ${inviteRes.status} ${JSON.stringify(inviteRes.body)}`);
  const inviteUrl = inviteRes.body?.invite?.url;
  const token = inviteRes.body?.invite?.url?.split('token=')[1];
  check('invite returns url with token', typeof token === 'string' && token.length >= 20, inviteUrl);
  check('invite default role org_member', inviteRes.body?.invite?.role === 'org_member');

  const listA = await api.get('/members', orgA.adminToken);
  check('org A members list has 1 member', listA.status === 200 && listA.body.members.length === 1, JSON.stringify(listA.body?.members?.map((m) => m.email)));
  check('member limit metadata returned', listA.body?.org?.maxMembers === 50);

  const invList = await api.get('/members/invitations', orgA.adminToken);
  check('pending invitations listed', invList.body?.invitations?.length === 1 && invList.body.invitations[0].email === ZED_EMAIL);

  console.log('\n--- duplicate invite guards ---');
  const dupInvite = await api.post('/members/invite', { email: ZED_EMAIL, role: 'org_member' }, orgA.adminToken);
  check('duplicate pending invite -> 409', dupInvite.status === 409, `got ${dupInvite.status}`);
  const badEmail = await api.post('/members/invite', { email: 'not-an-email', role: 'org_member' }, orgA.adminToken);
  check('invalid email -> 400', badEmail.status === 400, `got ${badEmail.status}`);

  console.log('\n--- tenant isolation: org B cannot see/touch org A data ---');
  const listB = await api.get('/members', orgB.adminToken);
  const aEmails = listA.body.members.map((m) => m.email);
  check('org B list does not leak org A members', !aEmails.some((e) => listB.body.members.some((m) => m.email === e)));
  const invListB = await api.get('/members/invitations', orgB.adminToken);
  check('org B sees no pending invites', invListB.body?.invitations?.length === 0);
  const aMemberId = listA.body.members[0].id;
  const anInviteId = invList.body.invitations[0].id;
  const crossRole = await api.patch(`/members/${aMemberId}/role`, { role: 'org_member' }, orgB.adminToken);
  check('org B change org A member role -> 404', crossRole.status === 404, `got ${crossRole.status}`);
  const crossRemove = await api.delete(`/members/${aMemberId}`, orgB.adminToken);
  check('org B remove org A member -> 404', crossRemove.status === 404, `got ${crossRemove.status}`);
  const crossRevoke = await api.delete(`/members/invitations/${anInviteId}`, orgB.adminToken);
  check('org B revoke org A invite -> 404', crossRevoke.status === 404, `got ${crossRevoke.status}`);

  console.log('\n--- join via invitation token (new account, no paid onboarding) ---');
  const join = await api.post('/auth/join', { token, name: 'Zed Member', password: 'Passw0rd!123' });
  check('join -> 201', join.status === 201, `got ${join.status} ${JSON.stringify(join.body)}`);
  check('join returns member role', join.body?.org?.role === 'org_member');
  const zedToken = await login(ZED_EMAIL, 'Passw0rd!123');
  const zedList = await api.get('/members', zedToken);
  check('zed member of org A only (2 members)', zedList.status === 200 && zedList.body.members.length === 2, JSON.stringify(zedList.body?.members?.map((m) => m.email)));
  const zedInA = await User.findOne({ email: ZED_EMAIL });
  check('zed user record linked to org A', zedInA?.orgId?.toString() === orgA.orgId && zedInA?.role === 'org_member' && zedInA?.status === 'active');
  const inviteDoc = await Invitation.findOne({ email: ZED_EMAIL });
  check('invitation marked accepted', inviteDoc?.status === 'accepted');

  console.log('\n--- join guards ---');
  const joinAgain = await api.post('/auth/join', { token, name: 'Zed Again', password: 'Passw0rd!123' });
  check('re-join accepted invite -> 400', joinAgain.status === 400, `got ${joinAgain.status}`);
  check('zed removed from pending invites list', (await api.get('/members/invitations', orgA.adminToken)).body?.invitations?.length === 0);
  const ghostJoin = await api.post('/auth/join', { token: 'evt_deadbeef_ghosttoken_0123456789abcdef', name: 'Ghost', password: 'Passw0rd!123' });
  check('join with unknown token -> 404', ghostJoin.status === 404, `got ${ghostJoin.status}`);

  console.log('\n--- invite to nonexistent user, then logged-in accept mismatch ---');
  const inviteB = await api.post('/members/invite', { email: ALICE_EMAIL, role: 'org_member' }, orgA.adminToken);
  const tokenB = inviteB.body.invite.url.split('token=')[1];
  const wrongUserAccept = await api.post('/members/accept', { token: tokenB }, orgB.adminToken);
  check('accept with mismatched email -> 403', wrongUserAccept.status === 403, `got ${wrongUserAccept.status} ${JSON.stringify(wrongUserAccept.body)}`);

  console.log('\n--- existing user belongs to another org -> accept 409 ---');
  const inviteC = await api.post('/members/invite', { email: `admin-b-${stamp}@example.com`, role: 'org_member' }, orgA.adminToken);
  const tokenC = inviteC.body.invite.url.split('token=')[1];
  const crossOrgAccept = await api.post('/members/accept', { token: tokenC }, orgB.adminToken);
  check('org B admin accepting org A invite -> 409', crossOrgAccept.status === 409, `got ${crossOrgAccept.status} ${JSON.stringify(crossOrgAccept.body)}`);

  console.log('\n--- role management & guards ---');
  const zedId = zedInA._id.toString();
  const promote = await api.patch(`/members/${zedId}/role`, { role: 'org_admin' }, orgA.adminToken);
  check('promote zed to org_admin -> 200', promote.status === 200 && promote.body?.member?.role === 'org_admin');
  const selfRole = await api.patch(`/members/${listA.body.members[0].id}/role`, { role: 'org_member' }, orgA.adminToken);
  check('self role change -> 400', selfRole.status === 400, `got ${selfRole.status}`);
  const demoteZed = await api.patch(`/members/${zedId}/role`, { role: 'org_member' }, orgA.adminToken);
  check('demote zed (2 admins -> 1 admin remains) -> 200', demoteZed.status === 200, `got ${demoteZed.status}`);
  const rolesAfter = (await api.get('/members', orgA.adminToken)).body.members.reduce((acc, m) => ((acc[m.role] = (acc[m.role] || 0) + 1), acc), {});
  check('org A still has exactly one admin', rolesAfter.org_admin === 1, JSON.stringify(rolesAfter));

  console.log('\n--- invite member already in org -> 400 ---');
  const alreadyMember = await api.post('/members/invite', { email: ZED_EMAIL, role: 'org_member' }, orgA.adminToken);
  check('invite existing member -> 400', alreadyMember.status === 400, `got ${alreadyMember.status}`);

  console.log('\n--- revoke invitation ---');
  const inviteD = await api.post('/members/invite', { email: DAVE_EMAIL, role: 'org_member' }, orgA.adminToken);
  const inviteDId = inviteD.body.invite.id;
  const revoke = await api.delete(`/members/invitations/${inviteDId}`, orgA.adminToken);
  check('revoke -> 200', revoke.status === 200, `got ${revoke.status}`);
  const revokeAgain = await api.delete(`/members/invitations/${inviteDId}`, orgA.adminToken);
  check('revoke again -> 404', revokeAgain.status === 404, `got ${revokeAgain.status}`);

  console.log('\n--- member capacity limit ---');
  await Organization.updateOne({ _id: orgA.orgId }, { maxMembers: 2 });
  const inviteE = await api.post('/members/invite', { email: EVE_EMAIL, role: 'org_member' }, orgA.adminToken);
  const tokenE = inviteE.body.invite.url.split('token=')[1];
  const limitJoin = await api.post('/auth/join', { token: tokenE, name: 'Eve Limiter', password: 'Passw0rd!123' });
  check('join over maxMembers -> 400', limitJoin.status === 400, `got ${limitJoin.status} ${JSON.stringify(limitJoin.body)}`);
  const eveInA = await User.findOne({ email: EVE_EMAIL });
  check('eve not created (capacity guard)', !eveInA);

  console.log('\n--- remove flow ---');
  const removeZed = await api.delete(`/members/${zedId}`, orgA.adminToken);
  check('remove zed -> 200', removeZed.status === 200, `got ${removeZed.status}`);
  const zedGone = await User.findById(zedId);
  check('zed removed from DB', !zedGone);
  const removeSelf = await api.delete(`/members/${listA.body.members[0].id}`, orgA.adminToken);
  check('remove self -> 400', removeSelf.status === 400, `got ${removeSelf.status}`);

  console.log('\n--- auth guards ---');
  const noTokenList = await api.get('/members');
  check('members without session -> 401', noTokenList.status === 401, `got ${noTokenList.status}`);
  const memberInvite = await api.post('/members/invite', { email: 'x@y.com', role: 'org_member' }, zedToken);
  check('org_member invite -> 403', memberInvite.status === 403, `got ${memberInvite.status}`);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error('TEST CRASH:', err);
  await mongoose.disconnect();
  process.exit(1);
});


