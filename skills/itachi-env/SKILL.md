# /itachi-env — Encrypted File Sync

Manual push/pull/status/diff for `.env`, `.md`, skills, and commands synced across machines via encrypted Supabase storage.

## Synced Categories

| Category | Local Path | Repo | Sync file_path |
|----------|-----------|------|----------------|
| Project .env/.md | `<cwd>/.env`, `<cwd>/*.md` | `<project>` | `<filename>` |
| Project skills | `<cwd>/.claude/skills/foo/SKILL.md` | `<project>` | `.claude/skills/foo/SKILL.md` |
| User skills | `~/.claude/skills/foo/SKILL.md` | `_global` | `skills/foo/SKILL.md` |
| User commands | `~/.claude/commands/recall.md` | `_global` | `commands/recall.md` |

## Prerequisites
- `~/.itachi-key` must exist (passphrase file)
- Sync API at `$ITACHI_API_URL/api/sync`

## Usage

Parse the user's subcommand from `$ARGUMENTS`:
- `/itachi-env` or `/itachi-env status` → **status**
- `/itachi-env push [file]` → **push**
- `/itachi-env pull [file]` → **pull**
- `/itachi-env diff [file]` → **diff**

## Implementation

For ALL subcommands, use `node -e` inline with the crypto pattern below. The project name is `basename` of the current working directory. The sync API base is `$ITACHI_API_URL/api/sync`.

### Crypto Constants
- **Cipher**: AES-256-GCM
- **KDF**: PBKDF2 with SHA-256, 100,000 iterations
- **Key length**: 32 bytes
- **IV length**: 12 bytes
- **Salt length**: 16 bytes
- **Packed format**: `IV (12) + AuthTag (16) + Ciphertext` → base64
- **Machine-specific keys** (stripped from .env before hash/encrypt): `ITACHI_ORCHESTRATOR_ID`, `ITACHI_WORKSPACE_DIR`, `ITACHI_PROJECT_PATHS`

### status

List all synced files for this project AND global (`_global`) repo. Run:

```bash
node -e "
const https = require('https');
const http = require('http');
const syncApi = '$ITACHI_API_URL/api/sync';
const project = require('path').basename(process.cwd());

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? https : http;
        mod.get(u, { rejectUnauthorized: false, timeout: 10000 }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 400) reject(new Error(d));
                else resolve(JSON.parse(d));
            });
        }).on('error', reject);
    });
}

(async () => {
    // Project files
    const projList = await httpGet(syncApi + '/list/' + encodeURIComponent(project));
    if (projList.files && projList.files.length > 0) {
        console.log('Project synced files (' + project + '):');
        console.log('');
        projList.files.forEach(f => {
            console.log('  ' + f.file_path + '  v' + f.version + '  by ' + f.updated_by + '  ' + f.updated_at);
        });
    } else {
        console.log('No synced files for project ' + project);
    }
    console.log('');
    // Global files (skills + commands)
    const globalList = await httpGet(syncApi + '/list/_global');
    if (globalList.files && globalList.files.length > 0) {
        console.log('Global synced files (_global):');
        console.log('');
        globalList.files.forEach(f => {
            console.log('  ' + f.file_path + '  v' + f.version + '  by ' + f.updated_by + '  ' + f.updated_at);
        });
    } else {
        console.log('No global synced files');
    }
})().catch(e => console.error('Error:', e.message));
"
```

Display the output to the user in a formatted table.

### push

Encrypt and push a file (or all syncable files) to the sync API.

If `[file]` is specified, push just that file. Otherwise, discover and push all syncable files:
- Project: `.env`, `.env.*`, `*.md` in cwd (non-recursive) + `.claude/skills/**` in cwd (recursive)
- Global: `~/.claude/skills/**` and `~/.claude/commands/**` (recursive)

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
const os = require('os');

const syncApi = '$ITACHI_API_URL/api/sync';
const project = path.basename(process.cwd());
const keyFile = path.join(os.homedir(), '.itachi-key');
const passphrase = fs.readFileSync(keyFile, 'utf8').trim();
const machineKeys = ['ITACHI_ORCHESTRATOR_ID', 'ITACHI_WORKSPACE_DIR', 'ITACHI_PROJECT_PATHS'];
const targetFile = process.argv[1] || null;

function findFiles(dir, prefix) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) results.push(...findFiles(path.join(dir, entry.name), rel));
        else results.push(rel);
    }
    return results;
}

