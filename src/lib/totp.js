import crypto from 'node:crypto';
import { base32Encode, base32Decode } from './base32.js';

const STEP_SECONDS = 30;
const DIGITS = 6;

export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160-bit, standard TOTP secret size
}

/**
 * otpauth:// URI for QR-code enrollment in Google Authenticator, Authy, etc.
 * label should be something identifying the staff member; issuer is the app name.
 */
export function provisioningUri(secret, { label, issuer = 'CAD' }) {
  const encodedLabel = encodeURIComponent(`${issuer}:${label}`);
  const encodedIssuer = encodeURIComponent(issuer);
  return `otpauth://totp/${encodedLabel}?secret=${secret}&issuer=${encodedIssuer}&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

function hotp(secretBuffer, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', secretBuffer).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binCode % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Verifies a 6-digit code against the secret, tolerating +/- 1 step
 * (30s each side) for clock drift between the phone and the server.
 */
/**
 * Verifies a 6-digit code against the secret, tolerating +/- 1 step
 * (30s each side) for clock drift between the phone and the server.
 * Returns the matched step (for replay-protection bookkeeping by the
 * caller) or null if no match.
 */
export function verifyTotpWithStep(secretBase32, token, { windowSteps = 1 } = {}) {
  if (!/^\d{6}$/.test(token)) return null;
  const secretBuffer = base32Decode(secretBase32);
  const currentStep = Math.floor(Date.now() / 1000 / STEP_SECONDS);

  for (let errorWindow = -windowSteps; errorWindow <= windowSteps; errorWindow++) {
    const step = currentStep + errorWindow;
    if (hotp(secretBuffer, step) === token) {
      return step;
    }
  }
  return null;
}

export function verifyTotp(secretBase32, token, opts) {
  return verifyTotpWithStep(secretBase32, token, opts) !== null;
}
