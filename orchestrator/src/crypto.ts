import { pbkdf2Sync, createDecipheriv, createCipheriv, randomBytes, createHash, createHmac } from 'crypto';

export function decrypt(encB64: string, saltB64: string, passphrase: string): string {
    const packed = Buffer.from(encB64, 'base64');
    const salt = Buffer.from(saltB64, 'base64');
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ct = packed.subarray(28);
    const key = pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct, undefined, 'utf8') + decipher.final('utf8');
}

const JWT_TTL_SECONDS = 3600; // 1 hour

function toBase64Url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Issue a short-lived HS256 JWT for internal service authentication.
 * @param secret - Signing secret (ITACHI_API_KEY)
 * @param sub - Subject identifying the token issuer (e.g. 'orchestrator')
 */
export function signJwt(secret: string, sub: string): string {
    const header = toBase64Url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const now = Math.floor(Date.now() / 1000);
    const payload = toBase64Url(Buffer.from(JSON.stringify({ sub, iat: now, exp: now + JWT_TTL_SECONDS })));
    const signingInput = `${header}.${payload}`;
    const signature = toBase64Url(createHmac('sha256', secret).update(signingInput).digest());
    return `${header}.${payload}.${signature}`;
}

export function encrypt(content: string, passphrase: string): { encrypted_data: string; salt: string; content_hash: string } {
    const salt = randomBytes(16);
    const key = pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), ct]);
    const content_hash = createHash('sha256').update(content).digest('hex');
    return {
        encrypted_data: packed.toString('base64'),
        salt: salt.toString('base64'),
        content_hash,
    };
}
