import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_HEX = /^[0-9a-fA-F]{64}$/;
const BASE64_SEGMENT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CONFIGURATION_ERROR = 'Token envelope crypto configuration is invalid';
const DECRYPTION_ERROR = 'Token envelope decryption failed';

function tokenEnvelopeKey(): Buffer {
  const hex = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  if (typeof hex !== 'string' || !KEY_HEX.test(hex)) {
    throw new Error(CONFIGURATION_ERROR);
  }
  return Buffer.from(hex, 'hex');
}

function decryptionError(): Error {
  return new Error(DECRYPTION_ERROR);
}

function decodeBase64Segment(segment: string, expectedBytes?: number): Buffer {
  if (!BASE64_SEGMENT.test(segment)) {
    throw decryptionError();
  }

  const decoded = Buffer.from(segment, 'base64');
  if (decoded.toString('base64') !== segment) {
    throw decryptionError();
  }
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw decryptionError();
  }
  return decoded;
}

function parseEnvelope(payload: string): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const segments = payload.split('.');
  if (segments.length !== 3 || segments[0].length === 0 || segments[1].length === 0) {
    throw decryptionError();
  }

  return {
    iv: decodeBase64Segment(segments[0], 12),
    tag: decodeBase64Segment(segments[1], 16),
    ciphertext: decodeBase64Segment(segments[2]),
  };
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenEnvelopeKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
}

export function decrypt(payload: string): string {
  let envelope: { iv: Buffer; tag: Buffer; ciphertext: Buffer };
  try {
    envelope = parseEnvelope(payload);
  } catch {
    throw decryptionError();
  }

  const key = tokenEnvelopeKey();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.iv);
    decipher.setAuthTag(envelope.tag);
    return Buffer.concat([
      decipher.update(envelope.ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw decryptionError();
  }
}
