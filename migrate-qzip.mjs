import { createClient } from '@supabase/supabase-js';

// ── Source (qzip) ──
const SRC_URL = 'https://aavqyazrcooxeyidzrdt.supabase.co';
const SRC_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhdnF5YXpyY29veGV5aWR6cmR0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MzQ4ODAyMiwiZXhwIjoyMDc5MDY0MDIyfQ.AIEB2F8v8_JKWA56MkpNbFQSv02xHnmCTvsK_9ekKq8';
const SRC_REF = 'aavqyazrcooxeyidzrdt';

// ── Destination (itachi) ──
const DST_URL = 'https://beblaimllkgkhtkcszuz.supabase.co';
const DST_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJlYmxhaW1sbGtna2h0a2NzenV6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MTE0NjMwNiwiZXhwIjoyMDc2NzIyMzA2fQ.WdoxohoUu6nADJNjclERvPXP96D7xiPHWCYoAlgSfqE';
const DST_REF = 'beblaimllkgkhtkcszuz';

// ── Management API token ──
const MGMT_TOKEN = 'sbp_bfde0bc91d9aef9eb9acaa61cc6d51517a5a613a';

const src = createClient(SRC_URL, SRC_KEY);
const dst = createClient(DST_URL, DST_KEY);

const TABLES = ['generated_images_qzip', 'memes', 'pfp_gallery_lindy'];

const BUCKETS = [
  { name: 'memes', public: true, fileSizeLimit: 50 * 1024 * 1024 },
  { name: 'generated-images-qzip', public: true, fileSizeLimit: 30 * 1024 * 1024 },
];

// ─────────────────────────────────────────────
// Helper: run SQL on a project via Management API
// ─────────────────────────────────────────────
async function runSQL(projectRef, sql) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MGMT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SQL API error (${res.status}): ${text}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────
// Map Postgres types to DDL types
// ─────────────────────────────────────────────
function pgType(dataType, udtName, charMaxLen) {
  // Handle common types
  if (dataType === 'USER-DEFINED') return udtName || 'text';
  if (dataType === 'ARRAY') return (udtName ? udtName.replace(/^_/, '') + '[]' : 'text[]');
  if (dataType === 'character varying') return charMaxLen ? `varchar(${charMaxLen})` : 'text';
  if (dataType === 'character') return charMaxLen ? `char(${charMaxLen})` : 'char(1)';
  return dataType;
}

// ─────────────────────────────────────────────
// 1. Migrate tables
// ─────────────────────────────────────────────
async function migrateTables() {
  for (const table of TABLES) {
    console.log(`\n========== TABLE: ${table} ==========`);

    // 1a. Get column info from source
    console.log(`  [1] Fetching schema for ${table}...`);
    const colRows = await runSQL(SRC_REF, `
      SELECT column_name, data_type, udt_name, is_nullable, column_default,
             character_maximum_length, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '${table}'
      ORDER BY ordinal_position
    `);
    if (!colRows || colRows.length === 0) {
      console.error(`  !! No columns found for ${table} – skipping`);
      continue;
    }
    console.log(`  Found ${colRows.length} columns: ${colRows.map(c => c.column_name).join(', ')}`);

    // 1b. Get primary key columns
    const pkRows = await runSQL(SRC_REF, `
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.table_name = '${table}'
        AND tc.table_schema = 'public'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
    `);
    const pkCols = (pkRows || []).map(r => r.column_name);
    console.log(`  Primary key: ${pkCols.length ? pkCols.join(', ') : '(none)'}`);

    // 1c. Build CREATE TABLE DDL
    const colDefs = colRows.map(c => {
      const type = pgType(c.data_type, c.udt_name, c.character_maximum_length);
      const nullable = c.is_nullable === 'NO' ? ' NOT NULL' : '';
      // Include column_default for generated/serial columns
      let def = '';
      if (c.column_default) {
        // Skip defaults that reference sequences from the source (we'll handle identity differently)
        if (!c.column_default.includes('nextval(')) {
          def = ` DEFAULT ${c.column_default}`;
        }
      }
      return `  "${c.column_name}" ${type}${nullable}${def}`;
    });
    const pkClause = pkCols.length
      ? `,\n  PRIMARY KEY (${pkCols.map(c => `"${c}"`).join(', ')})`
      : '';
    const ddl = `CREATE TABLE IF NOT EXISTS "public"."${table}" (\n${colDefs.join(',\n')}${pkClause}\n);`;
    console.log(`  [2] Creating table on destination...`);
    console.log(`  DDL:\n${ddl}`);

    try {
      await runSQL(DST_REF, ddl);
      console.log(`  Table created (or already exists).`);
    } catch (err) {
      console.error(`  !! DDL error: ${err.message}`);
      // Try to continue – maybe the table already exists
    }

    // 1d. Fetch all rows from source
    console.log(`  [3] Fetching rows from source...`);
    let allRows = [];
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await src
        .from(table)
        .select('*')
        .range(offset, offset + PAGE - 1);
      if (error) {
        console.error(`  !! Fetch error: ${error.message}`);
        break;
      }
      if (!data || data.length === 0) break;
      allRows = allRows.concat(data);
      offset += data.length;
      if (data.length < PAGE) break;
    }
    console.log(`  Fetched ${allRows.length} rows.`);

    if (allRows.length === 0) {
      console.log(`  Nothing to insert.`);
      continue;
    }

    // 1e. Insert into destination in batches
    console.log(`  [4] Inserting rows into destination...`);
    const BATCH = 100;
    let inserted = 0;
    let failed = 0;
    for (let i = 0; i < allRows.length; i += BATCH) {
      const batch = allRows.slice(i, i + BATCH);
      const { error } = await dst
        .from(table)
        .upsert(batch, { onConflict: pkCols.length ? pkCols.join(',') : undefined, ignoreDuplicates: true });
      if (error) {
        console.error(`  !! Insert batch ${i}-${i + batch.length}: ${error.message}`);
        failed += batch.length;
      } else {
        inserted += batch.length;
      }
    }
    console.log(`  Inserted: ${inserted}, Failed: ${failed}`);
  }
}

