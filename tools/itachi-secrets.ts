import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ============ Credentials ============

function loadSupabaseCredentials(): { url: string; key: string } {
    let url = process.env.SUPABASE_URL;
    let key = process.env.SUPABASE_KEY;

    if (!url || !key) {
        const credFile = path.join(require('os').homedir(), '.supabase-credentials');
        if (fs.existsSync(credFile)) {
            const content = fs.readFileSync(credFile, 'utf8');
            const urlMatch = content.match(/SUPABASE_URL=(.+)/);
            const keyMatch = content.match(/SUPABASE_KEY=(.+)/);
            if (urlMatch) url = urlMatch[1].trim();
            if (keyMatch) key = keyMatch[1].trim();
        }
    }

    if (!url || !key) {
        console.error('ERROR: No Supabase credentials found.');
        console.error('Set SUPABASE_URL and SUPABASE_KEY env vars, or create ~/.supabase-credentials');
        process.exit(1);
    }

    return { url, key };
}

function getSupabase(): SupabaseClient {
    const { url, key } = loadSupabaseCredentials();
    return createClient(url, key);
}

// ============ Encryption ============

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12;  // GCM standard
const SALT_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

function encrypt(plaintext: string, passphrase: string): { encrypted: string; salt: string } {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = deriveKey(passphrase, salt);
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Pack: iv + authTag + ciphertext
    const packed = Buffer.concat([iv, authTag, ciphertext]);

    return {
        encrypted: packed.toString('base64'),
        salt: salt.toString('base64'),
    };
}

function decrypt(encryptedBase64: string, saltBase64: string, passphrase: string): string {
    const salt = Buffer.from(saltBase64, 'base64');
    const key = deriveKey(passphrase, salt);
    const packed = Buffer.from(encryptedBase64, 'base64');

    // Unpack: iv (12) + authTag (16) + ciphertext (rest)
    const iv = packed.subarray(0, IV_LENGTH);
    const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    try {
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return plaintext.toString('utf8');
    } catch {
        console.error('ERROR: Decryption failed. Wrong passphrase?');
        process.exit(1);
    }
}

// ============ Interactive Passphrase ============

function askPassphrase(prompt: string): Promise<string> {
    return new Promise((resolve) => {
        // Use raw stdin to hide input
        if (process.stdin.isTTY) {
            process.stdout.write(prompt);
            const rl = readline.createInterface({ input: process.stdin, terminal: false });
            // Disable echo
            process.stdin.setRawMode?.(true);
            let passphrase = '';
            process.stdin.resume();
            process.stdin.on('data', function handler(ch: Buffer) {
                const char = ch.toString('utf8');
                if (char === '\n' || char === '\r' || char === '\u0004') {
                    process.stdin.setRawMode?.(false);
                    process.stdin.removeListener('data', handler);
                    process.stdin.pause();
                    process.stdout.write('\n');
                    rl.close();
                    resolve(passphrase);
                } else if (char === '\u007F' || char === '\b') {
                    // Backspace
                    passphrase = passphrase.slice(0, -1);
                } else if (char === '\u0003') {
                    // Ctrl+C
                    process.exit(0);
                } else {
                    passphrase += char;
                }
            });
        } else {
            // Non-interactive: read from stdin pipe
            const rl = readline.createInterface({ input: process.stdin });
            rl.question(prompt, (answer) => {
                rl.close();
                resolve(answer);
            });
        }
    });
}

// ============ Commands ============

async function cmdPush(name: string, filePath: string, description?: string): Promise<void> {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
        console.error(`ERROR: File not found: ${resolvedPath}`);
        process.exit(1);
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const passphrase = await askPassphrase('Passphrase: ');

    if (!passphrase || passphrase.length < 4) {
        console.error('ERROR: Passphrase too short (min 4 characters)');
        process.exit(1);
    }

    const { encrypted, salt } = encrypt(content, passphrase);
    const deviceName = require('os').hostname();

    const sb = getSupabase();

    // Upsert by name
    const { error } = await sb.from('secrets').upsert(
        {
            name,
            encrypted_data: encrypted,
            salt,
            description: description || `Synced from ${deviceName}`,
            updated_by: deviceName,
            updated_at: new Date().toISOString(),
        },
        { onConflict: 'name' }
    );

    if (error) {
        console.error('ERROR:', error.message);
        process.exit(1);
    }

    console.log(`Pushed "${name}" (${content.length} bytes encrypted)`);
}

