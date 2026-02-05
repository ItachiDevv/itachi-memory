# /itachi-env — Encrypted File Sync

Manual push/pull/status/diff for `.env` and `.md` files synced across machines via encrypted Supabase storage.

## Prerequisites
- `~/.itachi-key` must exist (passphrase file)
- Sync API at `https://eliza-claude-production.up.railway.app/api/sync`

## Usage

Parse the user's subcommand from `$ARGUMENTS`:
- `/itachi-env` or `/itachi-env status` → **status**
- `/itachi-env push [file]` → **push**
- `/itachi-env pull [file]` → **pull**
- `/itachi-env diff [file]` → **diff**

## Implementation

For ALL subcommands, use `node -e` inline with the crypto pattern below. The project name is `basename` of the current working directory. The sync API base is `https://eliza-claude-production.up.railway.app/api/sync`.

### Crypto Constants
- **Cipher**: AES-256-GCM
- **KDF**: PBKDF2 with SHA-256, 100,000 iterations
- **Key length**: 32 bytes
- **IV length**: 12 bytes
- **Salt length**: 16 bytes
- **Packed format**: `IV (12) + AuthTag (16) + Ciphertext` → base64
- **Machine-specific keys** (stripped from .env before hash/encrypt): `ITACHI_ORCHESTRATOR_ID`, `ITACHI_WORKSPACE_DIR`, `ITACHI_PROJECT_PATHS`

### status

List all synced files for this project. Run:

```bash
node -e "
const https = require('https');
const http = require('http');
const syncApi = 'https://eliza-claude-production.up.railway.app/api/sync';
const project = require('path').basename(process.cwd());

const u = new URL(syncApi + '/list/' + encodeURIComponent(project));
const mod = u.protocol === 'https:' ? https : http;
mod.get(u, { rejectUnauthorized: false }, (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
        const r = JSON.parse(d);
        if (!r.files || r.files.length === 0) { console.log('No synced files for ' + project); return; }
        console.log('Synced files for ' + project + ':');
        console.log('');
        r.files.forEach(f => {
            console.log('  ' + f.file_path + '  v' + f.version + '  by ' + f.updated_by + '  ' + f.updated_at);
        });
    });
}).on('error', e => console.error('Error:', e.message));
"
```

Display the output to the user in a formatted table.

### push

Encrypt and push a file (or all .env/.md files) to the sync API.

If `[file]` is specified, push just that file. Otherwise, find all `.env` and `*.md` files in the current directory (non-recursive) and push each.

For each file:
1. Read `~/.itachi-key` for passphrase
2. Read file content
3. For `.env` files: strip machine-specific keys
4. Compute SHA-256 content hash of stripped content
5. Encrypt with AES-256-GCM + PBKDF2
6. POST to `/api/sync/push` with `{ repo_name, file_path, encrypted_data, salt, content_hash, updated_by }`

Use this node inline pattern:

```bash
node -e "
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const syncApi = 'https://eliza-claude-production.up.railway.app/api/sync';
const project = path.basename(process.cwd());
const keyFile = path.join(require('os').homedir(), '.itachi-key');
const passphrase = fs.readFileSync(keyFile, 'utf8').trim();
const machineKeys = ['ITACHI_ORCHESTRATOR_ID', 'ITACHI_WORKSPACE_DIR', 'ITACHI_PROJECT_PATHS'];
const targetFile = process.argv[1] || null;

const files = targetFile ? [targetFile] : fs.readdirSync('.').filter(f => f === '.env' || f.startsWith('.env.') || f.endsWith('.md'));

for (const fileName of files) {
    if (!fs.existsSync(fileName)) { console.log('  SKIP ' + fileName + ' (not found)'); continue; }
    let content = fs.readFileSync(fileName, 'utf8');
    if (fileName === '.env' || fileName.startsWith('.env.')) {
        const re = new RegExp('^(' + machineKeys.join('|') + ')=.*$', 'gm');
        content = content.replace(re, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    }
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const salt = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), ct]);

    const body = JSON.stringify({ repo_name: project, file_path: fileName, encrypted_data: packed.toString('base64'), salt: salt.toString('base64'), content_hash: contentHash, updated_by: require('os').hostname() });
    const url = new URL(syncApi + '/push');
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, rejectUnauthorized: false }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { const r = JSON.parse(d); console.log('  PUSH ' + fileName + ' -> v' + (r.version || '?')); });
    });
    req.on('error', e => console.log('  ERR  ' + fileName + ': ' + e.message));
    req.write(body); req.end();
}
" "FILE_ARG_HERE"
```

