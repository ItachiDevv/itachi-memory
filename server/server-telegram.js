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

// Allowed Telegram user IDs (security whitelist for task commands)
const allowedUsers = (process.env.ITACHI_ALLOWED_USERS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
    .map(Number);

function isAllowedUser(userId) {
    // If no whitelist configured, allow all (backwards compat)
    if (allowedUsers.length === 0) return true;
    return allowedUsers.includes(userId);
}

// Telegram Bot
const bot = new TelegramBot(telegramToken, { polling: true });
console.log('Telegram bot started');

// Store conversation history per user
const conversationHistory = new Map();

// Pending task creation state: chatId -> { project, userId }
const pendingTaskDescriptions = new Map();

// Known repos from env var (decoupled from orchestrator project paths)
const knownRepos = (process.env.ITACHI_REPOS || '')
    .split(',').map(r => r.trim()).filter(Boolean).sort();

// Generate embedding
async function getEmbedding(text) {
    const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
    });
    return response.data[0].embedding;
}

// Search memories (branch-aware)
async function searchMemories(query, project = null, limit = 5, branch = null, category = null) {
    const queryEmbedding = await getEmbedding(query);
    const params = {
        query_embedding: queryEmbedding,
        match_project: project,
        match_category: category,
        match_branch: branch,
        match_limit: limit
    };
    const { data, error } = await supabase.rpc('match_memories', params);
    if (error) throw error;
    return data;
}

// Get recent memories (branch-aware)
async function getRecentMemories(project = null, limit = 5, branch = null) {
    let query = supabase
        .from('memories')
        .select('id, project, category, content, summary, files, branch, task_id, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
    if (project) query = query.eq('project', project);
    if (branch) query = query.eq('branch', branch);
    const { data, error } = await query;
    if (error) throw error;
    return data;
}

// Extract facts/preferences from conversation and store as memories
async function extractAndStoreFacts(userMessage, assistantResponse, userId) {
    const prompt = `Extract any factual statements, user preferences, decisions, or project details from this conversation exchange. Return a JSON array of objects with "fact" (the fact statement) and "project" (project name if mentioned, otherwise "general"). Only include concrete, reusable facts — not greetings or filler. If there are no facts worth storing, return an empty array.

User: ${userMessage}
Assistant: ${assistantResponse}

Respond ONLY with a valid JSON array, no markdown fences.`;

    const result = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 512,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
    });

    const raw = result.choices[0].message.content.trim();
    let facts;
    try {
        facts = JSON.parse(raw);
    } catch {
        return; // unparseable response, skip silently
    }
    if (!Array.isArray(facts) || facts.length === 0) return;

    for (const { fact, project } of facts) {
        if (!fact) continue;
        try {
            const embedding = await getEmbedding(fact);

            // Dedup: skip if a very similar fact already exists
            const { data: existing } = await supabase.rpc('match_memories', {
                query_embedding: embedding,
                match_project: null,
                match_category: 'fact',
                match_branch: null,
                match_limit: 1
            });
            if (existing?.length > 0 && existing[0].similarity > 0.92) continue;

            await supabase.from('memories').insert({
                project: project || 'general',
                category: 'fact',
                content: fact,
                summary: fact,
                files: [],
                embedding
            });
        } catch {
            // silent per-fact errors
        }
    }
}

// Summarize evicted conversation messages and store as a memory
async function summarizeAndStoreConversation(evictedMessages, userId) {
    const transcript = evictedMessages
        .map(m => `${m.role}: ${m.content}`)
        .join('\n');

    const result = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        temperature: 0,
        messages: [{
            role: 'user',
            content: `Summarize this conversation in 2-3 sentences. Focus on key topics, decisions, and projects discussed:\n\n${transcript}`
        }]
    });

    const summary = result.choices[0].message.content.trim();
    const embedding = await getEmbedding(summary);

    await supabase.from('memories').insert({
        project: 'general',
        category: 'conversation',
        content: transcript.substring(0, 2000),
        summary,
        files: [],
        embedding
    });
}

