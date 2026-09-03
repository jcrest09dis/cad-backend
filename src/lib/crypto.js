import crypto from 'node:crypto';

/**
 * Field-level encryption for two separate data categories - incident
 * notes (PHI) and TOTP secrets (auth). Kept under genuinely separate
 * keys in both providers below, so compromising one category's key
 * doesn't also expose the other.
 *
 * Two providers, switched by ENCRYPTION_PROVIDER:
 *   'local' (default) - single static AES-256-GCM key per category from
 *     env. Fine for local dev, not for real PHI - no key rotation, no
 *     access auditing, no HSM backing.
 *   'kms' - real AWS KMS envelope encryption: KMS generates a per-record
 *     data key, the data key encrypts the content locally, then the data
 *     key itself is encrypted by KMS and stored alongside the ciphertext.
 *     Decrypt asks KMS to unwrap the data key, then decrypts locally.
 *     Requires `npm install @aws-sdk/client-kms` separately (not a
 *     default dependency, so local-only dev never needs to pull in the
 *     AWS SDK) plus KMS_NOTES_KEY_ID / KMS_AUTH_KEY_ID env vars pointing
 *     at two separate KMS master keys, and AWS credentials resolved the
 *     standard way (env vars, shared config file, or an IAM role).
 */

const PROVIDER = process.env.ENCRYPTION_PROVIDER ?? 'local';

const LOCAL_KEY_ENV = { notes: 'NOTES_ENCRYPTION_KEY', auth: 'AUTH_ENCRYPTION_KEY' };
const KMS_KEY_ENV = { notes: 'KMS_NOTES_KEY_ID', auth: 'KMS_AUTH_KEY_ID' };

function getLocalKey(category) {
  const envVar = LOCAL_KEY_ENV[category];
  const b64 = process.env[envVar];
  if (!b64) {
    throw new Error(
      `${envVar} is not set. Generate one with: ` +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  return Buffer.from(b64, 'base64');
}

function localEncrypt(plaintext, category) {
  const key = getLocalKey(category);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([iv, authTag, encrypted]),
    keyId: `local-${category}-v1`,
    dataKeyCiphertext: null,
  };
}

function localDecrypt(ciphertextBuf, category) {
  const key = getLocalKey(category);
  const iv = ciphertextBuf.subarray(0, 12);
  const authTag = ciphertextBuf.subarray(12, 28);
  const encrypted = ciphertextBuf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// Lazy-imported so @aws-sdk/client-kms is only required when KMS mode is
// actually used - local dev (the default) never needs it installed.
let kmsClientPromise = null;
async function getKmsClient() {
  if (!kmsClientPromise) {
    kmsClientPromise = import('@aws-sdk/client-kms').then(
      ({ KMSClient }) => new KMSClient({}) // region/credentials via standard AWS resolution (env, config file, or IAM role)
    );
  }
  return kmsClientPromise;
}

async function kmsEncrypt(plaintext, category) {
  const envVar = KMS_KEY_ENV[category];
  const keyId = process.env[envVar];
  if (!keyId) throw new Error(`${envVar} is not set - required when ENCRYPTION_PROVIDER=kms.`);

  const { GenerateDataKeyCommand } = await import('@aws-sdk/client-kms');
  const client = await getKmsClient();
  const result = await client.send(new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: 'AES_256' }));

  const dataKeyPlaintext = Buffer.from(result.Plaintext);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKeyPlaintext, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  dataKeyPlaintext.fill(0); // scrub the plaintext data key from memory as soon as we're done with it

  return {
    ciphertext: Buffer.concat([iv, authTag, encrypted]),
    keyId,
    dataKeyCiphertext: Buffer.from(result.CiphertextBlob),
  };
}

async function kmsDecrypt(ciphertextBuf, dataKeyCiphertext) {
  const { DecryptCommand } = await import('@aws-sdk/client-kms');
  const client = await getKmsClient();
  const result = await client.send(new DecryptCommand({ CiphertextBlob: dataKeyCiphertext }));

  const dataKeyPlaintext = Buffer.from(result.Plaintext);
  const iv = ciphertextBuf.subarray(0, 12);
  const authTag = ciphertextBuf.subarray(12, 28);
  const encrypted = ciphertextBuf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKeyPlaintext, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  dataKeyPlaintext.fill(0);
  return plaintext;
}

/**
 * Encrypts a field. Returns { ciphertext, keyId, dataKeyCiphertext }.
 * dataKeyCiphertext is null in local mode (nothing to store), a Buffer
 * in KMS mode (store it alongside ciphertext/keyId - needed to decrypt).
 */
export async function encryptField(plaintext, category) {
  if (PROVIDER === 'kms') return kmsEncrypt(plaintext, category);
  if (PROVIDER === 'local') return localEncrypt(plaintext, category);
  throw new Error(`Unknown ENCRYPTION_PROVIDER: ${PROVIDER}`);
}

/**
 * Decrypts a field. dataKeyCiphertext is ignored in local mode (pass
 * null/whatever's stored - local mode doesn't use it), required in KMS
 * mode.
 */
export async function decryptField(ciphertextBuf, keyId, dataKeyCiphertext, category) {
  if (PROVIDER === 'kms') return kmsDecrypt(ciphertextBuf, dataKeyCiphertext);
  if (PROVIDER === 'local') return localDecrypt(ciphertextBuf, category);
  throw new Error(`Unknown ENCRYPTION_PROVIDER: ${PROVIDER}`);
}

export const encryptNote = (plaintext) => encryptField(plaintext, 'notes');
export const decryptNote = (ciphertextBuf, keyId, dataKeyCiphertext) =>
  decryptField(ciphertextBuf, keyId, dataKeyCiphertext, 'notes');
