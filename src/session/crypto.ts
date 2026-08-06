import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const SALT_LEN = 16;
const IV_LEN = 12;
const KEY_LEN = 32;
const ITERATIONS = 100000;

/** 加密 JSON 数据为 base64 字符串 */
export function encrypt(data: unknown, key: Buffer): string {
  const json = JSON.stringify(data);
  const salt = randomBytes(SALT_LEN);
  const derivedKey = pbkdf2Sync(key, salt, ITERATIONS, KEY_LEN, 'sha256');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, encrypted, authTag]).toString('base64');
}

/** 解密 base64 字符串为 JSON 数据 */
export function decrypt<T = unknown>(encryptedBase64: string, key: Buffer): T {
  const buf = Buffer.from(encryptedBase64, 'base64');
  const salt = buf.subarray(0, SALT_LEN);
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const authTag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(SALT_LEN + IV_LEN, buf.length - 16);
  const derivedKey = pbkdf2Sync(key, salt, ITERATIONS, KEY_LEN, 'sha256');
  const decipher = createDecipheriv(ALGO, derivedKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as T;
}

/** 生成随机 salt */
export function generateSalt(): string {
  return randomBytes(SALT_LEN).toString('base64');
}

/** 用主密钥 + salt 派生密钥并加密验证 token */
export function createVerifyToken(key: Buffer, salt: string): string {
  const saltBuf = Buffer.from(salt, 'base64');
  const derivedKey = pbkdf2Sync(key, saltBuf, ITERATIONS, KEY_LEN, 'sha256');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, derivedKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify('LOOP_AGENT_KEY_VERIFY'), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([saltBuf, iv, encrypted, authTag]).toString('base64');
}

/** 验证密钥是否正确（解密验证 token） */
export function verifyKey(key: Buffer, salt: string, verifyToken: string): boolean {
  try {
    decrypt(verifyToken, key);
    return true;
  } catch {
    return false;
  }
}