Replace `FILE_ARG_HERE` with the actual file argument, or omit process.argv[1] usage to push all.

### pull

Pull and decrypt a file (or all synced files) from the sync API.

For each file:
1. GET `/api/sync/pull/<repo>/<file>` → get encrypted data
2. Decrypt with passphrase from `~/.itachi-key`
3. For `.env`: merge (remote wins for shared keys, local-only preserved, machine keys untouched)
4. For `.md`: whole-file replacement

Use this node inline pattern:

```bash
node -e "
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const syncApi = 'https://eliza-claude-production.up.railway.app/api/sync';
const project = path.basename(process.cwd());
const keyFile = path.join(require('os').homedir(), '.itachi-key');
const passphrase = fs.readFileSync(keyFile, 'utf8').trim();
const machineKeys = ['ITACHI_ORCHESTRATOR_ID', 'ITACHI_WORKSPACE_DIR', 'ITACHI_PROJECT_PATHS'];
const targetFile = process.argv[1] || null;

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? https : http;
        mod.get(u, { rejectUnauthorized: false, timeout: 10000 }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { if (res.statusCode >= 400) reject(new Error(d)); else resolve(JSON.parse(d)); });
        }).on('error', reject);
    });
}

function decrypt(encB64, saltB64, pass) {
    const packed = Buffer.from(encB64, 'base64');
    const salt = Buffer.from(saltB64, 'base64');
    const iv = packed.subarray(0, 12), tag = packed.subarray(12, 28), ct = packed.subarray(28);
    const key = crypto.pbkdf2Sync(pass, salt, 100000, 32, 'sha256');
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return d.update(ct, null, 'utf8') + d.final('utf8');
}

function mergeEnv(local, remote) {
    const lkv = {}, rkv = {};
    const ll = local.split('\n');
    for (const l of ll) { const m = l.match(/^([A-Za-z_]\w*)=(.*)$/); if (m) lkv[m[1]] = m[2]; }
    for (const l of remote.split('\n')) { const m = l.match(/^([A-Za-z_]\w*)=(.*)$/); if (m) rkv[m[1]] = m[2]; }
    Object.assign(lkv, rkv);
    for (const l of ll) { const m = l.match(/^([A-Za-z_]\w*)=(.*)$/); if (m && machineKeys.includes(m[1])) lkv[m[1]] = m[2]; }
    return Object.entries(lkv).map(([k,v]) => k+'='+v).join('\n') + '\n';
}

(async () => {
    const list = await httpGet(syncApi + '/list/' + encodeURIComponent(project));
    const files = targetFile ? list.files.filter(f => f.file_path === targetFile) : list.files;
    if (!files || files.length === 0) { console.log('No files to pull'); return; }
    for (const f of files) {
        const fd = await httpGet(syncApi + '/pull/' + encodeURIComponent(project) + '/' + f.file_path);
        const remote = decrypt(fd.encrypted_data, fd.salt, passphrase);
        const fn = f.file_path;
        if (fn === '.env' || fn.startsWith('.env.')) {
            if (fs.existsSync(fn)) {
                const merged = mergeEnv(fs.readFileSync(fn, 'utf8'), remote);
                fs.writeFileSync(fn, merged);
                console.log('  PULL ' + fn + ' (merged, v' + f.version + ')');
            } else {
                fs.writeFileSync(fn, remote);
                console.log('  PULL ' + fn + ' (new, v' + f.version + ')');
            }
        } else {
            fs.writeFileSync(fn, remote);
            console.log('  PULL ' + fn + ' (replaced, v' + f.version + ')');
        }
    }
})().catch(e => console.error('Error:', e.message));
" "FILE_ARG_HERE"
```

