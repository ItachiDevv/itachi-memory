#!/usr/bin/env node
// Diagnostic script to debug sync endpoint 404 issues
// Run: node diagnose-sync.mjs
//
// Tests the itachisbrainserver.online API from multiple angles to find
// why /api/sync/list/_global returns 404 on some machines.

import { execSync } from 'child_process';
import { platform as osPlatform } from 'os';

const API_URL = 'https://itachisbrainserver.online';
const PLATFORM = osPlatform();

console.log('=== Itachi Sync Endpoint Diagnostics ===');
console.log(`Platform: ${PLATFORM}`);
console.log(`Node.js: ${process.version}`);
console.log(`Date: ${new Date().toISOString()}`);
console.log('');

// ---- Test 1: DNS Resolution ----
console.log('--- Test 1: DNS Resolution ---');
try {
  const dns = await import('dns');
  const hostname = new URL(API_URL).hostname;

  const lookup = await new Promise((resolve, reject) => {
    dns.default.lookup(hostname, { all: true }, (err, addrs) => {
      if (err) reject(err); else resolve(addrs);
    });
  });
  console.log('dns.lookup (all):', JSON.stringify(lookup));

  const resolve4 = await new Promise((resolve, reject) => {
    dns.default.resolve4(hostname, (err, addrs) => {
      if (err) reject(err); else resolve(addrs);
    });
  });
  console.log('dns.resolve4:', resolve4);

  try {
    const resolve6 = await new Promise((resolve, reject) => {
      dns.default.resolve6(hostname, (err, addrs) => {
        if (err) reject(err); else resolve(addrs);
      });
    });
    console.log('dns.resolve6:', resolve6);
  } catch {
    console.log('dns.resolve6: no AAAA records (expected)');
  }

  // Check: is the IP 77.42.84.38?
  const expectedIP = '77.42.84.38';
  const resolvedIP = lookup[0]?.address;
  if (resolvedIP !== expectedIP) {
    console.log(`WARNING: Expected ${expectedIP} but got ${resolvedIP}`);
  } else {
    console.log(`OK: Resolves to correct IP ${expectedIP}`);
  }
} catch (e) {
  console.log('DNS Error:', e.message);
}

console.log('');

// ---- Test 2: TLS Connection ----
console.log('--- Test 2: TLS Connection ---');
try {
  const tls = await import('tls');
  const hostname = new URL(API_URL).hostname;
  const socket = tls.default.connect(443, hostname, { servername: hostname });

  await new Promise((resolve) => {
    socket.on('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      console.log('Protocol:', socket.getProtocol());
      console.log('Cipher:', JSON.stringify(socket.getCipher()));
      console.log('Remote:', socket.remoteAddress + ':' + socket.remotePort);
      console.log('Cert CN:', cert.subject?.CN);
      console.log('Cert issuer:', cert.issuer?.CN);
      console.log('Cert SAN:', cert.subjectaltname);
      console.log('Cert valid:', cert.valid_from, '-', cert.valid_to);
      socket.end();
      resolve();
    });
    socket.on('error', (err) => {
      console.log('TLS Error:', err.message);
      resolve();
    });
    setTimeout(() => { socket.destroy(); resolve(); }, 10000);
  });
} catch (e) {
  console.log('TLS Error:', e.message);
}

console.log('');

// ---- Test 3: fetch() to various endpoints ----
console.log('--- Test 3: Node.js fetch() ---');
const endpoints = [
  { path: '/health', method: 'GET', desc: 'Health (ElizaOS core)' },
  { path: '/api/server/status', method: 'GET', desc: 'Server status (ElizaOS core)' },
  { path: '/api/agents', method: 'GET', desc: 'Agents list (ElizaOS core)' },
  { path: '/api/bootstrap', method: 'GET', desc: 'Bootstrap (custom plugin)' },
  { path: '/api/sync/list/_global', method: 'GET', desc: 'Sync list (custom plugin)' },
  { path: '/api/sync/push', method: 'POST', desc: 'Sync push (custom plugin, POST)' },
  { path: '/api/memory/search?query=test&limit=1', method: 'GET', desc: 'Memory search (custom plugin)' },
  { path: '/api/nonexistent', method: 'GET', desc: 'Non-existent (should be 404)' },
];

for (const ep of endpoints) {
  try {
    const opts = { method: ep.method, signal: AbortSignal.timeout(10000) };
    if (ep.method === 'POST') {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = '{}';
    }
    const res = await fetch(API_URL + ep.path, opts);
    const text = await res.text();
    const preview = text.substring(0, 80).replace(/\n/g, ' ');
    console.log(`  ${ep.desc.padEnd(35)} => ${res.status}: ${preview}`);
  } catch (e) {
    console.log(`  ${ep.desc.padEnd(35)} => ERROR: ${e.message}`);
  }
}

