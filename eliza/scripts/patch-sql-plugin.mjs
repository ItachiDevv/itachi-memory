#!/usr/bin/env node
/**
 * Patches @elizaos/plugin-sql to guard against undefined embeddings.
 *
 * The SQL plugin's searchByEmbedding() and upsertEmbedding() call
 * `embedding.map(...)` without checking if embedding is defined.
 * When the embedding model fails or returns undefined, this causes:
 *
 *   TypeError: undefined is not an object (evaluating 'embedding.map')
 *
 * The withRetry() wrapper retries 3 times with exponential backoff,
 * causing 2-3 minute delays on every message.
 *
 * This patch adds guards so undefined embeddings return empty results
 * instead of crashing.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginPath = join(__dirname, '..', 'node_modules', '@elizaos', 'plugin-sql', 'dist', 'node', 'index.node.js');

if (!existsSync(pluginPath)) {
  console.log('[patch] plugin-sql not found at', pluginPath, '— skipping');
  process.exit(0);
}

let code = readFileSync(pluginPath, 'utf8');
let patched = 0;

// Patch 1: searchByEmbedding — guard the embedding.map() call
// Original:  async searchByEmbedding(embedding, params) {
//              return this.ctx.withRetry(async () => {
//                const cleanVector = embedding.map(...)
const searchPattern = 'async searchByEmbedding(embedding, params) {\n    return this.ctx.withRetry(async () => {\n      const cleanVector = embedding.map(';
const searchReplacement = `async searchByEmbedding(embedding, params) {
    return this.ctx.withRetry(async () => {
      if (!embedding || !Array.isArray(embedding)) { return []; }
      const cleanVector = embedding.map(`;

if (code.includes(searchPattern)) {
  code = code.replace(searchPattern, searchReplacement);
  patched++;
  console.log('[patch] Patched searchByEmbedding — added undefined guard');
} else {
  // Try a more flexible match
  const flexPattern = /async searchByEmbedding\(embedding, params\)\s*\{\s*return this\.ctx\.withRetry\(async \(\) => \{\s*const cleanVector = embedding\.map\(/;
  if (flexPattern.test(code)) {
    code = code.replace(flexPattern,
      `async searchByEmbedding(embedding, params) {
    return this.ctx.withRetry(async () => {
      if (!embedding || !Array.isArray(embedding)) { return []; }
      const cleanVector = embedding.map(`);
    patched++;
    console.log('[patch] Patched searchByEmbedding (flex match) — added undefined guard');
  } else {
    console.warn('[patch] WARNING: Could not find searchByEmbedding pattern to patch');
  }
}

// Patch 2: upsertEmbedding — guard the embedding.map() call
// Original:  async upsertEmbedding(tx, memoryId, embedding) {
//              const cleanVector = embedding.map(...)
const upsertPattern = 'async upsertEmbedding(tx, memoryId, embedding) {\n    const cleanVector = embedding.map(';
const upsertReplacement = `async upsertEmbedding(tx, memoryId, embedding) {
    if (!embedding || !Array.isArray(embedding)) { return; }
    const cleanVector = embedding.map(`;

if (code.includes(upsertPattern)) {
  code = code.replace(upsertPattern, upsertReplacement);
  patched++;
  console.log('[patch] Patched upsertEmbedding — added undefined guard');
} else {
  const flexUpsert = /async upsertEmbedding\(tx, memoryId, embedding\)\s*\{\s*const cleanVector = embedding\.map\(/;
  if (flexUpsert.test(code)) {
    code = code.replace(flexUpsert,
      `async upsertEmbedding(tx, memoryId, embedding) {
    if (!embedding || !Array.isArray(embedding)) { return; }
    const cleanVector = embedding.map(`);
    patched++;
    console.log('[patch] Patched upsertEmbedding (flex match) — added undefined guard');
  } else {
    console.warn('[patch] WARNING: Could not find upsertEmbedding pattern to patch');
  }
}

if (patched > 0) {
  writeFileSync(pluginPath, code, 'utf8');
  console.log(`[patch] Successfully applied ${patched} patches to plugin-sql`);
} else {
  console.warn('[patch] No patches applied — the plugin may already be patched or the code structure changed');
}
