/* ============================================================
   ITACHI SYSTEM DASHBOARD — JavaScript
   Real-time operational dashboard for the Itachi Memory System
   ============================================================ */

(function () {
  'use strict';

  // ── Configuration ─────────────────────────────────────────
  // Priority: URL params > localStorage > window.__ITACHI_ENV__ > hardcoded
  const HARDCODED_DEFAULTS = {
    apiUrl: '',
    apiKey: '',
    refreshInterval: 10,
    orchestratorUrl: 'http://localhost:3001',
  };

  // Merge Vercel env vars (set by build.sh) over hardcoded defaults
  const ENV = (typeof window.__ITACHI_ENV__ === 'object' && window.__ITACHI_ENV__) || {};
  const DEFAULTS = { ...HARDCODED_DEFAULTS, ...ENV };

  let config = { ...DEFAULTS };
  let refreshTimer = null;
  let chartInstances = {};
  let allTasks = [];
  let runningTaskTimers = new Map(); // taskId -> startedAt

  // Project color palette — deterministic from project name
  const PROJECT_COLORS = [
    '#e53935', '#42a5f5', '#66bb6a', '#ab47bc', '#ff7043',
    '#26c6da', '#ffca28', '#8d6e63', '#78909c', '#ec407a',
    '#7e57c2', '#29b6f6', '#9ccc65', '#ffa726', '#5c6bc0',
  ];

  function projectColor(name) {
    if (!name) return '#616161';
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length];
  }

  // Category icons
  const CATEGORY_ICONS = {
    code_change: '\u2699',      // gear
    test: '\u2714',             // checkmark
    documentation: '\uD83D\uDCC4', // doc
    fact: '\uD83E\uDDE0',      // brain
    conversation: '\uD83D\uDCAC', // chat
    lesson: '\uD83D\uDCA1',    // lightbulb
    reflection: '\uD83D\uDD0D', // magnifier
    error: '\u26A0',            // warning
  };

  function categoryIcon(cat) {
    if (!cat) return '\uD83D\uDCBE'; // floppy
    const lower = cat.toLowerCase();
    for (const [key, icon] of Object.entries(CATEGORY_ICONS)) {
      if (lower.includes(key)) return icon;
    }
    return '\uD83D\uDCBE';
  }

  // ── DOM refs ──────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    dotHealth: $('#dot-health'),
    valHealth: $('#val-health'),
    valMemories: $('#val-memories'),
    valActiveTasks: $('#val-active-tasks'),
    valTelegram: $('#val-telegram'),
    lastRefresh: $('#last-refresh'),
    autoRefresh: $('#auto-refresh-toggle'),
    refreshBtn: $('#refresh-btn'),
    settingsBtn: $('#settings-btn'),
    settingsModal: $('#settings-modal'),
    settingsClose: $('#settings-close'),
    settingsCancel: $('#settings-cancel'),
    settingsSave: $('#settings-save'),
    apiUrlInput: $('#api-url-input'),
    apiKeyInput: $('#api-key-input'),
    refreshInput: $('#refresh-input'),
    orchestratorUrlInput: $('#orchestrator-url-input'),
    machineCount: $('#machine-count'),
    machinesList: $('#machines-list'),
    taskFilterProject: $('#task-filter-project'),
    taskFilterStatus: $('#task-filter-status'),
    colQueued: $('#col-queued'),
    colRunning: $('#col-running'),
    colCompleted: $('#col-completed'),
    colFailed: $('#col-failed'),
    countQueued: $('#count-queued'),
    countRunning: $('#count-running'),
    countCompleted: $('#count-completed'),
    countFailed: $('#count-failed'),
    memoryFeedCount: $('#memory-feed-count'),
    memoryFeed: $('#memory-feed'),
    statTotal: $('#stat-total'),
    statOldest: $('#stat-oldest'),
    statNewest: $('#stat-newest'),
    repoCount: $('#repo-count'),
    reposList: $('#repos-list'),
    connectionBanner: $('#connection-banner'),
    bannerDismiss: $('#banner-dismiss'),
    taskModal: $('#task-modal'),
    taskModalClose: $('#task-modal-close'),
    taskModalBody: $('#task-modal-body'),
  };

  // ── Init ──────────────────────────────────────────────────
  function init() {
    loadConfig();
    bindEvents();
    applyUrlParams();
    startRefreshCycle();
    refreshAll();
    startElapsedTimers();
  }

  function loadConfig() {
    const saved = localStorage.getItem('itachi_dashboard_config');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        config = { ...DEFAULTS, ...parsed };
      } catch (e) { /* ignore */ }
    }
    // Also check legacy key storage
    const legacyKey = localStorage.getItem('itachi_api_key');
    if (legacyKey && !config.apiKey) {
      config.apiKey = legacyKey;
    }
  }

  function saveConfig() {
    localStorage.setItem('itachi_dashboard_config', JSON.stringify(config));
    // Also store api key under legacy key for compatibility
    localStorage.setItem('itachi_api_key', config.apiKey || '');
  }

  function applyUrlParams() {
    const params = new URLSearchParams(window.location.search);
    if (params.has('api')) {
      config.apiUrl = params.get('api');
    }
    if (params.has('refresh')) {
      config.refreshInterval = Math.max(3, parseInt(params.get('refresh'), 10) || 10);
    }
    if (params.has('key')) {
      config.apiKey = params.get('key');
    }
    saveConfig();
  }

  // ── Events ────────────────────────────────────────────────
  function bindEvents() {
    dom.settingsBtn.addEventListener('click', openSettings);
    dom.settingsClose.addEventListener('click', closeSettings);
    dom.settingsCancel.addEventListener('click', closeSettings);
    dom.settingsSave.addEventListener('click', saveSettings);
    dom.settingsModal.addEventListener('click', (e) => {
      if (e.target === dom.settingsModal) closeSettings();
    });

    dom.refreshBtn.addEventListener('click', () => refreshAll());
    dom.autoRefresh.addEventListener('change', () => {
      if (dom.autoRefresh.checked) startRefreshCycle();
      else stopRefreshCycle();
    });

    dom.taskFilterProject.addEventListener('change', renderTaskBoard);
    dom.taskFilterStatus.addEventListener('change', renderTaskBoard);

    dom.bannerDismiss.addEventListener('click', () => {
      dom.connectionBanner.classList.add('hidden');
    });

    dom.taskModalClose.addEventListener('click', () => {
      dom.taskModal.classList.add('hidden');
    });
    dom.taskModal.addEventListener('click', (e) => {
      if (e.target === dom.taskModal) dom.taskModal.classList.add('hidden');
    });

    // Escape key to close modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        dom.settingsModal.classList.add('hidden');
        dom.taskModal.classList.add('hidden');
      }
    });
  }

  function openSettings() {
    dom.apiUrlInput.value = config.apiUrl || '';
    dom.apiKeyInput.value = config.apiKey || '';
    dom.refreshInput.value = config.refreshInterval;
    dom.orchestratorUrlInput.value = config.orchestratorUrl || '';
    dom.settingsModal.classList.remove('hidden');
    dom.apiUrlInput.focus();
  }

  function closeSettings() {
    dom.settingsModal.classList.add('hidden');
  }

  function saveSettings() {
    config.apiUrl = dom.apiUrlInput.value.replace(/\/+$/, '');
    config.apiKey = dom.apiKeyInput.value.trim();
    config.refreshInterval = Math.max(3, parseInt(dom.refreshInput.value, 10) || 10);
    config.orchestratorUrl = dom.orchestratorUrlInput.value.replace(/\/+$/, '');
    saveConfig();
    closeSettings();
    stopRefreshCycle();
    if (dom.autoRefresh.checked) startRefreshCycle();
    refreshAll();
  }

  // ── Refresh cycle ─────────────────────────────────────────
  function startRefreshCycle() {
    stopRefreshCycle();
    refreshTimer = setInterval(() => refreshAll(), config.refreshInterval * 1000);
  }

  function stopRefreshCycle() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  // ── API helpers ───────────────────────────────────────────
  function apiUrl(path) {
    return (config.apiUrl || '') + path;
  }

  function fetchApi(path, options = {}) {
    const headers = { ...options.headers };
    if (config.apiKey) {
      headers['x-api-key'] = config.apiKey;
    }
    return fetch(apiUrl(path), {
      ...options,
      headers,
    }).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
  }

  let consecutiveFailures = 0;

  // ── Refresh all panels ────────────────────────────────────
  async function refreshAll() {
    const start = Date.now();
    const results = await Promise.allSettled([
      refreshHealth(),
      refreshTasks(),
      refreshMemoryFeed(),
      refreshMemoryStats(),
      refreshRepos(),
    ]);

    const anyFailed = results.some((r) => r.status === 'rejected');
    if (anyFailed) {
      consecutiveFailures++;
      if (consecutiveFailures >= 2) {
        dom.connectionBanner.classList.remove('hidden');
      }
    } else {
      consecutiveFailures = 0;
      dom.connectionBanner.classList.add('hidden');
    }

    dom.lastRefresh.textContent = new Date().toLocaleTimeString();
  }

  // ── Health ────────────────────────────────────────────────
  async function refreshHealth() {
    try {
      const data = await fetchApi('/health');
      dom.dotHealth.className = 'status-dot green';
      dom.valHealth.textContent = data.status || 'OK';
      dom.valMemories.textContent = formatNumber(data.memories);
      dom.valActiveTasks.textContent = formatNumber(data.active_tasks);
      dom.valTelegram.textContent = data.telegram ? 'Connected' : 'Offline';
    } catch (e) {
      dom.dotHealth.className = 'status-dot red';
      dom.valHealth.textContent = 'DOWN';
      throw e;
    }
  }

  // ── Tasks ─────────────────────────────────────────────────
  async function refreshTasks() {
    try {
      const data = await fetchApi('/api/tasks?limit=100');
      allTasks = data.tasks || [];
      populateProjectFilter();
      renderTaskBoard();
      renderMachines();
      renderTaskResultsChart();
    } catch (e) {
      allTasks = [];
      renderTaskBoard();
      throw e;
    }
  }

  function populateProjectFilter() {
    const projects = [...new Set(allTasks.map((t) => t.project).filter(Boolean))];
    const current = dom.taskFilterProject.value;
    dom.taskFilterProject.innerHTML = '<option value="">All Projects</option>';
    projects.sort().forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      if (p === current) opt.selected = true;
      dom.taskFilterProject.appendChild(opt);
    });
  }

  function renderTaskBoard() {
    const projectFilter = dom.taskFilterProject.value;
    const statusFilter = dom.taskFilterStatus.value;

    let filtered = allTasks;
    if (projectFilter) filtered = filtered.filter((t) => t.project === projectFilter);
    if (statusFilter) filtered = filtered.filter((t) => t.status === statusFilter);

    const queued = filtered.filter((t) => t.status === 'queued' || t.status === 'claimed');
    const running = filtered.filter((t) => t.status === 'running');
    const completed = filtered.filter((t) => t.status === 'completed');
    const failed = filtered.filter((t) => t.status === 'failed' || t.status === 'timeout' || t.status === 'cancelled');

    dom.countQueued.textContent = queued.length;
    dom.countRunning.textContent = running.length;
    dom.countCompleted.textContent = completed.length;
    dom.countFailed.textContent = failed.length;

    renderColumn(dom.colQueued, queued);
    renderColumn(dom.colRunning, running);
    renderColumn(dom.colCompleted, completed.slice(0, 20));
    renderColumn(dom.colFailed, failed.slice(0, 20));

    // Track running tasks for elapsed timers
    runningTaskTimers.clear();
    running.forEach((t) => {
      if (t.started_at) {
        runningTaskTimers.set(t.id, new Date(t.started_at).getTime());
      }
    });
  }

  function renderColumn(container, tasks) {
    if (tasks.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:16px;font-size:11px;">None</div>';
      return;
    }
    container.innerHTML = '';
    tasks.forEach((task) => {
      container.appendChild(createTaskCard(task));
    });
  }

  function createTaskCard(task) {
    const card = document.createElement('div');
    card.className = `task-card status-${task.status}`;
    card.dataset.taskId = task.id;

    const shortId = task.id ? task.id.slice(0, 8) : '---';
    const priorityClass = task.priority >= 8 ? 'priority-high' : task.priority >= 4 ? 'priority-medium' : 'priority-low';

    let extraHtml = '';
    if (task.status === 'running' && task.started_at) {
      extraHtml += `<span class="task-card-elapsed" data-started="${task.started_at}"></span>`;
    }
    if (task.status === 'completed' && task.pr_url) {
      extraHtml += `<a class="task-card-pr" href="${escapeHtml(task.pr_url)}" target="_blank" onclick="event.stopPropagation()">&#x1F517; PR</a>`;
    }
    if ((task.status === 'failed' || task.status === 'timeout') && task.error_message) {
      extraHtml += `<div class="task-card-error">${escapeHtml(task.error_message)}</div>`;
    }

    card.innerHTML = `
      <div class="task-card-id">
        <span>${shortId}</span>
        <span class="task-card-project" style="background:${projectColor(task.project)}22;color:${projectColor(task.project)}">${escapeHtml(task.project || 'unknown')}</span>
      </div>
      <div class="task-card-desc">${escapeHtml(task.description || 'No description')}</div>
      <div class="task-card-meta">
        ${task.model ? `<span class="task-card-model">${escapeHtml(task.model)}</span>` : ''}
        <span class="task-card-priority ${priorityClass}">P${task.priority ?? '?'}</span>
        ${extraHtml}
      </div>
    `;

    card.addEventListener('click', () => openTaskDetail(task.id));
    return card;
  }

  // ── Task detail modal ─────────────────────────────────────
  async function openTaskDetail(taskId) {
    dom.taskModalBody.innerHTML = '<div class="empty-state">Loading...</div>';
    dom.taskModal.classList.remove('hidden');

    try {
      const data = await fetchApi(`/api/tasks/${taskId}`);
      const task = data.task || data;
      renderTaskDetail(task);
    } catch (e) {
      // Fallback to local cache
      const cached = allTasks.find((t) => t.id === taskId);
      if (cached) {
        renderTaskDetail(cached);
      } else {
        dom.taskModalBody.innerHTML = `<div class="empty-state">Failed to load task: ${escapeHtml(e.message)}</div>`;
      }
    }
  }

  function renderTaskDetail(task) {
    const rows = [
      ['ID', `<code>${escapeHtml(task.id || '')}</code>`],
      ['Status', `<span class="status-badge ${task.status}">${task.status}</span>`],
      ['Project', escapeHtml(task.project || '--')],
      ['Description', escapeHtml(task.description || '--')],
      ['Priority', `P${task.priority ?? '?'}`],
      ['Model', escapeHtml(task.model || '--')],
      ['Orchestrator', `<code>${escapeHtml(task.orchestrator_id || '--')}</code>`],
      ['Created', formatDate(task.created_at)],
      ['Started', formatDate(task.started_at)],
      ['Completed', formatDate(task.completed_at)],
    ];

    if (task.files_changed) {
      const files = Array.isArray(task.files_changed) ? task.files_changed : [task.files_changed];
      rows.push(['Files Changed', `<pre>${escapeHtml(files.join('\n'))}</pre>`]);
    }
    if (task.pr_url) {
      rows.push(['PR', `<a href="${escapeHtml(task.pr_url)}" target="_blank">${escapeHtml(task.pr_url)}</a>`]);
    }
    if (task.result_summary) {
      rows.push(['Result', `<pre>${escapeHtml(task.result_summary)}</pre>`]);
    }
    if (task.error_message) {
      rows.push(['Error', `<pre style="color:var(--status-red)">${escapeHtml(task.error_message)}</pre>`]);
    }

    dom.taskModalBody.innerHTML = `
      <div class="task-detail">
        ${rows.map(([label, value]) => `
          <div class="task-detail-row">
            <div class="task-detail-label">${label}</div>
            <div class="task-detail-value">${value}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // ── Connected machines ────────────────────────────────────
  function renderMachines() {
    const machineMap = new Map();

    allTasks.forEach((task) => {
      const oid = task.orchestrator_id;
      if (!oid) return;
      if (!machineMap.has(oid)) {
        machineMap.set(oid, { id: oid, activeTasks: 0, totalTasks: 0, lastActivity: null, taskIds: [] });
      }
      const m = machineMap.get(oid);
      m.totalTasks++;
      if (task.status === 'running' || task.status === 'claimed') {
        m.activeTasks++;
        m.taskIds.push(task.id?.slice(0, 8));
      }
      const ts = task.completed_at || task.started_at || task.created_at;
      if (ts) {
        const d = new Date(ts).getTime();
        if (!m.lastActivity || d > m.lastActivity) m.lastActivity = d;
      }
    });

    const machines = [...machineMap.values()].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    dom.machineCount.textContent = machines.length;

    if (machines.length === 0) {
      dom.machinesList.innerHTML = '<div class="empty-state">No orchestrators detected</div>';
      return;
    }

    dom.machinesList.innerHTML = '';
    machines.forEach((m) => {
      const now = Date.now();
      const idle = m.lastActivity ? (now - m.lastActivity) : Infinity;
      let statusClass, statusLabel;
      if (m.activeTasks > 0) {
        statusClass = 'green';
        statusLabel = 'Active';
      } else if (idle < 10 * 60 * 1000) {
        statusClass = 'amber';
        statusLabel = 'Idle';
      } else {
        statusClass = 'red';
        statusLabel = 'Offline';
      }

      const card = document.createElement('div');
      card.className = 'machine-card';
      card.innerHTML = `
        <div class="machine-card-header">
          <span class="status-dot ${statusClass}"></span>
          <span class="machine-id">${escapeHtml(m.id)}</span>
        </div>
        <div class="machine-stat">
          <span>Status</span>
          <span class="machine-stat-value">${statusLabel}</span>
        </div>
        <div class="machine-stat">
          <span>Active Tasks</span>
          <span class="machine-stat-value">${m.activeTasks}</span>
        </div>
        <div class="machine-stat">
          <span>Total Tasks</span>
          <span class="machine-stat-value">${m.totalTasks}</span>
        </div>
        <div class="machine-stat">
          <span>Last Activity</span>
          <span class="machine-stat-value">${m.lastActivity ? timeAgo(m.lastActivity) : '--'}</span>
        </div>
      `;
      dom.machinesList.appendChild(card);
    });
  }

  // ── Memory feed ───────────────────────────────────────────
  async function refreshMemoryFeed() {
    try {
      const data = await fetchApi('/api/memory/recent?limit=30');
      const memories = data.recent || [];
      dom.memoryFeedCount.textContent = memories.length;

      if (memories.length === 0) {
        dom.memoryFeed.innerHTML = '<div class="empty-state">No recent memories</div>';
        return;
      }

      dom.memoryFeed.innerHTML = '';
      memories.forEach((mem) => {
        const item = document.createElement('div');
        item.className = 'memory-item';

        const icon = categoryIcon(mem.category);
        const color = projectColor(mem.project);
        const filesCount = Array.isArray(mem.files) ? mem.files.length : 0;

        item.innerHTML = `
          <div class="memory-icon">${icon}</div>
          <div class="memory-content">
            <div class="memory-header">
              <span class="memory-time">${formatDate(mem.created_at)}</span>
              <span class="memory-project-badge" style="background:${color}22;color:${color}">${escapeHtml(mem.project || 'unknown')}</span>
              <span class="memory-category">${escapeHtml(mem.category || '')}</span>
            </div>
            <div class="memory-summary">${escapeHtml(mem.summary || 'No summary')}</div>
            ${filesCount > 0 ? `<div class="memory-files">${filesCount} file${filesCount !== 1 ? 's' : ''}</div>` : ''}
          </div>
        `;
        dom.memoryFeed.appendChild(item);
      });
    } catch (e) {
      throw e;
    }
  }

  // ── Memory stats ──────────────────────────────────────────
  async function refreshMemoryStats() {
    try {
      const data = await fetchApi('/api/memory/stats');
      dom.statTotal.textContent = formatNumber(data.total);
      dom.statOldest.textContent = data.dateRange?.oldest ? formatDateShort(data.dateRange.oldest) : '--';
      dom.statNewest.textContent = data.dateRange?.newest ? formatDateShort(data.dateRange.newest) : '--';

      renderCategoryChart(data.byCategory || {});
      renderTopFilesChart(data.topFiles || []);
    } catch (e) {
      throw e;
    }
  }

  // ── Charts ────────────────────────────────────────────────
  function renderCategoryChart(byCategory) {
    const labels = Object.keys(byCategory);
    const values = Object.values(byCategory);

    if (chartInstances.categories) chartInstances.categories.destroy();

    const ctx = document.getElementById('chart-categories');
    if (!ctx) return;

    chartInstances.categories = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: labels.map((_, i) => PROJECT_COLORS[i % PROJECT_COLORS.length]),
          borderColor: '#1a1a1a',
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: { color: '#999', font: { size: 10 }, padding: 6, boxWidth: 12 },
          },
        },
      },
    });
  }

  function renderTaskResultsChart() {
    const counts = { completed: 0, failed: 0, timeout: 0, cancelled: 0, running: 0, queued: 0 };
    allTasks.forEach((t) => {
      if (counts.hasOwnProperty(t.status)) counts[t.status]++;
      else if (t.status === 'claimed') counts.queued++;
    });

    const labels = Object.keys(counts);
    const values = Object.values(counts);
    const colors = {
      completed: '#4caf50',
      failed: '#ef5350',
      timeout: '#ff7043',
      cancelled: '#616161',
      running: '#ff9800',
      queued: '#42a5f5',
    };

    if (chartInstances.taskResults) chartInstances.taskResults.destroy();

    const ctx = document.getElementById('chart-task-results');
    if (!ctx) return;

    chartInstances.taskResults = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: labels.map((l) => colors[l] || '#666'),
          borderColor: '#1a1a1a',
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: { color: '#999', font: { size: 10 }, padding: 6, boxWidth: 12 },
          },
        },
      },
    });
  }

  function renderTopFilesChart(topFiles) {
    const files = topFiles.slice(0, 10);
    const labels = files.map((f) => {
      const p = f.file || '';
      return p.length > 40 ? '...' + p.slice(-37) : p;
    });
    const values = files.map((f) => f.count);

    if (chartInstances.topFiles) chartInstances.topFiles.destroy();

    const ctx = document.getElementById('chart-top-files');
    if (!ctx) return;

    chartInstances.topFiles = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Edits',
          data: values,
          backgroundColor: '#e5393588',
          borderColor: '#e53935',
          borderWidth: 1,
          borderRadius: 3,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            grid: { color: '#222' },
            ticks: { color: '#999', font: { size: 10 } },
          },
          y: {
            grid: { display: false },
            ticks: {
              color: '#999',
              font: { size: 10, family: "'Cascadia Code', 'Consolas', monospace" },
            },
          },
        },
        plugins: {
          legend: { display: false },
        },
      },
    });
  }

  // ── Repos ─────────────────────────────────────────────────
  async function refreshRepos() {
    try {
      const data = await fetchApi('/api/repos');
      const repos = data.repos || [];
      dom.repoCount.textContent = repos.length;

      if (repos.length === 0) {
        dom.reposList.innerHTML = '<div class="empty-state">No repos configured</div>';
        return;
      }

      // Fetch sync counts in parallel
      const syncPromises = repos.map((r) =>
        fetchApi(`/api/sync/list/${encodeURIComponent(r.name)}`)
          .then((d) => ({ name: r.name, count: d.files?.length || 0 }))
          .catch(() => ({ name: r.name, count: '?' }))
      );
      const syncResults = await Promise.allSettled(syncPromises);
      const syncMap = new Map();
      syncResults.forEach((r) => {
        if (r.status === 'fulfilled') syncMap.set(r.value.name, r.value.count);
      });

      dom.reposList.innerHTML = '';
      const grid = document.createElement('div');
      grid.className = 'repos-grid';

      repos.forEach((repo) => {
        const card = document.createElement('div');
        card.className = 'repo-card';
        const syncCount = syncMap.get(repo.name) ?? '?';
        card.innerHTML = `
          <div>
            <div class="repo-name">${escapeHtml(repo.name)}</div>
            ${repo.repo_url ? `<a class="repo-url" href="${escapeHtml(repo.repo_url)}" target="_blank">${escapeHtml(repo.repo_url)}</a>` : ''}
          </div>
          <div class="repo-sync-count" title="Sync files">${syncCount} synced</div>
        `;
        grid.appendChild(card);
      });

      dom.reposList.appendChild(grid);
    } catch (e) {
      throw e;
    }
  }

  // ── Elapsed time ticker ───────────────────────────────────
  function startElapsedTimers() {
    function tick() {
      const now = Date.now();
      document.querySelectorAll('.task-card-elapsed[data-started]').forEach((el) => {
        const started = new Date(el.dataset.started).getTime();
        const elapsed = now - started;
        el.textContent = formatElapsed(elapsed);
      });
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // ── Utilities ─────────────────────────────────────────────
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatNumber(n) {
    if (n == null) return '--';
    return Number(n).toLocaleString();
  }

  function formatDate(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '--';
    return d.toLocaleString();
  }

  function formatDateShort(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '--';
    return d.toLocaleDateString();
  }

  function formatElapsed(ms) {
    if (ms < 0) return '0s';
    const secs = Math.floor(ms / 1000);
    const mins = Math.floor(secs / 60);
    const hrs = Math.floor(mins / 60);
    if (hrs > 0) return `${hrs}h ${mins % 60}m ${secs % 60}s`;
    if (mins > 0) return `${mins}m ${secs % 60}s`;
    return `${secs}s`;
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  // ── Boot ──────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