async function cmdPull(name: string, outPath?: string): Promise<void> {
    const sb = getSupabase();

    const { data, error } = await sb
        .from('secrets')
        .select('encrypted_data, salt, updated_by, updated_at')
        .eq('name', name)
        .single();

    if (error || !data) {
        console.error(`ERROR: Secret "${name}" not found`);
        process.exit(1);
    }

    const passphrase = await askPassphrase('Passphrase: ');
    const plaintext = decrypt(data.encrypted_data, data.salt, passphrase);

    if (outPath) {
        const resolvedOut = path.resolve(outPath);
        // Create parent dirs if needed
        fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
        fs.writeFileSync(resolvedOut, plaintext, 'utf8');
        console.log(`Pulled "${name}" -> ${resolvedOut} (${plaintext.length} bytes)`);
        console.log(`  Last updated by: ${data.updated_by} at ${data.updated_at}`);
    } else {
        // Print to stdout
        process.stdout.write(plaintext);
    }
}

async function cmdList(): Promise<void> {
    const sb = getSupabase();

    const { data, error } = await sb
        .from('secrets')
        .select('name, description, updated_by, updated_at, created_at')
        .order('updated_at', { ascending: false });

    if (error) {
        console.error('ERROR:', error.message);
        process.exit(1);
    }

    if (!data || data.length === 0) {
        console.log('No secrets stored.');
        return;
    }

    console.log(`\n  Stored secrets (${data.length}):\n`);
    for (const s of data) {
        const age = timeSince(new Date(s.updated_at));
        console.log(`  ${s.name}`);
        console.log(`    ${s.description || '(no description)'}`);
        console.log(`    Updated ${age} by ${s.updated_by || 'unknown'}`);
        console.log('');
    }
}

async function cmdDelete(name: string): Promise<void> {
    const sb = getSupabase();

    const { error } = await sb.from('secrets').delete().eq('name', name);

    if (error) {
        console.error('ERROR:', error.message);
        process.exit(1);
    }

    console.log(`Deleted "${name}"`);
}

// ============ Helpers ============

function timeSince(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function printUsage(): void {
    console.log(`
  itachi-secrets - Encrypted secret sync via Supabase

  Usage:
    itachi-secrets push <name> <file> [description]
    itachi-secrets pull <name> [--out <file>]
    itachi-secrets list
    itachi-secrets delete <name>

  Examples:
    itachi-secrets push orchestrator-env .env
    itachi-secrets pull orchestrator-env --out .env
    itachi-secrets list
    itachi-secrets delete old-secret

  Credentials:
    Set SUPABASE_URL + SUPABASE_KEY env vars,
    or store them in ~/.supabase-credentials
`);
}

// ============ Main ============

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
        case 'push': {
            const name = args[1];
            const file = args[2];
            const desc = args[3];
            if (!name || !file) {
                console.error('Usage: itachi-secrets push <name> <file> [description]');
                process.exit(1);
            }
            await cmdPush(name, file, desc);
            break;
        }
        case 'pull': {
            const name = args[1];
            if (!name) {
                console.error('Usage: itachi-secrets pull <name> [--out <file>]');
                process.exit(1);
            }
            const outIdx = args.indexOf('--out');
            const outPath = outIdx !== -1 ? args[outIdx + 1] : undefined;
            await cmdPull(name, outPath);
            break;
        }
        case 'list':
            await cmdList();
            break;
        case 'delete': {
            const name = args[1];
            if (!name) {
                console.error('Usage: itachi-secrets delete <name>');
                process.exit(1);
            }
            await cmdDelete(name);
            break;
        }
        default:
            printUsage();
            break;
    }
}

main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
