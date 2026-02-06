#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, dirname, basename } from "path";

// ============ Config ============
const API_URL =
  process.env.ITACHI_API_URL ||
  "http://swoo0o4okwk8ocww4g4ks084.77.42.84.38.sslip.io";

// ============ Project Resolution ============
function resolveProject() {
  // 1. Env var
  if (process.env.ITACHI_PROJECT_NAME) return process.env.ITACHI_PROJECT_NAME;

  // 2. Walk up to find .itachi-project file
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const fp = join(dir, ".itachi-project");
    if (existsSync(fp)) {
      return readFileSync(fp, "utf8").trim();
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 3. Git remote
  try {
    const remote = execSync("git remote get-url origin", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
    }).trim();
    // Extract repo name from URL
    const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {}

  // 4. Basename of cwd
  return basename(process.cwd());
}

// ============ API Helper ============
async function apiCall(method, path, body) {
  const url = `${API_URL}${path}`;
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: res.status };
  }
}

// ============ Tool Definitions ============
const TOOLS = [
  {
    name: "memory_search",
    description:
      "Semantic vector search across all stored memories and session summaries. Use this to find relevant past work, patterns, and decisions.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        project: {
          type: "string",
          description: "Project name filter (auto-detected if omitted)",
        },
        limit: {
          type: "number",
          description: "Max results (default 10)",
        },
        category: {
          type: "string",
          description:
            "Filter by category: decision, pattern, bug_fix, architecture, refactor, feature, learning",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_recent",
    description:
      "Get recent memories chronologically. Good for reviewing what was done in recent sessions.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name filter (auto-detected if omitted)",
        },
        limit: {
          type: "number",
          description: "Max results (default 10)",
        },
      },
      required: [],
    },
  },
  {
    name: "memory_store",
    description:
      "Store a new memory or insight for future reference. Use this to record decisions, patterns, or important findings mid-session.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "The memory content to store",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Related file paths",
        },
        diff: {
          type: "string",
          description: "Related code diff if applicable",
        },
        category: {
          type: "string",
          description:
            "Category: decision, pattern, bug_fix, architecture, refactor, feature, learning",
        },
        project: {
          type: "string",
          description: "Project name (auto-detected if omitted)",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "memory_stats",
    description:
      "Get memory statistics — total count, breakdown by category, top files, date range.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name filter (auto-detected if omitted)",
        },
      },
      required: [],
    },
  },
  {
    name: "session_briefing",
    description:
      "Get a full session briefing with recent sessions, hot files, active patterns, style preferences, active tasks, and warnings. Useful at session start or when context is needed.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name (auto-detected if omitted)",
        },
        branch: {
          type: "string",
          description: "Git branch name for branch-specific context",
        },
      },
      required: [],
    },
  },
  {
    name: "project_hot_files",
    description:
      "Get the most frequently edited files in a project. Shows edit counts and last edit timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name (auto-detected if omitted)",
        },
      },
      required: [],
    },
  },
  {
    name: "task_list",
    description:
      "List Itachi tasks (orchestrator task queue). Filter by status to see pending, claimed, or completed tasks.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Filter by status: pending, claimed, running, completed, failed",
        },
        limit: {
          type: "number",
          description: "Max results (default 20)",
        },
      },
      required: [],
    },
  },
  {
    name: "task_create",
    description:
      "Create a new task in the Itachi orchestrator queue. The task will be picked up by an available orchestrator.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Task description — what needs to be done",
        },
        project: {
          type: "string",
          description: "Target project name (auto-detected if omitted)",
        },
        priority: {
          type: "number",
          description: "Priority 1-10 (default 5, higher = more urgent)",
        },
      },
      required: ["description"],
    },
  },
  {
    name: "sync_list",
    description:
      "List synced files for a project or globally. Shows file paths, versions, and who last updated them.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "Project/repo name to list sync files for (default: '_global')",
        },
      },
      required: [],
    },
  },
];

// ============ Tool Handlers ============

async function handleMemorySearch(args) {
  const project = args.project || resolveProject();
  const params = new URLSearchParams({ q: args.query, project });
  if (args.limit) params.set("limit", String(args.limit));
  if (args.category) params.set("category", args.category);
  return apiCall("GET", `/api/memory/search?${params}`);
}

async function handleMemoryRecent(args) {
  const project = args.project || resolveProject();
  const params = new URLSearchParams({ project });
  if (args.limit) params.set("limit", String(args.limit));
  return apiCall("GET", `/api/memory/recent?${params}`);
}

async function handleMemoryStore(args) {
  const project = args.project || resolveProject();
  return apiCall("POST", "/api/memory/code-change", {
    project,
    summary: args.summary,
    files_changed: args.files || [],
    diff: args.diff || "",
    category: args.category || "learning",
  });
}

async function handleMemoryStats(args) {
  const project = args.project || resolveProject();
  const params = new URLSearchParams({ project });
  return apiCall("GET", `/api/memory/stats?${params}`);
}

async function handleSessionBriefing(args) {
  const project = args.project || resolveProject();
  const params = new URLSearchParams({ project });
  if (args.branch) params.set("branch", args.branch);
  return apiCall("GET", `/api/session/briefing?${params}`);
}

async function handleProjectHotFiles(args) {
  const project = args.project || resolveProject();
  const params = new URLSearchParams({ project });
  const briefing = await apiCall("GET", `/api/session/briefing?${params}`);
  // Extract just the hot files from the full briefing
  return {
    project,
    hotFiles: briefing.hotFiles || briefing.hot_files || [],
  };
}

async function handleTaskList(args) {
  const params = new URLSearchParams();
  if (args.status) params.set("status", args.status);
  if (args.limit) params.set("limit", String(args.limit));
  const qs = params.toString();
  return apiCall("GET", `/api/tasks${qs ? "?" + qs : ""}`);
}

async function handleTaskCreate(args) {
  const project = args.project || resolveProject();
  return apiCall("POST", "/api/tasks", {
    description: args.description,
    project,
    priority: args.priority || 5,
  });
}

async function handleSyncList(args) {
  const repo = args.project || "_global";
  return apiCall("GET", `/api/sync/list/${encodeURIComponent(repo)}`);
}

// ============ Server Setup ============
const server = new Server(
  { name: "itachi", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;
    switch (name) {
      case "memory_search":
        result = await handleMemorySearch(args);
        break;
      case "memory_recent":
        result = await handleMemoryRecent(args);
        break;
      case "memory_store":
        result = await handleMemoryStore(args);
        break;
      case "memory_stats":
        result = await handleMemoryStats(args);
        break;
      case "session_briefing":
        result = await handleSessionBriefing(args);
        break;
      case "project_hot_files":
        result = await handleProjectHotFiles(args);
        break;
      case "task_list":
        result = await handleTaskList(args);
        break;
      case "task_create":
        result = await handleTaskCreate(args);
        break;
      case "sync_list":
        result = await handleSyncList(args);
        break;
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// ============ Start ============
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Itachi MCP server running on stdio");
}

main().catch(console.error);
