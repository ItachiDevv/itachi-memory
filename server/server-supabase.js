const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Load OpenAI key
let openaiKey = process.env.OPENAI_API_KEY;
const openaiKeyFile = path.join(require('os').homedir(), '.eliza-openai-key');
if (!openaiKey && fs.existsSync(openaiKeyFile)) {
    const content = fs.readFileSync(openaiKeyFile, 'utf8');
    const match = content.match(/OPENAI_API_KEY=(.+)/);
    if (match) openaiKey = match[1].trim();
}

// Load Supabase credentials
let supabaseUrl = process.env.SUPABASE_URL;
let supabaseKey = process.env.SUPABASE_KEY;
const supabaseFile = path.join(require('os').homedir(), '.supabase-credentials');
if (fs.existsSync(supabaseFile)) {
    const content = fs.readFileSync(supabaseFile, 'utf8');
    const urlMatch = content.match(/SUPABASE_URL=(.+)/);
    const keyMatch = content.match(/SUPABASE_KEY=(.+)/);
    if (urlMatch) supabaseUrl = urlMatch[1].trim();
    if (keyMatch) supabaseKey = keyMatch[1].trim();
}

if (!openaiKey) {
    console.error('ERROR: No OpenAI API key found!');
    process.exit(1);
}

if (!supabaseUrl || !supabaseKey) {
    console.error('ERROR: No Supabase credentials found!');
    process.exit(1);
}

const openai = new OpenAI({ apiKey: openaiKey });
const supabase = createClient(supabaseUrl, supabaseKey);

// Generate embedding
async function getEmbedding(text) {
    const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
    });
    return response.data[0].embedding;
}

// Health check
app.get('/health', async (req, res) => {
    const { count } = await supabase.from('memories').select('*', { count: 'exact', head: true });
    res.json({ status: 'ok', memories: count || 0 });
});

// Store memory (branch + task_id aware)
app.post('/api/memory/code-change', async (req, res) => {
    try {
        const { files = [], summary, diff = '', category, project, branch, task_id } = req.body;
        if (!summary) return res.status(400).json({ error: 'Summary required' });

        const contextText = [
            `Category: ${category}`,
            `Summary: ${summary}`,
            files.length > 0 ? `Files: ${files.join(', ')}` : '',
            diff ? `Changes:\n${diff.substring(0, 500)}` : ''
        ].filter(Boolean).join('\n');

        const embedding = await getEmbedding(contextText);

        const insertObj = {
            project: project || 'default',
            category: category || 'code_change',
            content: contextText,
            summary,
            files,
            embedding
        };
        if (branch) insertObj.branch = branch;
        if (task_id) insertObj.task_id = task_id;

        const { data, error } = await supabase.from('memories').insert(insertObj).select().single();

        if (error) throw error;

        console.log(`Stored: [${category}] ${files.length} files (branch: ${branch || 'main'})`);
        res.json({ success: true, memoryId: data.id, files: files.length });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Semantic search (branch-aware)
app.get('/api/memory/search', async (req, res) => {
    try {
        const { query, limit = 5, project, category, branch } = req.query;
        if (!query) return res.status(400).json({ error: 'Query required' });

        const queryEmbedding = await getEmbedding(query);

        const params = {
            query_embedding: queryEmbedding,
            match_project: project || null,
            match_category: category || null,
            match_limit: parseInt(limit)
        };
        if (branch) params.match_branch = branch;

        const { data, error } = await supabase.rpc('match_memories', params);

        if (error) throw error;

        res.json({ query, count: data.length, results: data });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Recent memories (branch-aware)
app.get('/api/memory/recent', async (req, res) => {
    try {
        const { limit = 10, project, category, branch } = req.query;

        let query = supabase
            .from('memories')
            .select('id, project, category, content, summary, files, branch, task_id, created_at')
            .order('created_at', { ascending: false })
            .limit(parseInt(limit));

        if (project) query = query.eq('project', project);
        if (category) query = query.eq('category', category);
        if (branch) query = query.eq('branch', branch);

        const { data, error } = await query;
        if (error) throw error;

        res.json({ count: data.length, recent: data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Stats
app.get('/api/memory/stats', async (req, res) => {
    try {
        const { project } = req.query;

        let query = supabase.from('memories').select('category, files, created_at');
        if (project) query = query.eq('project', project);

        const { data, error } = await query;
        if (error) throw error;

        const byCategory = {};
        const byFile = {};
        let oldest = null;
        let newest = null;

        data.forEach(m => {
            byCategory[m.category] = (byCategory[m.category] || 0) + 1;
            (m.files || []).forEach(file => {
                byFile[file] = (byFile[file] || 0) + 1;
            });
            if (!oldest || m.created_at < oldest) oldest = m.created_at;
            if (!newest || m.created_at > newest) newest = m.created_at;
        });

        const topFiles = Object.entries(byFile)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10)
            .map(([file, count]) => ({ file, count }));

        res.json({ total: data.length, byCategory, topFiles, dateRange: { oldest, newest } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log('');
    console.log('Claude Memory Server (Supabase) running on http://localhost:' + PORT);
    console.log('');
});