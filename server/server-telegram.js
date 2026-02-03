const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk').default;
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Load credentials
function loadCredential(envVar, fileName, pattern) {
    let value = process.env[envVar];
    const filePath = path.join(require('os').homedir(), fileName);
    if (!value && fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (pattern) {
            const match = content.match(pattern);
            if (match) value = match[1].trim();
        } else {
            value = content;
        }
    }
    return value;
}

const openaiKey = loadCredential('OPENAI_API_KEY', '.eliza-openai-key', /OPENAI_API_KEY=(.+)/);
const anthropicKey = loadCredential('ANTHROPIC_API_KEY', '.anthropic-key', /ANTHROPIC_API_KEY=(.+)/) || process.env.ANTHROPIC_API_KEY;
const supabaseUrl = loadCredential('SUPABASE_URL', '.supabase-credentials', /SUPABASE_URL=(.+)/);
const supabaseKey = loadCredential('SUPABASE_KEY', '.supabase-credentials', /SUPABASE_KEY=(.+)/);
const telegramToken = loadCredential('TELEGRAM_BOT_TOKEN', '.telegram-bot-token', null);

if (!openaiKey) { console.error('ERROR: No OpenAI API key!'); process.exit(1); }
if (!supabaseUrl || !supabaseKey) { console.error('ERROR: No Supabase credentials!'); process.exit(1); }
if (!telegramToken) { console.error('ERROR: No Telegram bot token!'); process.exit(1); }

const openai = new OpenAI({ apiKey: openaiKey });
const supabase = createClient(supabaseUrl, supabaseKey);

// Anthropic client (optional - will use if key exists)
let anthropic = null;
if (anthropicKey) {
    anthropic = new Anthropic({ apiKey: anthropicKey });
    console.log('Anthropic API enabled');
} else {
    console.log('No Anthropic key - using OpenAI for chat');
}

// Telegram Bot
const bot = new TelegramBot(telegramToken, { polling: true });
console.log('Telegram bot started');

// Store conversation history per user
const conversationHistory = new Map();

// Generate embedding
async function getEmbedding(text) {
    const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
    });
    return response.data[0].embedding;
}

// Search memories
async function searchMemories(query, project = null, limit = 5) {
    const queryEmbedding = await getEmbedding(query);
    const { data, error } = await supabase.rpc('match_memories', {
        query_embedding: queryEmbedding,
        match_project: project,
        match_category: null,
        match_limit: limit
    });
    if (error) throw error;
    return data;
}

// Get recent memories
async function getRecentMemories(project = null, limit = 5) {
    let query = supabase
        .from('memories')
        .select('id, project, category, content, summary, files, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
    if (project) query = query.eq('project', project);
    const { data, error } = await query;
    if (error) throw error;
    return data;
}

// Chat with Claude/OpenAI
async function chat(userMessage, userId, memories = []) {
    // Get or create conversation history
    if (!conversationHistory.has(userId)) {
        conversationHistory.set(userId, []);
    }
    const history = conversationHistory.get(userId);

    // Build context from memories
    let memoryContext = '';
    if (memories.length > 0) {
        memoryContext = '\n\nRelevant memories from your coding sessions:\n' +
            memories.map(m => `- [${m.category}] ${m.summary} (Files: ${m.files?.join(', ') || 'none'})`).join('\n');
    }

    const systemPrompt = `You are ElizaClaude, a helpful AI assistant with access to the user's coding project memories. 
You can recall what they've been working on and help them with their projects.
Be concise but helpful. You're chatting via Telegram so keep responses reasonably short.
${memoryContext}`;

    // Add user message to history
    history.push({ role: 'user', content: userMessage });

    // Keep only last 10 messages
    while (history.length > 10) {
        history.shift();
    }

    let response;

    if (anthropic) {
        // Use Claude
        const result = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            system: systemPrompt,
            messages: history
        });
        response = result.content[0].text;
    } else {
        // Use OpenAI
        const result = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            max_tokens: 1024,
            messages: [
                { role: 'system', content: systemPrompt },
                ...history
            ]
        });
        response = result.choices[0].message.content;
    }

    // Add assistant response to history
    history.push({ role: 'assistant', content: response });

    return response;
}

// Telegram command handlers
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 
        `👋 Hi! I'm ElizaClaude.\n\n` +
        `I have access to your coding project memories and can help you with your work.\n\n` +
        `Commands:\n` +
        `/recall <query> - Search your memories\n` +
        `/recent - Show recent changes\n` +
        `/projects - List your projects\n` +
        `/clear - Clear chat history\n\n` +
        `Or just chat with me!`
    );
});