// Chat with Claude/OpenAI
async function chat(userMessage, userId, memories = [], facts = [], conversations = []) {
    if (!conversationHistory.has(userId)) {
        conversationHistory.set(userId, []);
    }
    const history = conversationHistory.get(userId);

    let memoryContext = '';
    if (memories.length > 0) {
        memoryContext = '\n\nRelevant memories from your coding sessions:\n' +
            memories.map(m => `- [${m.category}] ${m.summary} (Files: ${m.files?.join(', ') || 'none'})`).join('\n');
    }

    let factsContext = '';
    if (facts.length > 0) {
        factsContext = '\n\nKnown facts and preferences:\n' +
            facts.map(f => `- ${f.summary}`).join('\n');
    }

    let conversationContext = '';
    if (conversations.length > 0) {
        conversationContext = '\n\nPrevious conversation summaries:\n' +
            conversations.map(c => `- ${c.summary}`).join('\n');
    }

    const systemPrompt = `You are Itachi, a helpful AI assistant with access to the user's coding project memories.
You can recall what they've been working on and help them with their projects.
Be concise but helpful. You're chatting via Telegram so keep responses reasonably short.
${memoryContext}${factsContext}${conversationContext}`;

    history.push({ role: 'user', content: userMessage });

    // Capture evicted messages before trimming
    const evicted = [];
    while (history.length > 10) { evicted.push(history.shift()); }
    if (evicted.length > 0) {
        summarizeAndStoreConversation(evicted, userId).catch(() => {});
    }

    let response;
    if (anthropic) {
        const result = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            system: systemPrompt,
            messages: history
        });
        response = result.content[0].text;
    } else {
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

    history.push({ role: 'assistant', content: response });
    return response;
}

// ============ Telegram Command Handlers ============

bot.onText(/\/leave/, async (msg) => {
    if (!isAllowedUser(msg.from.id)) return;
    try {
        await bot.sendMessage(msg.chat.id, 'Goodbye!');
        await bot.leaveChat(msg.chat.id);
    } catch (error) {
        bot.sendMessage(msg.chat.id, `Error: ${error.message}`);
    }
});

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `Hi! I'm Itachi.\n\n` +
        `I have access to your coding project memories and can dispatch tasks to Claude Code.\n\n` +
        `Memory Commands:\n` +
        `/recall <query> - Search your memories\n` +
        `/recent - Show recent changes\n` +
        `/projects - List your projects\n` +
        `/clear - Clear chat history\n\n` +
        `Task Commands:\n` +
        `/task - Pick a repo and queue a coding task\n` +
        `/task <project> <description> - Quick task shortcut\n` +
        `/status [task_id] - Check task status\n` +
        `/cancel <task_id> - Cancel a queued/running task\n` +
        `/queue - Show queued/running tasks\n` +
        `/repos - List configured projects\n\n` +
        `Or just chat with me!`
    );
});

bot.onText(/\/recall (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const query = match[1];

    bot.sendMessage(chatId, `Searching for "${query}"...`);

    try {
        const memories = await searchMemories(query, null, 5);
        if (memories.length === 0) {
            bot.sendMessage(chatId, `No memories found for "${query}"`);
            return;
        }

        let response = `Found ${memories.length} memories:\n\n`;
        memories.forEach((m, i) => {
            response += `${i + 1}. [${m.category}] ${m.summary}\n`;
            response += `   Files: ${m.files?.join(', ') || 'none'}\n`;
            response += `   Project: ${m.project}\n\n`;
        });

        bot.sendMessage(chatId, response);
    } catch (error) {
        bot.sendMessage(chatId, `Error: ${error.message}`);
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

        let response = `Recent changes:\n\n`;
        memories.forEach((m, i) => {
            response += `${i + 1}. [${m.category}] ${m.summary}\n`;
            response += `   Project: ${m.project}\n\n`;
        });

        bot.sendMessage(chatId, response);
    } catch (error) {
        bot.sendMessage(chatId, `Error: ${error.message}`);
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

        bot.sendMessage(chatId, `Your projects:\n\n${projects.map(p => `- ${p}`).join('\n')}`);
    } catch (error) {
        bot.sendMessage(chatId, `Error: ${error.message}`);
    }
});

bot.onText(/\/clear/, (msg) => {
    conversationHistory.delete(msg.from.id);
    bot.sendMessage(msg.chat.id, `Chat history cleared.`);
});

// ============ Task Commands ============

