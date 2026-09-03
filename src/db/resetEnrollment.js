import { pool } from './pool.js';
import { generateTotpSecret, provisioningUri } from '../lib/totp.js';
import { encryptField } from '../lib/crypto.js';

/**
 * Recovery tool for exactly the situation that motivated this: an
 * encryption key got lost/rotated and the affected staff member can no
 * longer log in to fix it themselves - including if they're the only
 * admin, which would otherwise be a dead end (re-enrolling requires an
 * admin JWT, but they can't get one without logging in first).
 *
 * Runs directly against the database, like seedAdmin.js - never over
 * HTTP, so it doesn't depend on anyone being able to log in already.
 * Whoever can run this has server/database access, which is the actual
 * trust boundary here, same as the seed-admin bootstrap.
 *
 * Usage: node src/db/resetEnrollment.js <username>
 */
async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error('Usage: node src/db/resetEnrollment.js <username>');
    process.exit(1);
  }

  const { rows } = await pool.query(`SELECT id FROM staff WHERE username = $1`, [username]);
  if (rows.length === 0) {
    console.error(`No staff record found with username "${username}".`);
    process.exit(1);
  }

  const secret = generateTotpSecret();
  const { ciphertext, keyId, dataKeyCiphertext } = await encryptField(secret, 'auth');

  await pool.query(
    `UPDATE staff
     SET totp_secret_ciphertext = $1, totp_secret_key_id = $2,
         totp_secret_data_key_ciphertext = $3, totp_enabled = FALSE, totp_last_step = NULL
     WHERE id = $4`,
    [ciphertext, keyId, dataKeyCiphertext, rows[0].id]
  );

  console.log(
    `\nReset TOTP enrollment for "${username}".\n` +
    `Scan this into an authenticator app, then confirm via POST /auth/enroll/confirm:\n` +
    `  Secret: ${secret}\n` +
    `  URI:    ${provisioningUri(secret, { label: username })}\n` +
    'This is only shown once - it is not stored anywhere in plaintext.\n'
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
