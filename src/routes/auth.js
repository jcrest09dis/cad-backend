import { pool } from '../db/pool.js';
import { generateTotpSecret, provisioningUri, verifyTotp, verifyTotpWithStep } from '../lib/totp.js';
import { encryptField, decryptField } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { requireAuth, requireGlobalAdmin } from '../middleware/auth.js';

/**
 * Enrollment now requires a real admin (staff.is_admin = true) rather
 * than a shared bootstrap secret. The very first admin is seeded outside
 * the HTTP layer entirely - see lib/seedAdmin.js, run at server startup.
 */

export default async function authRoutes(fastify) {
  // Step 1: admin generates a TOTP secret for a staff member. Returned
  // once - the provisioning URI is what gets turned into a QR code for
  // the staffer to scan into Google Authenticator / Authy / etc.
  fastify.post(
    '/auth/enroll',
    { preHandler: [requireAuth, requireGlobalAdmin] },
    async (request, reply) => {
      const { staffId } = request.body;

      const { rows } = await pool.query(`SELECT username FROM staff WHERE id = $1`, [staffId]);
      if (rows.length === 0) {
        reply.code(404).send({ error: 'staff not found' });
        return;
      }
      if (!rows[0].username) {
        reply.code(400).send({ error: 'staff record needs a username set before enrollment' });
        return;
      }

      const secret = generateTotpSecret();
      const { ciphertext, keyId, dataKeyCiphertext } = await encryptField(secret, 'auth');

      await pool.query(
        `UPDATE staff SET totp_secret_ciphertext = $1, totp_secret_key_id = $2,
                totp_secret_data_key_ciphertext = $3, totp_enabled = FALSE
         WHERE id = $4`,
        [ciphertext, keyId, dataKeyCiphertext, staffId]
      );

      reply.send({
        secret, // shown once for manual entry fallback
        provisioningUri: provisioningUri(secret, { label: rows[0].username }),
      });
    }
  );

  // Step 2: staffer proves they scanned it correctly before it's trusted
  // for real login. Prevents a bad/mistyped enrollment from silently
  // locking someone out later.
  fastify.post('/auth/enroll/confirm', async (request, reply) => {
    const { username, totpCode } = request.body;

    const { rows } = await pool.query(
      `SELECT id, totp_secret_ciphertext, totp_secret_key_id, totp_secret_data_key_ciphertext
       FROM staff WHERE username = $1`,
      [username]
    );
    if (rows.length === 0 || !rows[0].totp_secret_ciphertext) {
      reply.code(401).send({ error: 'invalid username or not enrolled' });
      return;
    }

    let secret;
    try {
      secret = await decryptField(
        rows[0].totp_secret_ciphertext,
        rows[0].totp_secret_key_id,
        rows[0].totp_secret_data_key_ciphertext,
        'auth'
      );
    } catch (err) {
      request.log.error({ err, staffId: rows[0].id }, 'TOTP secret decrypt failed during enroll confirm');
      reply.code(401).send({ error: 'invalid code' });
      return;
    }
    if (!verifyTotp(secret, totpCode)) {
      reply.code(401).send({ error: 'invalid code' });
      return;
    }

    await pool.query(`UPDATE staff SET totp_enabled = TRUE WHERE id = $1`, [rows[0].id]);
    reply.send({ confirmed: true });
  });

  // Login: username + current 6-digit code -> JWT.
  fastify.post('/auth/login', async (request, reply) => {
    const { username, totpCode } = request.body;

    const { rows } = await pool.query(
      `SELECT id, totp_secret_ciphertext, totp_secret_key_id, totp_secret_data_key_ciphertext,
              totp_enabled, totp_last_step, active
       FROM staff WHERE username = $1`,
      [username]
    );
    if (rows.length === 0 || !rows[0].totp_enabled || !rows[0].active) {
      reply.code(401).send({ error: 'invalid credentials' });
      return;
    }

    let secret;
    try {
      secret = await decryptField(
        rows[0].totp_secret_ciphertext,
        rows[0].totp_secret_key_id,
        rows[0].totp_secret_data_key_ciphertext,
        'auth'
      );
    } catch (err) {
      // A decrypt failure here almost always means the encryption key
      // changed since this secret was enrolled (e.g. AUTH_ENCRYPTION_KEY
      // rotated or was split out from a previously-shared key) - it's a
      // real "this account can't log in" situation, not a server bug, so
      // it should fail cleanly as invalid credentials rather than crash
      // the request. Logged server-side so it's diagnosable without
      // leaking anything to the client.
      request.log.error({ err, staffId: rows[0].id }, 'TOTP secret decrypt failed during login');
      reply.code(401).send({ error: 'invalid credentials' });
      return;
    }
    const matchedStep = verifyTotpWithStep(secret, totpCode);

    // Reject reuse of a code within the same (or an already-consumed) step -
    // closes the window where a captured code could be replayed while
    // still valid.
    if (matchedStep === null || (rows[0].totp_last_step !== null && matchedStep <= rows[0].totp_last_step)) {
      await audit(null, {
        actorId: rows[0].id,
        action: 'auth.login.failed',
        entityType: 'staff',
        entityId: rows[0].id,
      });
      reply.code(401).send({ error: 'invalid credentials' });
      return;
    }

    await pool.query(`UPDATE staff SET totp_last_step = $1 WHERE id = $2`, [matchedStep, rows[0].id]);

    const token = fastify.jwt.sign({ staffId: rows[0].id }, { expiresIn: '12h' });

    await audit(null, {
      actorId: rows[0].id,
      action: 'auth.login.success',
      entityType: 'staff',
      entityId: rows[0].id,
    });

    reply.send({ token });
  });
}