// /task <project> <description> — shortcut (backward compat)
bot.onText(/\/task\s+(\S+)\s+(.+)/s, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAllowedUser(userId)) {
        bot.sendMessage(chatId, 'Not authorized for task commands.');
        return;
    }

    const project = match[1];
    const description = match[2].trim();

    try {
        const { data, error } = await supabase.from('tasks').insert({
            description,
            project,
            telegram_chat_id: chatId,
            telegram_user_id: userId,
            status: 'queued'
        }).select().single();

        if (error) throw error;

        const { count } = await supabase
            .from('tasks')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'queued');

        const shortId = data.id.substring(0, 8);
        bot.sendMessage(chatId,
            `Task queued!\n\n` +
            `ID: ${shortId}\n` +
            `Project: ${project}\n` +
            `Description: ${description}\n` +
            `Queue position: ${count || 1}\n\n` +
            `I'll notify you when it completes.`
        );
    } catch (error) {
        bot.sendMessage(chatId, `Error creating task: ${error.message}`);
    }
});

// /task (no args) — interactive repo picker
bot.onText(/\/task$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAllowedUser(userId)) {
        bot.sendMessage(chatId, 'Not authorized for task commands.');
        return;
    }

    if (knownRepos.length === 0) {
        bot.sendMessage(chatId, 'No repos configured. Set ITACHI_REPOS env var.');
        return;
    }

    // Build inline keyboard grid (2 columns)
    const buttons = knownRepos.map(repo => ({
        text: repo,
        callback_data: `task_repo:${repo}`
    }));

    const keyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
        const row = [buttons[i]];
        if (buttons[i + 1]) row.push(buttons[i + 1]);
        keyboard.push(row);
    }

    bot.sendMessage(chatId, 'Pick a repo for the task:', {
        reply_markup: { inline_keyboard: keyboard }
    });
});

// Callback query handler for repo selection
bot.on('callback_query', async (query) => {
    const data = query.data;
    if (!data?.startsWith('task_repo:')) return;

    const repo = data.replace('task_repo:', '');
    const chatId = query.message.chat.id;
    const userId = query.from.id;

    // Store pending state
    pendingTaskDescriptions.set(chatId, { project: repo, userId });

    // Acknowledge the button press
    await bot.answerCallbackQuery(query.id);

    // Edit the original message to show selection & prompt for description
    await bot.editMessageText(
        `Selected: *${repo}*\n\nNow describe the task:`,
        {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown'
        }
    );
});

// /status [task_id]
bot.onText(/\/status\s*(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAllowedUser(userId)) {
        bot.sendMessage(chatId, 'Not authorized for task commands.');
        return;
    }

    const taskIdPrefix = match[1]?.trim();

    try {
        if (taskIdPrefix) {
            // Find task by ID prefix
            const { data, error } = await supabase
                .from('tasks')
                .select('*')
                .eq('telegram_user_id', userId)
                .ilike('id', `${taskIdPrefix}%`)
                .limit(1)
                .single();

            if (error || !data) {
                bot.sendMessage(chatId, `Task not found: ${taskIdPrefix}`);
                return;
            }

            let msg_text = `Task ${data.id.substring(0, 8)}:\n\n` +
                `Status: ${data.status}\n` +
                `Project: ${data.project}\n` +
                `Description: ${data.description}\n`;

            if (data.orchestrator_id) msg_text += `Runner: ${data.orchestrator_id}\n`;
            if (data.started_at) msg_text += `Started: ${new Date(data.started_at).toLocaleString()}\n`;
            if (data.completed_at) msg_text += `Completed: ${new Date(data.completed_at).toLocaleString()}\n`;
            if (data.result_summary) msg_text += `\nResult: ${data.result_summary}\n`;
            if (data.error_message) msg_text += `\nError: ${data.error_message}\n`;
            if (data.pr_url) msg_text += `\nPR: ${data.pr_url}\n`;
            if (data.files_changed?.length > 0) msg_text += `\nFiles: ${data.files_changed.join(', ')}\n`;

            bot.sendMessage(chatId, msg_text);
        } else {
            // Show recent tasks
            const { data, error } = await supabase
                .from('tasks')
                .select('id, project, description, status, created_at')
                .eq('telegram_user_id', userId)
                .order('created_at', { ascending: false })
                .limit(5);

            if (error) throw error;

            if (!data?.length) {
                bot.sendMessage(chatId, 'No tasks found.');
                return;
            }

            const statusIcon = { queued: '[]', claimed: '..', running: '>>', completed: 'OK', failed: '!!', cancelled: '--', timeout: 'TO' };
            let response = 'Recent tasks:\n\n';
            data.forEach(t => {
                const icon = statusIcon[t.status] || '??';
                response += `[${icon}] ${t.id.substring(0, 8)} | ${t.project} | ${t.description.substring(0, 40)}\n`;
            });

            bot.sendMessage(chatId, response);
        }
    } catch (error) {
        bot.sendMessage(chatId, `Error: ${error.message}`);
    }
});

