#!/bin/bash
# Itachi Memory - Daily Skill Sync
# Bidirectional sync of ~/.claude/skills/ and ~/.claude/commands/ with remote _global repo
# Runs as a cron job daily at 3:00 AM
# Silent — never blocks anything, logs to ~/.claude/.skill-sync.log

SYNC_API="${ITACHI_API_URL:-http://swoo0o4okwk8ocww4g4ks084.77.42.84.38.sslip.io}/api/sync"
ITACHI_KEY_FILE="$HOME/.itachi-key"
CLAUDE_DIR="$HOME/.claude"

# Exit silently if no passphrase
if [ ! -f "$ITACHI_KEY_FILE" ]; then
    exit 0
fi

node -e "
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');

const keyFile = process.argv[1];
const syncApi = process.argv[2];
const claudeDir = process.argv[3];

const repoName = '_global';

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? https : http;
        mod.get(u, { rejectUnauthorized: false, timeout: 30000, headers: { 'Authorization': 'Bearer ' + (process.env.ITACHI_API_KEY || '') } }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 400) reject(new Error('HTTP ' + res.statusCode + ': ' + d));
                else resolve(JSON.parse(d));
            });
        }).on('error', reject);
    });
}

function httpPost(url, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? https : http;
        const data = JSON.stringify(body);
        const req = mod.request(u, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Authorization': 'Bearer ' + (process.env.ITACHI_API_KEY || '') },
            timeout: 30000,
            rejectUnauthorized: false
        }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 400) reject(new Error('HTTP ' + res.statusCode + ': ' + d));
                else resolve(JSON.parse(d));
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function encrypt(content, passphrase) {
    const salt = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), ct]);
    return { encrypted_data: packed.toString('base64'), salt: salt.toString('base64') };
}

function decrypt(encB64, saltB64, passphrase) {
    const packed = Buffer.from(encB64, 'base64');
    const salt = Buffer.from(saltB64, 'base64');
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ct = packed.subarray(28);
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct, null, 'utf8') + decipher.final('utf8');
}

function walkDir(dir, baseDir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        // Follow symlinks — resolve to real file
        let stat;
        try {
            const realPath = fs.realpathSync(fullPath);
            stat = fs.statSync(realPath);
        } catch (e) {
            continue; // skip broken symlinks
        }
        if (stat.isDirectory()) {
            results.push(...walkDir(fullPath, baseDir));
        } else if (stat.isFile()) {
            const relativePath = path.relative(baseDir, fullPath).replace(/\\\\/g, '/');
            results.push({ fullPath: fs.realpathSync(fullPath), relativePath });
        }
    }
    return results;
}

(async () => {
    const errors = [];
    let pushed = 0;
    let pulled = 0;

    try {
        const passphrase = fs.readFileSync(keyFile, 'utf8').trim();

        // Step 1: Get remote file list
        let remoteMap = {};
        try {
            const list = await httpGet(syncApi + '/list/' + encodeURIComponent(repoName));
            if (list.files) {
                for (const f of list.files) {
                    remoteMap[f.file_path] = { content_hash: f.content_hash, version: f.version };
                }
            }
        } catch (e) {
            errors.push('Failed to fetch remote list: ' + e.message);
            const ts = new Date().toISOString();
            console.log('[' + ts + '] SKILL SYNC ERROR: ' + errors.join('; '));
            process.exit(0);
        }

        const seen = new Set();

        // Step 2: Scan local skills and commands
        const skillsDir = path.join(claudeDir, 'skills');
        const commandsDir = path.join(claudeDir, 'commands');

        const localFiles = [];

        // Walk skills/
        for (const item of walkDir(skillsDir, skillsDir)) {
            localFiles.push({
                fullPath: item.fullPath,
                syncPath: 'skills/' + item.relativePath
            });
        }

        // Walk commands/
        for (const item of walkDir(commandsDir, commandsDir)) {
            localFiles.push({
                fullPath: item.fullPath,
                syncPath: 'commands/' + item.relativePath
            });
        }

        // Step 3: Push new/changed local files
        for (const file of localFiles) {
            try {
                const content = fs.readFileSync(file.fullPath, 'utf8');
                const hash = crypto.createHash('sha256').update(content).digest('hex');
                seen.add(file.syncPath);

                const remote = remoteMap[file.syncPath];
                if (remote && remote.content_hash === hash) continue; // unchanged

                // Push
                const enc = encrypt(content, passphrase);
                await httpPost(syncApi + '/push', {
                    repo_name: repoName,
                    file_path: file.syncPath,
                    encrypted_data: enc.encrypted_data,
                    salt: enc.salt,
                    content_hash: hash,
                    updated_by: os.hostname()
                });
                pushed++;
            } catch (e) {
                errors.push('Push ' + file.syncPath + ': ' + e.message);
            }
        }

        // Step 4: Pull missing remote files
        for (const [filePath, info] of Object.entries(remoteMap)) {
            if (seen.has(filePath)) continue;

            try {
                const fileData = await httpGet(syncApi + '/pull/' + encodeURIComponent(repoName) + '/' + filePath);
                const content = decrypt(fileData.encrypted_data, fileData.salt, passphrase);

                const localPath = path.join(claudeDir, filePath);
                fs.mkdirSync(path.dirname(localPath), { recursive: true });
                fs.writeFileSync(localPath, content);
                pulled++;
            } catch (e) {
                errors.push('Pull ' + filePath + ': ' + e.message);
            }
        }

        // Step 5: Log summary
        const ts = new Date().toISOString();
        const parts = ['[' + ts + '] SKILL SYNC: pushed=' + pushed + ', pulled=' + pulled];
        if (errors.length > 0) parts.push('errors=' + errors.length + ' (' + errors.join('; ') + ')');
        console.log(parts.join(', '));
    } catch (e) {
        const ts = new Date().toISOString();
        console.log('[' + ts + '] SKILL SYNC ERROR: ' + e.message);
    }
})();
" "$ITACHI_KEY_FILE" "$SYNC_API" "$CLAUDE_DIR" 2>&1

exit 0
