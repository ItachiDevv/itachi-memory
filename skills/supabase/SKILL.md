# Supabase — Database, Auth, Storage & Edge Functions

Expert-level knowledge of Supabase for creating and managing projects, databases (Postgres), auth, storage, edge functions, and the Management API. Use when working with Supabase projects, writing SQL, managing auth, deploying edge functions, or using the Supabase CLI/API.

## Authentication & Keys

```bash
# CLI login (interactive)
supabase login

# Token-based (non-interactive, for CI/orchestration)
export SUPABASE_ACCESS_TOKEN="sbp_..."
# Get tokens: supabase.com/dashboard/account/tokens

# Project-level keys (per project, from dashboard > Settings > API)
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=eyJ...         # Public, safe for client
SUPABASE_SERVICE_ROLE_KEY=eyJ... # Secret, server-only (bypasses RLS)
```

## CLI Commands Reference

### Project Management

```bash
# Init local project config
supabase init

# Start local dev environment (Docker)
supabase start
supabase stop

# Link to remote project
supabase link --project-ref <ref>

# Status of local services
supabase status

# List remote projects
supabase projects list

# Create new project (requires SUPABASE_ACCESS_TOKEN)
supabase projects create <name> \
  --org-id <org-id> \
  --db-password <password> \
  --region us-east-1
```

### Database & Migrations

```bash
# Create new migration
supabase migration new <name>
# → creates supabase/migrations/<timestamp>_<name>.sql

# Apply migrations to remote
supabase db push

# Pull remote schema to local
supabase db pull

# Reset local database
supabase db reset

# Diff local vs remote
supabase db diff --use-migra

# Lint SQL
supabase db lint

# Dump remote schema
supabase db dump --schema public > schema.sql
```

### Edge Functions

```bash
# Create edge function
supabase functions new <name>
# → creates supabase/functions/<name>/index.ts

# Serve locally (with hot reload)
supabase functions serve <name>
supabase functions serve          # all functions

# Deploy to remote
supabase functions deploy <name>
supabase functions deploy         # all functions

# Delete function
supabase functions delete <name>

# List deployed functions
supabase functions list
```

### Secrets

```bash
# Set secrets for edge functions
supabase secrets set KEY1=value1 KEY2=value2

# List secrets
supabase secrets list

# Unset secrets
supabase secrets unset KEY1 KEY2
```

### Storage

```bash
# List buckets
supabase storage ls

# Create bucket
supabase storage create-bucket <name> --public
```

## Management API (Programmatic Project Creation)

Base URL: `https://api.supabase.com`
Auth: `Bearer <SUPABASE_ACCESS_TOKEN>`

### Organizations

```bash
# List organizations
GET /v1/organizations

# Create organization
POST /v1/organizations
{ "name": "My Org" }
```

### Projects

```bash
# Create project
POST /v1/projects
{
  "name": "my-project",
  "organization_id": "org-id",
  "db_pass": "strong-password",
  "region": "us-east-1",
  "plan": "free"
}
# Regions: us-east-1, us-west-1, eu-west-1, ap-southeast-1, etc.

# List projects
GET /v1/projects

# Get project
GET /v1/projects/{ref}

# Delete project
DELETE /v1/projects/{ref}

# Get project API keys
GET /v1/projects/{ref}/api-keys
```

### Database

```bash
# Run SQL query
POST /v1/projects/{ref}/database/query
{ "query": "SELECT * FROM users LIMIT 10" }
```

## JavaScript Client (@supabase/supabase-js)

```typescript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

// SELECT
const { data, error } = await supabase
  .from('posts')
  .select('id, title, author:users(name)')
  .eq('published', true)
  .order('created_at', { ascending: false })
  .limit(10);

// INSERT
const { data, error } = await supabase
  .from('posts')
  .insert({ title: 'New Post', body: '...' })
  .select()
  .single();

// UPDATE
const { error } = await supabase
  .from('posts')
  .update({ title: 'Updated' })
  .eq('id', postId);

// DELETE
const { error } = await supabase
  .from('posts')
  .delete()
  .eq('id', postId);

// UPSERT
const { data, error } = await supabase
  .from('posts')
  .upsert({ id: 1, title: 'Upserted' }, { onConflict: 'id' });

// RPC (call Postgres function)
const { data, error } = await supabase.rpc('function_name', { param1: 'value' });

// COUNT
const { count } = await supabase
  .from('posts')
  .select('*', { count: 'exact', head: true });
```