// /cancel <task_id>
bot.onText(/\/cancel\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAllowedUser(userId)) {
        bot.sendMessage(chatId, 'Not authorized for task commands.');
        return;
    }

    const taskIdPrefix = match[1].trim();

    try {
        // Find the task first
        const { data: task, error: findErr } = await supabase
            .from('tasks')
            .select('*')
            .eq('telegram_user_id', userId)
            .ilike('id', `${taskIdPrefix}%`)
            .limit(1)
            .single();

        if (findErr || !task) {
            bot.sendMessage(chatId, `Task not found: ${taskIdPrefix}`);
            return;
        }

        if (!['queued', 'claimed', 'running'].includes(task.status)) {
            bot.sendMessage(chatId, `Task ${taskIdPrefix} is already ${task.status}, cannot cancel.`);
            return;
        }

        const { error } = await supabase
            .from('tasks')
            .update({ status: 'cancelled', completed_at: new Date().toISOString() })
            .eq('id', task.id);

        if (error) throw error;

        bot.sendMessage(chatId, `Task ${taskIdPrefix} cancelled.`);
    } catch (error) {
        bot.sendMessage(chatId, `Error: ${error.message}`);
    }
});

// /queue
bot.onText(/\/queue/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAllowedUser(userId)) {
        bot.sendMessage(chatId, 'Not authorized for task commands.');
        return;
    }

    try {
        const { data, error } = await supabase
            .from('tasks')
            .select('id, project, description, status, orchestrator_id, created_at')
            .in('status', ['queued', 'claimed', 'running'])
            .order('priority', { ascending: false })
            .order('created_at', { ascending: true });

        if (error) throw error;

        if (!data?.length) {
            bot.sendMessage(chatId, 'Queue is empty.');
            return;
        }

        let response = `Active queue (${data.length} tasks):\n\n`;
        data.forEach((t, i) => {
            const runner = t.orchestrator_id ? ` [${t.orchestrator_id}]` : '';
            response += `${i + 1}. [${t.status}]${runner} ${t.project}: ${t.description.substring(0, 50)}\n`;
        });

        bot.sendMessage(chatId, response);
    } catch (error) {
        bot.sendMessage(chatId, `Error: ${error.message}`);
    }
});

// /repos - list configured project names (env var first, DB fallback)
bot.onText(/\/repos/, async (msg) => {
    const chatId = msg.chat.id;

    if (knownRepos.length > 0) {
        bot.sendMessage(chatId, `Configured repos (${knownRepos.length}):\n\n${knownRepos.map(p => `- ${p}`).join('\n')}`);
        return;
    }

    // Fallback: query DB for unique projects
    try {
        const [memResult, taskResult] = await Promise.all([
            supabase.from('memories').select('project').limit(1000),
            supabase.from('tasks').select('project').limit(1000)
        ]);

        const projects = new Set();
        (memResult.data || []).forEach(m => projects.add(m.project));
        (taskResult.data || []).forEach(t => projects.add(t.project));

        if (projects.size === 0) {
            bot.sendMessage(chatId, 'No projects found. Set ITACHI_REPOS env var.');
            return;
        }

        bot.sendMessage(chatId, `Known projects:\n\n${[...projects].sort().map(p => `- ${p}`).join('\n')}`);
    } catch (error) {
        bot.sendMessage(chatId, `Error: ${error.message}`);
    }
});