// Build list of { absPath, repoName, syncPath }
const items = [];

if (targetFile) {
    // Single file — determine repo and sync path
    const abs = path.resolve(targetFile);
    const cwd = process.cwd();
    const home = os.homedir();
    const projSkills = path.join(cwd, '.claude', 'skills') + path.sep;
    const userSkills = path.join(home, '.claude', 'skills') + path.sep;
    const userCmds = path.join(home, '.claude', 'commands') + path.sep;

    if (abs.startsWith(projSkills)) {
        items.push({ absPath: abs, repoName: project, syncPath: path.relative(cwd, abs).replace(/\\\\/g, '/') });
    } else if (abs.startsWith(userSkills)) {
        items.push({ absPath: abs, repoName: '_global', syncPath: 'skills/' + path.relative(path.join(home, '.claude', 'skills'), abs).replace(/\\\\/g, '/') });
    } else if (abs.startsWith(userCmds)) {
        items.push({ absPath: abs, repoName: '_global', syncPath: 'commands/' + path.relative(path.join(home, '.claude', 'commands'), abs).replace(/\\\\/g, '/') });
    } else {
        items.push({ absPath: abs, repoName: project, syncPath: path.basename(abs) });
    }
} else {
    // Discover all syncable files
    // 1. Project root .env and .md
    for (const f of fs.readdirSync('.')) {
        if (f === '.env' || f.startsWith('.env.') || f.endsWith('.md')) {
            items.push({ absPath: path.resolve(f), repoName: project, syncPath: f });
        }
    }
    // 2. Project skills
    const projSkillsDir = path.join(process.cwd(), '.claude', 'skills');
    for (const rel of findFiles(projSkillsDir, '')) {
        items.push({ absPath: path.join(projSkillsDir, rel), repoName: project, syncPath: '.claude/skills/' + rel });
    }
    // 3. Global skills
    const userSkillsDir = path.join(os.homedir(), '.claude', 'skills');
    for (const rel of findFiles(userSkillsDir, '')) {
        items.push({ absPath: path.join(userSkillsDir, rel), repoName: '_global', syncPath: 'skills/' + rel });
    }
    // 4. Global commands
    const userCmdsDir = path.join(os.homedir(), '.claude', 'commands');
    for (const rel of findFiles(userCmdsDir, '')) {
        items.push({ absPath: path.join(userCmdsDir, rel), repoName: '_global', syncPath: 'commands/' + rel });
    }
}

for (const item of items) {
    if (!fs.existsSync(item.absPath)) { console.log('  SKIP ' + item.syncPath + ' (not found)'); continue; }
    let content = fs.readFileSync(item.absPath, 'utf8');
    const fn = path.basename(item.absPath);
    if (fn === '.env' || fn.startsWith('.env.')) {
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

    const body = JSON.stringify({ repo_name: item.repoName, file_path: item.syncPath, encrypted_data: packed.toString('base64'), salt: salt.toString('base64'), content_hash: contentHash, updated_by: os.hostname() });
    const url = new URL(syncApi + '/push');
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, rejectUnauthorized: false }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { const r = JSON.parse(d); console.log('  PUSH [' + item.repoName + '] ' + item.syncPath + ' -> v' + (r.version || '?')); });
    });
    req.on('error', e => console.log('  ERR  ' + item.syncPath + ': ' + e.message));
    req.write(body); req.end();
}
" "FILE_ARG_HERE"
```

Replace `FILE_ARG_HERE` with the actual file argument, or omit process.argv[1] usage to push all.

### pull

Pull and decrypt files from the sync API. Pulls both project and global repos.

For each file:
1. GET `/api/sync/pull/<repo>/<file>` → get encrypted data
2. Decrypt with passphrase from `~/.itachi-key`
3. For `.env`: merge (remote wins for shared keys, local-only preserved, machine keys untouched)
4. For all others (`.md`, skills, commands): whole-file replacement
5. Project files write to `<cwd>/<file_path>`, global files write to `~/.claude/<file_path>`

Use this node inline pattern:

```bash
node -e "
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');

const syncApi = '$ITACHI_API_URL/api/sync';
const project = path.basename(process.cwd());
const keyFile = path.join(os.homedir(), '.itachi-key');
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