bot.onText(/\/recall (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const query = match[1];

    bot.sendMessage(chatId, `🔍 Searching for "${query}"...`);

    try {
        const memories = await searchMemories(query, null, 5);
        if (memories.length === 0) {
            bot.sendMessage(chatId, `No memories found for "${query}"`);
            return;
        }

        let response = `📚 Found ${memories.length} memories:\n\n`;
        memories.forEach((m, i) => {
            response += `${i + 1}. [${m.category}] ${m.summary}\n`;
            response += `   Files: ${m.files?.join(', ') || 'none'}\n`;
            response += `   Project: ${m.project}\n\n`;
        });

        bot.sendMessage(chatId, response);
    } catch (error) {
        bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});

bot.onText(/\/recent/, async (msg) => {
    const chatId = msg.chat.id;

    try {
        const memories = await getRecentMemories(null, 5);
        if (memories.length === 0) {
            bot.sendMessage(chatId, `No recent memories found.`);
            return;
        }

        let response = `📜 Recent changes:\n\n`;
        memories.forEach((m, i) => {
            response += `${i + 1}. [${m.category}] ${m.summary}\n`;
            response += `   Project: ${m.project}\n\n`;
        });

        bot.sendMessage(chatId, response);
    } catch (error) {
        bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});

bot.onText(/\/projects/, async (msg) => {
    const chatId = msg.chat.id;

    try {
        const { data, error } = await supabase
            .from('memories')
            .select('project')
            .limit(1000);

        if (error) throw error;

        const projects = [...new Set(data.map(m => m.project))];

        if (projects.length === 0) {
            bot.sendMessage(chatId, `No projects found.`);
            return;
        }

        bot.sendMessage(chatId, `📁 Your projects:\n\n• ${projects.join('\n• ')}`);
    } catch (error) {
        bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});

bot.onText(/\/clear/, (msg) => {
    conversationHistory.delete(msg.from.id);
    bot.sendMessage(msg.chat.id, `🗑️ Chat history cleared.`);
});

// Handle regular messages (chat with AI)
bot.on('message', async (msg) => {
    // Skip commands
    if (msg.text?.startsWith('/')) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userMessage = msg.text;

    if (!userMessage) return;

    try {
        // Search for relevant memories
        const memories = await searchMemories(userMessage, null, 3);

        // Get AI response
        const response = await chat(userMessage, userId, memories);

        bot.sendMessage(chatId, response);
    } catch (error) {
        console.error('Chat error:', error);
        bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});

// ============ Express API (for Claude Code) ============

app.get('/health', async (req, res) => {
    const { count } = await supabase.from('memories').select('*', { count: 'exact', head: true });
    res.json({ status: 'ok', memories: count || 0, telegram: 'active' });
});

app.post('/api/memory/code-change', async (req, res) => {
    try {
        const { files = [], summary, diff = '', category, project } = req.body;
        if (!summary) return res.status(400).json({ error: 'Summary required' });

        const contextText = [
            `Category: ${category}`,
            `Summary: ${summary}`,
            files.length > 0 ? `Files: ${files.join(', ')}` : '',
            diff ? `Changes:\n${diff.substring(0, 500)}` : ''
        ].filter(Boolean).join('\n');

        const embedding = await getEmbedding(contextText);

        const { data, error } = await supabase.from('memories').insert({
            project: project || 'default',
            category: category || 'code_change',
            content: contextText,
            summary,
            files,
            embedding
        }).select().single();

        if (error) throw error;

        console.log(`Stored: [${category}] ${files.length} files`);
        res.json({ success: true, memoryId: data.id, files: files.length });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/memory/search', async (req, res) => {
    try {
        const { query, limit = 5, project, category } = req.query;
        if (!query) return res.status(400).json({ error: 'Query required' });

        const memories = await searchMemories(query, project, parseInt(limit));
        res.json({ query, count: memories.length, results: memories });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/memory/recent', async (req, res) => {
    try {
        const { limit = 10, project } = req.query;
        const memories = await getRecentMemories(project, parseInt(limit));
        res.json({ count: memories.length, recent: memories });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

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
    console.log('===========================================');
    console.log('  ElizaClaude Server Running!');
    console.log('===========================================');
    console.log(`  API: http://localhost:${PORT}`);
    console.log(`  Telegram: Active`);
    console.log(`  AI: ${anthropic ? 'Claude' : 'OpenAI'}`);
    console.log('===========================================');
    console.log('');
});