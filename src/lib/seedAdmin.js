import { pool } from '../db/pool.js';
import { generateTotpSecret, provisioningUri } from './totp.js';
import { encryptField } from './crypto.js';

/**
 * Solves the chicken-and-egg problem left by removing the shared
 * bootstrap secret: something has to be able to create the first admin,
 * but every admin-creating endpoint now requires an admin to already
 * exist. Rather than route around that with another HTTP-reachable
 * secret, this runs once at server startup, driven by config the
 * deployer controls directly (SEED_ADMIN_USERNAME) - it can't be
 * triggered remotely at all, which is the actual point of retiring the
 * old mechanism.
 *
 * No-ops if an admin already exists. If SEED_ADMIN_USERNAME names an
 * existing staff record, that record is promoted to admin. If it names
 * nobody, a new staff/admin record is created and its TOTP secret is
 * printed to the server log once (not stored in plaintext anywhere) -
 * the deployer still has to complete /auth/enroll/confirm with a live
 * code afterward, same as any other enrollment.
 */
export async function seedFirstAdminIfNeeded() {
  const { rows: existingAdmins } = await pool.query(`SELECT id FROM staff WHERE is_admin = TRUE LIMIT 1`);
  if (existingAdmins.length > 0) return; // already bootstrapped, nothing to do

  const username = process.env.SEED_ADMIN_USERNAME;
  if (!username) {
    console.warn(
      '[seed-admin] No admin exists yet and SEED_ADMIN_USERNAME is not set. ' +
      'Set it in .env and restart to create/promote the first admin.'
    );
    return;
  }

  const { rows: existingStaff } = await pool.query(`SELECT id FROM staff WHERE username = $1`, [username]);

  if (existingStaff.length > 0) {
    await pool.query(`UPDATE staff SET is_admin = TRUE WHERE id = $1`, [existingStaff[0].id]);
    console.log(`[seed-admin] Promoted existing staff "${username}" to admin.`);
    return;
  }

  const secret = generateTotpSecret();
  const { ciphertext, keyId, dataKeyCiphertext } = await encryptField(secret, 'auth');

  await pool.query(
    `INSERT INTO staff (name, role, username, is_admin, active,
                         totp_secret_ciphertext, totp_secret_key_id, totp_secret_data_key_ciphertext,
                         totp_enabled)
     VALUES ($1, 'admin', $2, TRUE, TRUE, $3, $4, $5, FALSE)`,
    [username, username, ciphertext, keyId, dataKeyCiphertext]
  );

  console.log(
    `\n[seed-admin] Created first admin "${username}".\n` +
    `Scan this into an authenticator app, then confirm via POST /auth/enroll/confirm:\n` +
    `  Secret: ${secret}\n` +
    `  URI:    ${provisioningUri(secret, { label: username })}\n` +
    'This is only shown once - it is not stored anywhere in plaintext.\n'
  );
}