// Handle regular messages (chat with AI, or pending task description)
bot.on('message', async (msg) => {
    if (msg.text?.startsWith('/')) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userMessage = msg.text;

    if (!userMessage) return;

    // Check if user is mid-flow for interactive /task
    const pending = pendingTaskDescriptions.get(chatId);
    if (pending) {
        pendingTaskDescriptions.delete(chatId);

        if (!isAllowedUser(userId)) {
            bot.sendMessage(chatId, 'Not authorized for task commands.');
            return;
        }

        const description = userMessage.trim();
        try {
            const { data, error } = await supabase.from('tasks').insert({
                description,
                project: pending.project,
                telegram_chat_id: chatId,
                telegram_user_id: userId,
                status: 'queued'
            }).select().single();

            if (error) throw error;

            const { count } = await supabase
                .from('tasks')
                .select('*', { count: 'exact', head: true })
                .eq('status', 'queued');

            const shortId = data.id.substring(0, 8);
            bot.sendMessage(chatId,
                `Task queued!\n\n` +
                `ID: ${shortId}\n` +
                `Project: ${pending.project}\n` +
                `Description: ${description}\n` +
                `Queue position: ${count || 1}\n\n` +
                `I'll notify you when it completes.`
            );
        } catch (error) {
            bot.sendMessage(chatId, `Error creating task: ${error.message}`);
        }
        return;
    }

    try {
        // Generate embedding once, run 3 parallel searches
        const queryEmbedding = await getEmbedding(userMessage);

        const [codeResults, factResults, conversationResults] = await Promise.all([
            supabase.rpc('match_memories', {
                query_embedding: queryEmbedding,
                match_project: null,
                match_category: null,
                match_branch: null,
                match_limit: 3
            }),
            supabase.rpc('match_memories', {
                query_embedding: queryEmbedding,
                match_project: null,
                match_category: 'fact',
                match_branch: null,
                match_limit: 3
            }),
            supabase.rpc('match_memories', {
                query_embedding: queryEmbedding,
                match_project: null,
                match_category: 'conversation',
                match_branch: null,
                match_limit: 2
            })
        ]);

        const memories = codeResults.data || [];
        const facts = factResults.data || [];
        const conversations = conversationResults.data || [];

        const response = await chat(userMessage, userId, memories, facts, conversations);
        bot.sendMessage(chatId, response);

        // Fire-and-forget: extract facts from this exchange
        extractAndStoreFacts(userMessage, response, userId).catch(() => {});
    } catch (error) {
        console.error('Chat error:', error);
        bot.sendMessage(chatId, `Error: ${error.message}`);
    }
});

// ============ Task Completion Notifier ============
// Polls for recently completed/failed tasks and sends Telegram notifications

const notifiedTasks = new Set();

async function pollTaskCompletions() {
    try {
        const { data, error } = await supabase
            .from('tasks')
            .select('*')
            .in('status', ['completed', 'failed', 'timeout'])
            .order('completed_at', { ascending: false })
            .limit(10);

        if (error || !data) return;

        for (const task of data) {
            if (notifiedTasks.has(task.id)) continue;

            // Only notify tasks completed in the last 5 minutes
            const completedAt = new Date(task.completed_at);
            if (Date.now() - completedAt.getTime() > 5 * 60 * 1000) {
                notifiedTasks.add(task.id);
                continue;
            }

            notifiedTasks.add(task.id);

            const shortId = task.id.substring(0, 8);
            let msg;

            if (task.status === 'completed') {
                msg = `Task ${shortId} completed!\n\n` +
                    `Project: ${task.project}\n` +
                    `Description: ${task.description.substring(0, 100)}\n`;
                if (task.result_summary) msg += `\nResult: ${task.result_summary}\n`;
                if (task.pr_url) msg += `\nPR: ${task.pr_url}\n`;
                if (task.files_changed?.length > 0) msg += `\nFiles changed: ${task.files_changed.join(', ')}\n`;
            } else {
                msg = `Task ${shortId} ${task.status}!\n\n` +
                    `Project: ${task.project}\n` +
                    `Description: ${task.description.substring(0, 100)}\n`;
                if (task.error_message) msg += `\nError: ${task.error_message}\n`;
            }

            try {
                await bot.sendMessage(task.telegram_chat_id, msg);
            } catch (sendErr) {
                console.error(`Failed to notify chat ${task.telegram_chat_id}:`, sendErr.message);
            }
        }
    } catch (err) {
        // Silent - don't crash the poller
    }
}

// Poll every 10 seconds
setInterval(pollTaskCompletions, 10000);

// ============ Express API (for Claude Code hooks) ============

