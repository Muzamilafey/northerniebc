/**
 * Creates the first SUPER_ADMIN interactively-free from environment variables:
 *   ADMIN_EMAIL=… ADMIN_NAME=… ADMIN_PASSWORD=… npm run user:create-admin
 * The account must enrol MFA on first login before privileged actions are allowed.
 */
import { connectMongo, disconnectMongo, withTransaction } from '../db/mongo.js';
import { recordAudit } from '../lib/audit.js';
import { User } from '../models/index.js';
import { hashPassword, passwordProblems } from '../modules/auth/password.js';

const email = process.env.ADMIN_EMAIL;
const name = process.env.ADMIN_NAME;
const password = process.env.ADMIN_PASSWORD;
if (!email || !name || !password) {
  console.error('Set ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD');
  process.exit(1);
}
const problems = passwordProblems(password, [name, email.split('@')[0]!]);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
await connectMongo();
if (await User.exists({ email: email.toLowerCase() })) {
  console.error('User already exists');
  process.exit(1);
}
await withTransaction(async (s) => {
  const [u] = await User.create([{ fullName: name, email, passwordHash: await hashPassword(password), role: 'SUPER_ADMIN', mustChangePassword: false }], { session: s });
  await recordAudit(s, { actor: { label: 'cli:create-admin' }, action: 'user.created', entityType: 'User', entityId: String(u!._id), after: { role: 'SUPER_ADMIN', email } });
});
console.log(`Super administrator ${email} created. Sign in and enrol MFA.`);
await disconnectMongo();