async function pullRepo(repoName, baseDir, label) {
    const list = await httpGet(syncApi + '/list/' + encodeURIComponent(repoName));
    const files = targetFile ? (list.files || []).filter(f => f.file_path === targetFile) : (list.files || []);
    if (files.length === 0) { console.log('No files to pull for ' + label); return; }
    for (const f of files) {
        const localPath = path.join(baseDir, f.file_path);
        const fd = await httpGet(syncApi + '/pull/' + encodeURIComponent(repoName) + '/' + f.file_path);
        const remote = decrypt(fd.encrypted_data, fd.salt, passphrase);
        const fn = path.basename(f.file_path);
        if (fn === '.env' || fn.startsWith('.env.')) {
            if (fs.existsSync(localPath)) {
                const merged = mergeEnv(fs.readFileSync(localPath, 'utf8'), remote);
                fs.writeFileSync(localPath, merged);
                console.log('  PULL [' + repoName + '] ' + f.file_path + ' (merged, v' + f.version + ')');
            } else {
                fs.mkdirSync(path.dirname(localPath), { recursive: true });
                fs.writeFileSync(localPath, remote);
                console.log('  PULL [' + repoName + '] ' + f.file_path + ' (new, v' + f.version + ')');
            }
        } else {
            fs.mkdirSync(path.dirname(localPath), { recursive: true });
            fs.writeFileSync(localPath, remote);
            console.log('  PULL [' + repoName + '] ' + f.file_path + ' (replaced, v' + f.version + ')');
        }
    }
}

(async () => {
    await pullRepo(project, process.cwd(), 'project ' + project);
    await pullRepo('_global', path.join(os.homedir(), '.claude'), 'global');
})().catch(e => console.error('Error:', e.message));
" "FILE_ARG_HERE"
```

### diff

Show differences between local and remote without writing. Diffs both project and global repos.

For each synced file:
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
const os = require('os');

const syncApi = '$ITACHI_API_URL/api/sync';
const project = path.basename(process.cwd());
const keyFile = path.join(os.homedir(), '.itachi-key');
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

async function diffRepo(repoName, baseDir, label) {
    const list = await httpGet(syncApi + '/list/' + encodeURIComponent(repoName));
    const files = targetFile ? (list.files || []).filter(f => f.file_path === targetFile) : (list.files || []);
    if (files.length === 0) { console.log('No synced files to diff for ' + label); return; }

    console.log('=== ' + label + ' ===');
    for (const f of files) {
        const localPath = path.join(baseDir, f.file_path);
        console.log('--- ' + f.file_path + ' (remote v' + f.version + ' by ' + f.updated_by + ') ---');
        let localContent = '';
        if (fs.existsSync(localPath)) {
            localContent = fs.readFileSync(localPath, 'utf8');
            const fn = path.basename(f.file_path);
            if (fn === '.env' || fn.startsWith('.env.')) localContent = stripMachine(localContent);
        }
        const localHash = crypto.createHash('sha256').update(localContent).digest('hex');
        if (localHash === f.content_hash) { console.log('  (identical)\n'); continue; }

        const fd = await httpGet(syncApi + '/pull/' + encodeURIComponent(repoName) + '/' + f.file_path);
        const remote = decrypt(fd.encrypted_data, fd.salt, passphrase);

        const localLines = localContent.split('\n');
        const remoteLines = remote.split('\n');
        const localSet = new Set(localLines);
        const remoteSet = new Set(remoteLines);
        const added = remoteLines.filter(l => l && !localSet.has(l));
        const removed = localLines.filter(l => l && !remoteSet.has(l));
        if (added.length > 0) { console.log('  + ' + added.join('\n  + ')); }
        if (removed.length > 0) { console.log('  - ' + removed.join('\n  - ')); }
        if (added.length === 0 && removed.length === 0 && !fs.existsSync(localPath)) { console.log('  (new file - not present locally)'); }
        console.log('');
    }
}

(async () => {
    await diffRepo(project, process.cwd(), 'Project: ' + project);
    console.log('');
    await diffRepo('_global', path.join(os.homedir(), '.claude'), 'Global');
})().catch(e => console.error('Error:', e.message));
" "FILE_ARG_HERE"
```

## Error Handling

- If `~/.itachi-key` doesn't exist, tell the user: "No passphrase found. Run `node install.mjs` or create ~/.itachi-key manually."
- If API returns errors, display the error message.
- If decryption fails, likely wrong passphrase — tell the user.
