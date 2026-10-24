import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

export const ROLES = [
  'SUPER_ADMIN',
  'REGIONAL_ADMIN',
  'COUNTY_ADMIN',
  'CONSTITUENCY_SUPERVISOR',
  'VERIFICATION_OFFICER',
  'FINANCE_OFFICER',
  'AGENT'
] as const;
export type Role = (typeof ROLES)[number];

/** Every role except AGENT is privileged and requires MFA when REQUIRE_MFA_FOR_PRIVILEGED is on. */
export const PRIVILEGED_ROLES: Role[] = ROLES.filter((r) => r !== 'AGENT');

const userSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 200 },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    /** Encrypted at rest. */
    phoneEnc: { type: String },
    phoneVerified: { type: Boolean, default: false },
    emailVerified: { type: Boolean, default: false },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true, index: true },
    /** Agent identifier printed on credentials, e.g. AGT-7K3Q9P2M. */
    agentCode: { type: String, unique: true, sparse: true },
    /** Geographic scope for scoped roles. Empty arrays mean "no access" except for SUPER/REGIONAL. */
    scope: {
      countyIds: [{ type: Schema.Types.ObjectId, ref: 'County' }],
      constituencyIds: [{ type: Schema.Types.ObjectId, ref: 'Constituency' }]
    },
    status: { type: String, enum: ['ACTIVE', 'SUSPENDED', 'REVOKED'], default: 'ACTIVE', index: true },
    mfa: {
      enabled: { type: Boolean, default: false },
      secretEnc: { type: String, select: false },
      pendingSecretEnc: { type: String, select: false },
      recoveryCodeHashes: { type: [String], select: false, default: [] }
    },
    mustChangePassword: { type: Boolean, default: true },
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date },
    lastLoginAt: { type: Date },
    lastLoginIp: { type: String },
    passwordChangedAt: { type: Date },
    resetTokenHash: { type: String, select: false },
    resetTokenExpiresAt: { type: Date, select: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const User = model('User', userSchema);

/** One row per refresh-token family (login). Rotation keeps the family; reuse revokes it. */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    familyId: { type: String, required: true, unique: true },
    currentTokenHash: { type: String, required: true },
    previousTokenHashes: { type: [String], default: [] },
    mfaVerified: { type: Boolean, default: false },
    userAgent: { type: String, maxlength: 300 },
    ip: { type: String },
    lastUsedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    revokedReason: { type: String }
  },
  { timestamps: true }
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
export const Session = model('Session', sessionSchema);