### diff

Show differences between local and remote without writing. For each synced file:
1. Pull and decrypt remote version
2. Compare with local file
3. Display diff (added/removed lines)

```bash
node -e "
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const syncApi = 'https://eliza-claude-production.up.railway.app/api/sync';
const project = path.basename(process.cwd());
const keyFile = path.join(require('os').homedir(), '.itachi-key');
const passphrase = fs.readFileSync(keyFile, 'utf8').trim();
const machineKeys = ['ITACHI_ORCHESTRATOR_ID', 'ITACHI_WORKSPACE_DIR', 'ITACHI_PROJECT_PATHS'];
const targetFile = process.argv[1] || null;

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? https : http;
        mod.get(u, { rejectUnauthorized: false, timeout: 10000 }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { if (res.statusCode >= 400) reject(new Error(d)); else resolve(JSON.parse(d)); });
        }).on('error', reject);
    });
}

function decrypt(encB64, saltB64, pass) {
    const packed = Buffer.from(encB64, 'base64');
    const salt = Buffer.from(saltB64, 'base64');
    const iv = packed.subarray(0, 12), tag = packed.subarray(12, 28), ct = packed.subarray(28);
    const key = crypto.pbkdf2Sync(pass, salt, 100000, 32, 'sha256');
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return d.update(ct, null, 'utf8') + d.final('utf8');
}

function stripMachine(content) {
    return content.replace(new RegExp('^(' + machineKeys.join('|') + ')=.*$', 'gm'), '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

(async () => {
    const list = await httpGet(syncApi + '/list/' + encodeURIComponent(project));
    const files = targetFile ? list.files.filter(f => f.file_path === targetFile) : list.files;
    if (!files || files.length === 0) { console.log('No synced files to diff'); return; }

    for (const f of files) {
        console.log('--- ' + f.file_path + ' (remote v' + f.version + ' by ' + f.updated_by + ') ---');
        let localContent = '';
        if (fs.existsSync(f.file_path)) {
            localContent = fs.readFileSync(f.file_path, 'utf8');
            const fn = path.basename(f.file_path);
            if (fn === '.env' || fn.startsWith('.env.')) localContent = stripMachine(localContent);
        }
        const localHash = crypto.createHash('sha256').update(localContent).digest('hex');
        if (localHash === f.content_hash) { console.log('  (identical)\n'); continue; }

        const fd = await httpGet(syncApi + '/pull/' + encodeURIComponent(project) + '/' + f.file_path);
        const remote = decrypt(fd.encrypted_data, fd.salt, passphrase);

        const localLines = localContent.split('\n');
        const remoteLines = remote.split('\n');
        const localSet = new Set(localLines);
        const remoteSet = new Set(remoteLines);
        const added = remoteLines.filter(l => l && !localSet.has(l));
        const removed = localLines.filter(l => l && !remoteSet.has(l));
        if (added.length > 0) { console.log('  + ' + added.join('\n  + ')); }
        if (removed.length > 0) { console.log('  - ' + removed.join('\n  - ')); }
        if (added.length === 0 && removed.length === 0 && !fs.existsSync(f.file_path)) { console.log('  (new file - not present locally)'); }
        console.log('');
    }
})().catch(e => console.error('Error:', e.message));
" "FILE_ARG_HERE"
```

## Error Handling

- If `~/.itachi-key` doesn't exist, tell the user: "No passphrase found. Run setup.sh/setup.ps1 or create ~/.itachi-key manually."
- If API returns errors, display the error message.
- If decryption fails, likely wrong passphrase — tell the user.