// ─────────────────────────────────────────────
// 2. Migrate storage buckets
// ─────────────────────────────────────────────
async function migrateStorage() {
  for (const bucket of BUCKETS) {
    console.log(`\n========== BUCKET: ${bucket.name} ==========`);

    // 2a. Create bucket on destination
    console.log(`  [1] Creating bucket on destination...`);
    const { error: createErr } = await dst.storage.createBucket(bucket.name, {
      public: bucket.public,
      fileSizeLimit: bucket.fileSizeLimit,
    });
    if (createErr) {
      if (createErr.message && createErr.message.includes('already exists')) {
        console.log(`  Bucket already exists.`);
      } else {
        console.error(`  !! Bucket create error: ${createErr.message}`);
        // Try to continue anyway
      }
    } else {
      console.log(`  Bucket created.`);
    }

    // 2b. List all files in source bucket (recursively)
    console.log(`  [2] Listing files in source bucket...`);
    const files = await listAllFiles(src, bucket.name, '');
    console.log(`  Found ${files.length} files.`);

    if (files.length === 0) {
      console.log(`  Nothing to migrate.`);
      continue;
    }

    // 2c. Download from source, upload to destination
    console.log(`  [3] Migrating files...`);
    let ok = 0;
    let fail = 0;
    for (const filePath of files) {
      try {
        // Download
        const { data: blob, error: dlErr } = await src.storage
          .from(bucket.name)
          .download(filePath);
        if (dlErr) throw dlErr;

        // Convert Blob to Buffer for upload
        const arrayBuf = await blob.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);

        // Detect content type
        const contentType = blob.type || 'application/octet-stream';

        // Upload
        const { error: upErr } = await dst.storage
          .from(bucket.name)
          .upload(filePath, buffer, {
            contentType,
            upsert: true,
          });
        if (upErr) throw upErr;

        ok++;
        if (ok % 10 === 0 || ok === files.length) {
          console.log(`    Uploaded ${ok}/${files.length}...`);
        }
      } catch (err) {
        fail++;
        console.error(`    !! Failed ${filePath}: ${err.message || err}`);
      }
    }
    console.log(`  Done. Uploaded: ${ok}, Failed: ${fail}`);
  }
}

// Recursively list all files in a bucket
async function listAllFiles(client, bucketName, prefix) {
  const allFiles = [];
  const { data, error } = await client.storage
    .from(bucketName)
    .list(prefix, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
  if (error) {
    console.error(`    !! List error at "${prefix}": ${error.message}`);
    return allFiles;
  }
  if (!data) return allFiles;

  for (const item of data) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.id) {
      // It's a file
      allFiles.push(path);
    } else {
      // It's a folder – recurse
      const nested = await listAllFiles(client, bucketName, path);
      allFiles.push(...nested);
    }
  }
  return allFiles;
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  console.log('=== QZIP → ITACHI MIGRATION ===\n');
  console.log('Migrating 3 tables + 2 storage buckets\n');

  try {
    await migrateTables();
  } catch (err) {
    console.error('Table migration error:', err);
  }

  try {
    await migrateStorage();
  } catch (err) {
    console.error('Storage migration error:', err);
  }

  console.log('\n=== MIGRATION COMPLETE ===');
}

main().catch(console.error);