### Auth

```typescript
// Sign up
const { data, error } = await supabase.auth.signUp({
  email: 'user@example.com',
  password: 'password'
});

// Sign in
const { data, error } = await supabase.auth.signInWithPassword({
  email: 'user@example.com',
  password: 'password'
});

// Sign in with OAuth
const { data, error } = await supabase.auth.signInWithOAuth({
  provider: 'github'
});

// Get session
const { data: { session } } = await supabase.auth.getSession();

// Sign out
await supabase.auth.signOut();
```

### Storage

```typescript
// Upload file
const { data, error } = await supabase.storage
  .from('bucket')
  .upload('path/file.png', fileBody, { contentType: 'image/png' });

// Get public URL
const { data } = supabase.storage
  .from('bucket')
  .getPublicUrl('path/file.png');

// Download
const { data, error } = await supabase.storage
  .from('bucket')
  .download('path/file.png');

// Delete
const { error } = await supabase.storage
  .from('bucket')
  .remove(['path/file.png']);

// List files
const { data, error } = await supabase.storage
  .from('bucket')
  .list('folder', { limit: 100 });
```

### Realtime

```typescript
// Subscribe to changes
const channel = supabase
  .channel('table-changes')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'messages' },
    (payload) => console.log('New message:', payload.new)
  )
  .subscribe();

// Broadcast
const channel = supabase.channel('room1');
channel.send({ type: 'broadcast', event: 'cursor', payload: { x: 100, y: 200 } });

// Presence
const channel = supabase.channel('room1');
channel.on('presence', { event: 'sync' }, () => {
  const state = channel.presenceState();
});
channel.subscribe(async (status) => {
  if (status === 'SUBSCRIBED') {
    await channel.track({ user: 'alice', online_at: new Date() });
  }
});
```

## Common SQL Patterns

### Tables with RLS

```sql
-- Create table
CREATE TABLE posts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text,
  published boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;

-- Policy: users can read published posts
CREATE POLICY "Public posts readable"
  ON posts FOR SELECT
  USING (published = true);

-- Policy: users can CRUD their own posts
CREATE POLICY "Users manage own posts"
  ON posts FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

### pgvector (AI/Embeddings)

```sql
-- Enable extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create table with embedding column
CREATE TABLE documents (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  content text,
  embedding vector(1536)
);

-- Create index for fast similarity search
CREATE INDEX ON documents
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Similarity search function
CREATE FUNCTION match_documents(
  query_embedding vector(1536),
  match_limit int DEFAULT 5
) RETURNS TABLE (id uuid, content text, similarity float)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT d.id, d.content,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM documents d
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_limit;
END;
$$;
```

### Postgres Functions

```sql
CREATE FUNCTION increment_counter(row_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE counters SET count = count + 1 WHERE id = row_id;
END;
$$;
```

## Edge Functions (Deno)

```typescript
// supabase/functions/hello/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const { data, error } = await supabase.from('posts').select('*').limit(10);

  return new Response(JSON.stringify({ data, error }), {
    headers: { 'Content-Type': 'application/json' }
  });
});
```

## Programmatic Project Setup Pattern

```bash
# Full workflow: create project + configure + deploy
export SUPABASE_ACCESS_TOKEN="sbp_..."

# 1. Get org ID
ORG_ID=$(curl -s https://api.supabase.com/v1/organizations \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(d[0].id);")

# 2. Create project
curl -X POST https://api.supabase.com/v1/projects \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"my-project\",\"organization_id\":\"$ORG_ID\",\"db_pass\":\"$(openssl rand -base64 24)\",\"region\":\"us-east-1\",\"plan\":\"free\"}"

# 3. Wait for project to be ready, then get API keys
# 4. Apply migrations: supabase db push
# 5. Deploy edge functions: supabase functions deploy
```

## Env Vars Used

- `SUPABASE_ACCESS_TOKEN` — Management API + CLI auth (sbp_...)
- `SUPABASE_URL` — Project API URL (https://<ref>.supabase.co)
- `SUPABASE_ANON_KEY` — Public anon key (safe for client)
- `SUPABASE_SERVICE_ROLE_KEY` — Secret service key (server-only, bypasses RLS)