app.get('/health', async (req, res) => {
    const { count: memCount } = await supabase.from('memories').select('*', { count: 'exact', head: true });
    const { count: taskCount } = await supabase.from('tasks').select('*', { count: 'exact', head: true }).in('status', ['queued', 'claimed', 'running']);
    res.json({ status: 'ok', memories: memCount || 0, active_tasks: taskCount || 0, telegram: 'active' });
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

        const memories = await searchMemories(query, project, parseInt(limit), branch);
        res.json({ query, count: memories.length, results: memories });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Recent memories (branch-aware)
app.get('/api/memory/recent', async (req, res) => {
    try {
        const { limit = 10, project, branch } = req.query;
        const memories = await getRecentMemories(project, parseInt(limit), branch);
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

// ============ Task Queue API (for Orchestrator) ============

// Create task
app.post('/api/tasks', async (req, res) => {
    try {
        const { description, project, repo_url, branch, priority, model, max_budget_usd, telegram_chat_id, telegram_user_id } = req.body;
        if (!description || !project) {
            return res.status(400).json({ error: 'description and project required' });
        }
        if (!telegram_chat_id || !telegram_user_id) {
            return res.status(400).json({ error: 'telegram_chat_id and telegram_user_id required' });
        }

        const insertObj = {
            description,
            project,
            telegram_chat_id,
            telegram_user_id,
            status: 'queued'
        };
        if (repo_url) insertObj.repo_url = repo_url;
        if (branch) insertObj.branch = branch;
        if (priority != null) insertObj.priority = priority;
        if (model) insertObj.model = model;
        if (max_budget_usd != null) insertObj.max_budget_usd = max_budget_usd;

        const { data, error } = await supabase.from('tasks').insert(insertObj).select().single();
        if (error) throw error;

        res.json({ success: true, task: data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Claim next queued task (atomic - for orchestrator)
app.get('/api/tasks/next', async (req, res) => {
    try {
        const { orchestrator_id } = req.query;
        if (!orchestrator_id) {
            return res.status(400).json({ error: 'orchestrator_id required' });
        }

        const { data, error } = await supabase.rpc('claim_next_task', {
            p_orchestrator_id: orchestrator_id
        });

        if (error) throw error;

        if (!data || data.length === 0) {
            return res.json({ task: null });
        }

        res.json({ task: data[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update task (for orchestrator to report progress/results)
app.patch('/api/tasks/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = {};

        const allowedFields = [
            'status', 'target_branch', 'session_id', 'result_summary',
            'result_json', 'error_message', 'files_changed', 'pr_url',
            'workspace_path', 'started_at', 'completed_at'
        ];

        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                updates[field] = req.body[field];
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        const { data, error } = await supabase
            .from('tasks')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, task: data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get task details
app.get('/api/tasks/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('tasks')
            .select('*')
            .eq('id', id)
            .single();

        if (error) throw error;

        res.json({ task: data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// List tasks (for a user)
app.get('/api/tasks', async (req, res) => {
    try {
        const { user_id, status, limit = 10 } = req.query;

        let query = supabase
            .from('tasks')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(parseInt(limit));

        if (user_id) query = query.eq('telegram_user_id', parseInt(user_id));
        if (status) query = query.eq('status', status);

        const { data, error } = await query;
        if (error) throw error;

        res.json({ count: data.length, tasks: data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Notify endpoint (orchestrator can trigger immediate Telegram notification)
app.post('/api/tasks/:id/notify', async (req, res) => {
    try {
        const { id } = req.params;
        const { data: task, error } = await supabase
            .from('tasks')
            .select('*')
            .eq('id', id)
            .single();

        if (error) throw error;

        const shortId = task.id.substring(0, 8);
        let msg;

        if (task.status === 'completed') {
            msg = `Task ${shortId} completed!\n\n` +
                `Project: ${task.project}\n` +
                `Description: ${task.description.substring(0, 100)}\n`;
            if (task.result_summary) msg += `\nResult: ${task.result_summary}\n`;
            if (task.pr_url) msg += `\nPR: ${task.pr_url}\n`;
            if (task.files_changed?.length > 0) msg += `\nFiles changed: ${task.files_changed.join(', ')}\n`;
        } else if (['failed', 'timeout'].includes(task.status)) {
            msg = `Task ${shortId} ${task.status}!\n\n` +
                `Project: ${task.project}\n`;
            if (task.error_message) msg += `Error: ${task.error_message}\n`;
        } else {
            msg = `Task ${shortId} status: ${task.status}\n` +
                `Project: ${task.project}\n`;
        }

        await bot.sendMessage(task.telegram_chat_id, msg);
        notifiedTasks.add(task.id);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log('');
    console.log('===========================================');
    console.log('  Itachi Memory Server Running!');
    console.log('===========================================');
    console.log(`  API: http://localhost:${PORT}`);
    console.log(`  Telegram: Active`);
    console.log(`  AI: ${anthropic ? 'Claude' : 'OpenAI'}`);
    console.log(`  Allowed users: ${allowedUsers.length > 0 ? allowedUsers.join(', ') : 'all'}`);
    console.log('===========================================');
    console.log('');
});
