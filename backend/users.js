const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const sgMail = require('@sendgrid/mail');

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, default: '' },
  name: { type: String, default: '' },
  role: { type: String, enum: ['superadmin', 'user'], default: 'user' },
  status: { type: String, enum: ['invited', 'active', 'disabled'], default: 'invited' },
  credits: { type: Number, default: 0, min: 0 },
  avatarUrl: { type: String, default: '' },
  capturePasswordHash: { type: String, default: '' },
  inviteTokenHash: { type: String, default: '' },
  inviteExpiresAt: { type: Date },
  resetTokenHash: { type: String, default: '' },
  resetExpiresAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  lastLoginAt: { type: Date }
});

const creditLedgerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  delta: { type: Number, required: true },
  balanceAfter: { type: Number, required: true },
  reason: {
    type: String,
    enum: ['invite_grant', 'admin_adjust', 'generation'],
    required: true
  },
  submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission' },
  note: { type: String, default: '' },
  createdBy: { type: String, default: 'system' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const CreditLedger = mongoose.model('CreditLedger', creditLedgerSchema);

function isAdminPanelRole(role) {
  return role === 'admin' || role === 'superadmin' || role === 'user';
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function bootstrapSuperadmin() {
  const email = normalizeEmail(process.env.SUPERADMIN_EMAIL);
  const password = process.env.SUPERADMIN_PASSWORD;
  if (!email || !password) {
    console.log('ℹ️  SUPERADMIN_EMAIL/PASSWORD not set — skip bootstrap');
    return null;
  }

  let user = await User.findOne({ email });
  if (user) return user;

  const existingSuper = await User.findOne({ role: 'superadmin' });
  if (existingSuper) return existingSuper;

  user = await User.create({
    email,
    passwordHash: await bcrypt.hash(password, 10),
    name: process.env.SUPERADMIN_NAME || 'Super Admin',
    role: 'superadmin',
    status: 'active',
    credits: parseInt(process.env.SUPERADMIN_CREDITS || '10000', 10) || 10000
  });
  console.log(`✅ Bootstrapped superadmin: ${email}`);
  return user;
}

async function migrateOwnerIds(Event, Submission, Preset) {
  const owner = await User.findOne({ role: 'superadmin', status: 'active' }).sort({ createdAt: 1 });
  if (!owner) {
    console.log('ℹ️  No superadmin for ownerId migration');
    return null;
  }

  const ownerFilter = { $or: [{ ownerId: { $exists: false } }, { ownerId: null }] };
  const e1 = await Event.updateMany(ownerFilter, { $set: { ownerId: owner._id } });
  const s1 = await Submission.updateMany(ownerFilter, { $set: { ownerId: owner._id } });
  const p1 = await Preset.updateMany(ownerFilter, { $set: { ownerId: owner._id } });

  try {
    await Preset.collection.dropIndex('name_1');
    console.log('✅ Dropped legacy Preset.name unique index');
  } catch (_) {
    // Index may not exist
  }

  console.log(
    `✅ ownerId migration: events=${e1.modifiedCount}, submissions=${s1.modifiedCount}, presets=${p1.modifiedCount} → ${owner.email}`
  );
  return owner;
}

async function spendCreditForGeneration(userId, submissionId, createdBy = 'system') {
  const user = await User.findOneAndUpdate(
    { _id: userId, credits: { $gte: 1 }, status: 'active' },
    { $inc: { credits: -1 } },
    { new: true }
  );

  if (!user) {
    const existing = await User.findById(userId).select('credits status');
    const err = new Error(
      !existing || existing.status !== 'active'
        ? 'Account is not active'
        : 'Insufficient credits'
    );
    err.code = 'INSUFFICIENT_CREDITS';
    err.statusCode = 402;
    throw err;
  }

  await CreditLedger.create({
    userId,
    delta: -1,
    balanceAfter: user.credits,
    reason: 'generation',
    submissionId: submissionId || undefined,
    createdBy: String(createdBy)
  });

  return user;
}

async function adjustCredits(userId, delta, { note = '', createdBy = 'system', reason = 'admin_adjust' } = {}) {
  const amount = Number(delta);
  if (!Number.isFinite(amount) || amount === 0) {
    const err = new Error('delta must be a non-zero number');
    err.statusCode = 400;
    throw err;
  }

  if (amount < 0) {
    const user = await User.findOneAndUpdate(
      { _id: userId, credits: { $gte: Math.abs(amount) } },
      { $inc: { credits: amount } },
      { new: true }
    );
    if (!user) {
      const err = new Error('Insufficient credits for adjustment');
      err.statusCode = 400;
      throw err;
    }
    await CreditLedger.create({
      userId,
      delta: amount,
      balanceAfter: user.credits,
      reason,
      note,
      createdBy: String(createdBy)
    });
    return user;
  }

  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { credits: amount } },
    { new: true }
  );
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  await CreditLedger.create({
    userId,
    delta: amount,
    balanceAfter: user.credits,
    reason,
    note,
    createdBy: String(createdBy)
  });
  return user;
}

function createInviteToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenHash: hashToken(token) };
}

async function sendInviteEmail(user, rawToken) {
  if (!process.env.SENDGRID_API_KEY) {
    console.warn('📧 Invite email skipped (no SENDGRID_API_KEY)');
    return { sent: false, reason: 'No SendGrid API key' };
  }

  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const inviteUrl = `${baseUrl}/accept-invite.html?token=${encodeURIComponent(rawToken)}`;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL;
  if (!fromEmail) {
    return { sent: false, reason: 'No SENDGRID_FROM_EMAIL' };
  }

  const msg = {
    to: user.email,
    from: {
      email: fromEmail,
      name: process.env.SENDGRID_FROM_NAME || 'Lumetry Stickers'
    },
    subject: 'You are invited to Lumetry Stickers',
    html: `
      <p>Hi${user.name ? ` ${user.name}` : ''},</p>
      <p>You have been invited to use Lumetry Stickers. Click the link below to set your password and activate your account:</p>
      <p><a href="${inviteUrl}">${inviteUrl}</a></p>
      <p>This link expires in 7 days.</p>
    `,
    text: `You have been invited to Lumetry Stickers. Set your password: ${inviteUrl}`
  };

  try {
    await sgMail.send(msg);
    console.log(`📧 Invite sent to ${user.email}`);
    return { sent: true, to: user.email, inviteUrl };
  } catch (error) {
    console.error('📧 Invite email error:', error.message);
    return { sent: false, error: error.message, inviteUrl };
  }
}

async function sendPasswordResetEmail(user, rawToken) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const resetUrl = `${baseUrl}/reset-password.html?token=${encodeURIComponent(rawToken)}`;

  if (!process.env.SENDGRID_API_KEY) {
    console.warn('📧 Password reset email skipped (no SENDGRID_API_KEY)');
    return { sent: false, reason: 'No SendGrid API key', resetUrl };
  }

  const fromEmail = process.env.SENDGRID_FROM_EMAIL;
  if (!fromEmail) {
    return { sent: false, reason: 'No SENDGRID_FROM_EMAIL', resetUrl };
  }

  const msg = {
    to: user.email,
    from: {
      email: fromEmail,
      name: process.env.SENDGRID_FROM_NAME || 'Lumetry Stickers'
    },
    subject: 'Reset your Lumetry Stickers password',
    html: `
      <p>Hi${user.name ? ` ${user.name}` : ''},</p>
      <p>A superadmin requested a password reset for your Lumetry Stickers account. Click the link below to choose a new password:</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>This link expires in 24 hours. If you did not expect this, you can ignore the email and keep using your current password.</p>
    `,
    text: `Reset your Lumetry Stickers password: ${resetUrl}`
  };

  try {
    await sgMail.send(msg);
    console.log(`📧 Password reset sent to ${user.email}`);
    return { sent: true, to: user.email, resetUrl };
  } catch (error) {
    console.error('📧 Password reset email error:', error.message);
    return { sent: false, error: error.message, resetUrl };
  }
}

function publicUser(user) {
  if (!user) return null;
  const obj = user.toObject ? user.toObject() : user;
  return {
    _id: obj._id,
    email: obj.email,
    name: obj.name || '',
    role: obj.role,
    status: obj.status,
    credits: obj.credits || 0,
    avatarUrl: obj.avatarUrl || '',
    hasCapturePassword: Boolean(obj.capturePasswordHash),
    createdAt: obj.createdAt,
    lastLoginAt: obj.lastLoginAt || null,
    inviteExpiresAt: obj.inviteExpiresAt || null
  };
}

module.exports = {
  User,
  CreditLedger,
  isAdminPanelRole,
  normalizeEmail,
  hashToken,
  bootstrapSuperadmin,
  migrateOwnerIds,
  spendCreditForGeneration,
  adjustCredits,
  createInviteToken,
  sendInviteEmail,
  sendPasswordResetEmail,
  publicUser,
  bcrypt
};