console.log('');

// ---- Test 4: https module (bypasses undici) ----
console.log('--- Test 4: Node.js https module (bypasses undici) ---');
const https = await import('https');

for (const ep of endpoints) {
  try {
    const result = await new Promise((resolve, reject) => {
      const parsedUrl = new URL(API_URL + ep.path);
      const opts = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: ep.method,
        headers: ep.method === 'POST' ? { 'Content-Type': 'application/json', 'Content-Length': '2' } : {},
      };
      const req = https.request(opts, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          const preview = body.substring(0, 80).replace(/\n/g, ' ');
          resolve(`${res.statusCode} (HTTP/${res.httpVersion}): ${preview}`);
        });
      });
      req.on('error', (e) => reject(e));
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
      if (ep.method === 'POST') req.write('{}');
      req.end();
    });
    console.log(`  ${ep.desc.padEnd(35)} => ${result}`);
  } catch (e) {
    console.log(`  ${ep.desc.padEnd(35)} => ERROR: ${e.message}`);
  }
}

console.log('');

// ---- Test 5: curl subprocess ----
console.log('--- Test 5: curl subprocess ---');
const isWin = PLATFORM === 'win32';
for (const ep of [endpoints[0], endpoints[3], endpoints[4], endpoints[7]]) {
  try {
    const url = `${API_URL}${ep.path}`;
    let cmd;
    if (isWin) {
      const curlFlags = ep.method === 'POST' ? '-X POST -H "Content-Type: application/json" -d "{}"' : '';
      cmd = `curl -s -S --max-time 10 -w "\\n%%{http_code} %%{remote_ip} %%{ssl_verify_result} %%{http_version}" ${curlFlags} "${url}"`;
    } else {
      const curlFlags = ep.method === 'POST' ? "-X POST -H 'Content-Type: application/json' -d '{}'" : '';
      cmd = `curl -s -S --max-time 10 -w '\\n%{http_code} %{remote_ip} %{ssl_verify_result} %{http_version}' ${curlFlags} '${url}'`;
    }
    const result = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 }).trim();
    const lines = result.split('\n');
    const meta = lines[lines.length - 1];
    const body = lines.slice(0, -1).join('').substring(0, 80);
    console.log(`  ${ep.desc.padEnd(35)} => meta: ${meta}, body: ${body}`);
  } catch (e) {
    console.log(`  ${ep.desc.padEnd(35)} => ERROR: ${e.message.substring(0, 100)}`);
  }
}

console.log('');

// ---- Test 6: Direct IP with Host header ----
console.log('--- Test 6: Direct IP + Host header (bypasses DNS) ---');
try {
  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '77.42.84.38',
      port: 443,
      path: '/api/sync/list/_global',
      method: 'GET',
      headers: { 'Host': 'itachisbrainserver.online' },
      servername: 'itachisbrainserver.online',
      rejectUnauthorized: true,
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve(`${res.statusCode}: ${body.substring(0, 100)}`));
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
  console.log(`  Direct IP => ${result}`);
} catch (e) {
  console.log(`  Direct IP => ERROR: ${e.message}`);
}

console.log('');

// ---- Test 7: HTTP/2 vs HTTP/1.1 ----
console.log('--- Test 7: HTTP/2 explicit test ---');
try {
  const http2 = await import('http2');
  const client = http2.default.connect(API_URL);

  const result = await new Promise((resolve, reject) => {
    const req = client.request({ ':method': 'GET', ':path': '/api/sync/list/_global' });
    let data = '';
    let status = 0;
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      client.close();
      resolve(`${status}: ${data.substring(0, 100)}`);
    });
    req.on('error', (e) => { client.close(); reject(e); });
    req.end();
  });
  console.log(`  HTTP/2 => ${result}`);
} catch (e) {
  console.log(`  HTTP/2 => ERROR: ${e.message}`);
}

console.log('');
console.log('=== Diagnostics Complete ===');
console.log('');
console.log('If ALL tests return 404 for /api/sync/list/_global:');
console.log('  - The server may need a restart (ElizaOS plugins not loaded)');
console.log('  - Check Coolify/Traefik routing for the domain');
console.log('');
console.log('If fetch() returns 404 but https module or curl works:');
console.log('  - Node.js undici/fetch bug (use --no-experimental-fetch flag)');
console.log('  - Or add NODE_OPTIONS to environment');
console.log('');
console.log('If all methods return 404 from this machine but work from another:');
console.log('  - Check DNS resolution (different IP?)');
console.log('  - Check if behind a proxy/VPN');
console.log('  - Try: sudo dscacheutil -flushcache (macOS)');
console.log('  - Try: sudo killall -HUP mDNSResponder (macOS)');
