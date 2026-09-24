// AGmail Client Application
(function () {
  const state = {
    activeAccount: "all",
    activePersona: "user",
    activeFolder: "inbox",
    activeCategory: "all",
    viewMode: "threads", // "threads" (Conversation view) or "flat" (Individual transmissions)
    searchQuery: "",
    selectedThreadId: null,
    selectedMessageId: null,
    starredIds: new Set(JSON.parse(localStorage.getItem("agmail_starred") || "[]")),
     items: [], // threads or messages depending on viewMode
     hangoutThreads: [],
     page: 1,
    pageSize: 50,
    total: 0,
    totalPages: 1,
    agents: [],
    worktrees: [],
    briefs: [],
    status: {},
    contextTarget: null,
    currentView: "mail", // "mail" or "board"
    readingLayout: document.documentElement.dataset.readingLayout === "full" ? "full" : "split",
    themePreference: ["system", "light", "dark"].includes(document.documentElement.dataset.themePreference) ? document.documentElement.dataset.themePreference : "system",
    detailOpen: false,
    board: null,
    boardFilterAgent: "all",
    boardSearchQuery: "",
    selectedTaskId: null,
    activeAgentHandle: null,
  };

  function getActiveSender(selected = "") {
    if (state.activeAccount === "all") return "user";
    return selected || state.activeAccount || state.activePersona || "user";
  }

  // DOM Elements
  const mailListEl = document.getElementById("mail-list");
  const mailListViewEl = document.getElementById("mail-list-view");
  const mailDetailViewEl = document.getElementById("mail-detail-view");
  const contentSplitterEl = document.getElementById("splitter-view");
  const searchInputEl = document.getElementById("search-input");
  const clearSearchBtn = document.getElementById("clear-search");
  const headerSearchContainer = document.getElementById("header-search-container");
  const searchBarEl = document.getElementById("search-bar");
  const searchAutocompleteDropdownEl = document.getElementById("search-autocomplete-dropdown");
  const searchSuggestionsListEl = document.getElementById("search-suggestions-list");
  const bridgeStatusPill = document.getElementById("bridge-status-pill");
  const bridgeStatusText = document.getElementById("bridge-status-text");
  const refreshBtn = document.getElementById("refresh-btn");
  const presenceListEl = document.getElementById("presence-list");
  const inboxUnreadCountEl = document.getElementById("inbox-unread-count");
  const pageInfoEl = document.getElementById("page-info");
  const prevPageBtn = document.getElementById("prev-page-btn");
  const nextPageBtn = document.getElementById("next-page-btn");
  const filterInfoEl = document.getElementById("filter-info");
  const backToListBtn = document.getElementById("back-to-list-btn");
  const storageUsedEl = document.getElementById("storage-used-text");
  const storageFillEl = document.getElementById("storage-bar-fill");
  const toggleSidebarBtn = document.getElementById("toggle-sidebar");
  const sidebarBackdrop = document.getElementById("sidebar-backdrop");
  const sidebarEl = document.getElementById("sidebar");

  const openSettingsBtn = document.getElementById("open-settings-btn");
  const settingsBackdrop = document.getElementById("settings-backdrop");
  const settingsForm = document.getElementById("settings-form");
  const closeSettingsBtn = document.getElementById("close-settings-btn");
  const cancelSettingsBtn = document.getElementById("cancel-settings-btn");
  const readingLayoutInputs = [...document.querySelectorAll('input[name="reading-layout"]')];
  const themeInputs = [...document.querySelectorAll('input[name="theme"]')];

  // Account Menu Elements
  const userProfileBtn = document.getElementById("user-profile-btn");
  const accountDropdown = document.getElementById("account-dropdown");
  const accountDropdownList = document.getElementById("account-dropdown-list");
  const headerAccountLabel = document.getElementById("header-account-label");
  const currentUserAvatar = document.getElementById("current-user-avatar");
  const dropdownLargeAvatar = document.getElementById("dropdown-large-avatar");
  const dropdownUserTitle = document.getElementById("dropdown-user-title");
  const dropdownUserRole = document.getElementById("dropdown-user-role");
  const dropdownUserEmail = document.getElementById("dropdown-user-email");

  const agentActivityDialog = document.getElementById("agent-activity-dialog");
  const closeAgentActivityBtn = document.getElementById("close-agent-activity-btn");
  const agentActivityAvatar = document.getElementById("agent-activity-avatar");
  const agentActivityName = document.getElementById("agent-activity-name");
  const agentActivityHandle = document.getElementById("agent-activity-handle");
  const agentActivityRole = document.getElementById("agent-activity-role");
  const agentActivityStatus = document.getElementById("agent-activity-status");
  const agentActivityHeadline = document.getElementById("agent-activity-headline");
  const agentActivityTask = document.getElementById("agent-activity-task");
  const agentActivityTaskStatus = document.getElementById("agent-activity-task-status");
  const agentActivityModel = document.getElementById("agent-activity-model");
  const agentActivityUnread = document.getElementById("agent-activity-unread");
  const agentActivityPane = document.getElementById("agent-activity-pane");
  const agentActivityObserved = document.getElementById("agent-activity-observed");
  const agentPaneOutput = document.getElementById("agent-activity-pane-output");
  const refreshAgentPaneBtn = document.getElementById("refresh-agent-pane-btn");
  const viewAgentInboxBtn = document.getElementById("view-agent-inbox-btn");
  const viewAgentTaskBtn = document.getElementById("view-agent-task-btn");

  // Context Menu Elements
  const chatContextMenu = document.getElementById("chat-context-menu");
  const ctxHeader = document.getElementById("ctx-header");
  const ctxHeaderTitle = document.getElementById("ctx-header-title");
  const ctxHeaderSub = document.getElementById("ctx-header-sub");
  const ctxReply = document.getElementById("ctx-reply");
  const ctxReplyText = document.getElementById("ctx-reply-text");
  const ctxQuote = document.getElementById("ctx-quote");
  const ctxQuoteText = document.getElementById("ctx-quote-text");
  const ctxFilterSender = document.getElementById("ctx-filter-sender");
  const ctxFilterSenderText = document.getElementById("ctx-filter-sender-text");
  const ctxCopyId = document.getElementById("ctx-copy-id");
  const ctxCopyIdText = document.getElementById("ctx-copy-id-text");
  const ctxRegisterAgent = document.getElementById("ctx-register-agent");
  const ctxRegisterText = document.getElementById("ctx-register-text");

  // Register Agent Modal Elements
  const registerAgentBackdrop = document.getElementById("register-agent-backdrop");
  const agentModalTitle = document.getElementById("agent-modal-title");
  const openRegisterAgentBtn = document.getElementById("open-register-agent-btn");
  const closeRegisterAgentBtn = document.getElementById("close-register-agent-btn");
  const cancelRegisterAgentBtn = document.getElementById("cancel-register-agent-btn");
  const registerAgentForm = document.getElementById("register-agent-form");
  const briefChipsList = document.getElementById("brief-chips-list");
  const pullDiskBriefBtn = document.getElementById("pull-disk-brief-btn");
  const newAgentHandleInput = document.getElementById("new-agent-handle");
  const newAgentNameInput = document.getElementById("new-agent-name");
  const newAgentRoleInput = document.getElementById("new-agent-role");
  const newAgentModelInput = document.getElementById("new-agent-model");
  const modelSuggestionsDatalist = document.getElementById("model-suggestions");
  const newAgentPromptInput = document.getElementById("new-agent-prompt");
  const briefSourceBadge = document.getElementById("brief-source-badge");

  // View Mode Elements
  const viewModeThreadsBtn = document.getElementById("view-mode-threads");
  const viewModeFlatBtn = document.getElementById("view-mode-flat");

  // Detail View Elements
  const detailSubjectEl = document.getElementById("detail-subject");
  const detailThreadBadgeEl = document.getElementById("detail-thread-badge");
  const threadMessagesListEl = document.getElementById("thread-messages-list");
  const expandCollapseBtn = document.getElementById("expand-collapse-btn");
  const replyAsUserEl = document.getElementById("reply-as-user");
  const quickReplyTextEl = document.getElementById("quick-reply-text");
  const sendQuickReplyBtn = document.getElementById("send-quick-reply-btn");
  const smartRepliesChipsEl = document.getElementById("smart-replies-chips");

  // Compose Elements
  const composeModalEl = document.getElementById("compose-modal");
  const openComposeBtn = document.getElementById("open-compose-btn");
  const closeComposeBtn = document.getElementById("close-compose-btn");
  const composeFormEl = document.getElementById("compose-form");
  const composeTemplateEl = document.getElementById("compose-template");
  const composeFromEl = document.getElementById("compose-from");
  const composeToEl = document.getElementById("compose-to");
  const composeSubjectEl = document.getElementById("compose-subject");
  const composeThreadEl = document.getElementById("compose-thread");
  const composeBodyEl = document.getElementById("compose-body");

  // Lightbox Elements
  const lightboxModal = document.getElementById("lightbox-modal");
  const lightboxImg = document.getElementById("lightbox-img");
  const lightboxTitle = document.getElementById("lightbox-title");
  const lightboxDownloadLink = document.getElementById("lightbox-download-link");
  const lightboxCloseBtn = document.getElementById("lightbox-close-btn");
  const lightboxBackdrop = document.getElementById("lightbox-backdrop");

  // Kanban Board Elements
  const navViewMail = document.getElementById("nav-view-mail");
  const navViewBoard = document.getElementById("nav-view-board");
  const mailViewSection = document.getElementById("mail-view-section");
  const boardViewSection = document.getElementById("board-view-section");
  const navViewPanes = document.getElementById("nav-view-panes");
  const navViewMetrics = document.getElementById("nav-view-metrics");
  const panesViewSection = document.getElementById("panes-view-section");
  const metricsViewSection = document.getElementById("metrics-view-section");
  const panesGridEl = document.getElementById("panes-grid");
  const panesUpdatedAtEl = document.getElementById("panes-updated-at");
  const refreshPanesBtn = document.getElementById("refresh-panes-btn");
  const panesLinesSelect = document.getElementById("panes-lines-select");
  const panesFocusBanner = document.getElementById("panes-focus-banner");
  const panesFocusName = document.getElementById("panes-focus-name");
  const clearPanesFocusBtn = document.getElementById("clear-panes-focus-btn");
  const coordinatorMetricsGrid = document.getElementById("coordinator-metrics-grid");
  const coordinatorAlerts = document.getElementById("coordinator-alerts");
  const coordinatorMetricsUpdated = document.getElementById("coordinator-metrics-updated");
  const boardTotalCountEl = document.getElementById("board-total-count");
  const boardSearchInput = document.getElementById("board-search-input");
  const refreshBoardBtn = document.getElementById("refresh-board-btn");
  const openNewTaskBtn = document.getElementById("open-new-task-btn");
  const boardAgentFilterBar = document.getElementById("board-agent-filter-bar");
  const statTotalEl = document.getElementById("stat-total");
  const statProgressEl = document.getElementById("stat-progress");
  const statBlockedEl = document.getElementById("stat-blocked");
  const statDoneEl = document.getElementById("stat-done");
  const cardsBacklogEl = document.getElementById("cards-backlog");
  const cardsInProgressEl = document.getElementById("cards-in_progress");
  const cardsBlockedEl = document.getElementById("cards-blocked");
  const cardsDoneEl = document.getElementById("cards-done");
  const colCountBacklog = document.getElementById("col-count-backlog");
  const colCountInProgress = document.getElementById("col-count-in_progress");
  const colCountBlocked = document.getElementById("col-count-blocked");
  const colCountDone = document.getElementById("col-count-done");

  // Task Modal Elements
  const taskModalBackdrop = document.getElementById("task-modal-backdrop");
  const closeTaskModalBtn = document.getElementById("close-task-modal-btn");
  const cancelTaskBtn = document.getElementById("cancel-task-btn");
  const newTaskForm = document.getElementById("new-task-form");
  const taskTitleInput = document.getElementById("task-title-input");
  const taskOwnerSelect = document.getElementById("task-owner-select");
  const taskOwnerTip = document.getElementById("task-owner-tip");
  const taskStatusSelect = document.getElementById("task-status-select");
  const taskDescInput = document.getElementById("task-desc-input");

  // Task Sheet (Ficha do Card) Elements
  const taskSheetBackdrop = document.getElementById("task-sheet-backdrop");
  const taskSheetDrawer = document.getElementById("task-sheet-drawer");
  const closeTaskSheetBtn = document.getElementById("close-task-sheet-btn");
  const sheetBackBtn = document.getElementById("sheet-back-btn");
  const sheetTaskId = document.getElementById("sheet-task-id");
  const sheetTaskSource = document.getElementById("sheet-task-source");
  const sheetCopyIdBtn = document.getElementById("sheet-copy-id-btn");
  const sheetTaskTitle = document.getElementById("sheet-task-title");
  const sheetStageButtons = document.getElementById("sheet-stage-buttons");
  const sheetOwnerAvatar = document.getElementById("sheet-owner-avatar");
  const sheetOwnerSelect = document.getElementById("sheet-owner-select");
  const sheetThreadId = document.getElementById("sheet-thread-id");
  const sheetTaskDesc = document.getElementById("sheet-task-desc");
  const sheetDescBackBtn = document.getElementById("sheet-desc-back-btn");
  const sheetDescExpandBtn = document.getElementById("sheet-desc-expand-btn");
  const sheetDescExpandIcon = document.getElementById("sheet-desc-expand-icon");
  const sheetDescExpandText = document.getElementById("sheet-desc-expand-text");
  const sheetWideBtn = document.getElementById("sheet-wide-btn");
  const sheetWideIcon = document.getElementById("sheet-wide-icon");
  const sheetWideText = document.getElementById("sheet-wide-text");
  const sheetTabsBar = document.getElementById("sheet-tabs-bar");
  const sheetTabBadge = document.getElementById("sheet-tab-badge");
  const sheetThreadBadge = document.getElementById("sheet-thread-badge");
  const sheetRefreshThreadBtn = document.getElementById("sheet-refresh-thread-btn");
  const sheetThreadList = document.getElementById("sheet-thread-list");
  const sheetDispatchFrom = document.getElementById("sheet-dispatch-from");
  const sheetDispatchTo = document.getElementById("sheet-dispatch-to");
  const sheetDispatchChips = document.getElementById("sheet-dispatch-chips");
  const sheetDispatchBody = document.getElementById("sheet-dispatch-body");
  const sheetDispatchThreadPreview = document.getElementById("sheet-dispatch-thread-preview");
  const sheetDispatchSendBtn = document.getElementById("sheet-dispatch-send-btn");

  const systemThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  let settingsReturnFocus = null;

  function persistPreference(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  }

  function resolveTheme(preference) {
    return preference === "dark" || (preference === "system" && systemThemeMedia.matches) ? "dark" : "light";
  }

  function applyThemePreference(preference, persist = true) {
    const normalized = ["system", "light", "dark"].includes(preference) ? preference : "system";
    state.themePreference = normalized;
    document.documentElement.dataset.themePreference = normalized;
    document.documentElement.dataset.theme = resolveTheme(normalized);
    if (persist) persistPreference("agmail_theme", normalized);
  }

  function applyReadingLayout(layout, persist = true) {
    const normalized = layout === "full" ? "full" : "split";
    state.readingLayout = normalized;
    document.documentElement.dataset.readingLayout = normalized;
    contentSplitterEl.dataset.readingLayout = normalized;
    if (persist) persistPreference("agmail_reading_layout", normalized);
  }

  function syncSettingsForm() {
    readingLayoutInputs.forEach((input) => {
      input.checked = input.value === state.readingLayout;
    });
    themeInputs.forEach((input) => {
      input.checked = input.value === state.themePreference;
    });
  }

  function openSettings() {
    settingsReturnFocus = document.activeElement;
    syncSettingsForm();
    settingsBackdrop.classList.remove("hidden");
    requestAnimationFrame(() => closeSettingsBtn.focus());
  }

  function closeSettings() {
    if (settingsBackdrop.classList.contains("hidden")) return;
    settingsBackdrop.classList.add("hidden");
    if (settingsReturnFocus && settingsReturnFocus.isConnected) settingsReturnFocus.focus();
    settingsReturnFocus = null;
  }

  openSettingsBtn.addEventListener("click", openSettings);
  closeSettingsBtn.addEventListener("click", closeSettings);
  cancelSettingsBtn.addEventListener("click", closeSettings);
  settingsBackdrop.addEventListener("click", (event) => {
    if (event.target === settingsBackdrop) closeSettings();
  });
  settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const readingLayout = readingLayoutInputs.find((input) => input.checked)?.value || "split";
    const theme = themeInputs.find((input) => input.checked)?.value || "system";
    applyReadingLayout(readingLayout);
    applyThemePreference(theme);
    closeSettings();
  });
  settingsBackdrop.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSettings();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...settingsBackdrop.querySelectorAll('button:not([disabled]), input:not([disabled])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  systemThemeMedia.addEventListener("change", () => {
    if (state.themePreference === "system") applyThemePreference("system", false);
  });


  // ─── Data Fetching ──────────────────────────────────────────────────────────

  async function fetchStatus() {
    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      state.status = data;

      if (data.daemonRunning) {
        bridgeStatusPill.className = "status-pill status-running";
        bridgeStatusText.textContent = `Bridge: Running (${data.pid})`;
      } else {
        bridgeStatusPill.className = "status-pill status-stopped";
        bridgeStatusText.textContent = "Bridge: Stopped (click to start)";
      }

      inboxUnreadCountEl.textContent = data.totalUnread || 0;

      if (data.storage && storageUsedEl && storageFillEl) {
        storageUsedEl.textContent = data.storage.display;
        const pct = Math.min(100, Math.round((data.storage.mb / 100) * 100));
        storageFillEl.style.width = `${Math.max(3, pct)}%`;
      }
    } catch {
      bridgeStatusText.textContent = "Bridge: Offline";
    }
  }

  async function fetchAgents() {
    try {
      const res = await fetch("/api/agents");
      const list = await res.json();
      state.agents = list;
       renderAccountDropdown(list);
       renderPresenceList(list);
       if (state.currentView === "panes") renderPaneCards();
       populateComposeDropdowns(list);
    } catch {}
  }

  async function fetchWorktrees() {
    try {
      const res = await fetch("/api/worktrees");
      const list = await res.json();
       state.worktrees = Array.isArray(list) ? list : [];
       renderPresenceList(state.agents);
       if (state.currentView === "panes") renderPaneCards();
    } catch {}
  }

  async function fetchModels() {
    try {
      const res = await fetch("/api/models");
      const list = await res.json();
      if (Array.isArray(list) && modelSuggestionsDatalist) {
        modelSuggestionsDatalist.innerHTML = list
          .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name || m.id)}</option>`)
          .join("");
      }
    } catch {}
  }

  async function fetchData() {
    try {
      const endpoint = state.viewMode === "threads" ? "/api/threads" : "/api/messages";
      const currentPersona = getActiveSender();
      const params = new URLSearchParams({
        account: state.activeAccount,
        persona: currentPersona,
        // Starred is a local, read-only view over both inbox and sent mail.
        // Fetch all folders, then filter against the local star set in renderList().
        folder: state.searchQuery || state.activeFolder === "starred" ? "all" : state.activeFolder,
        query: state.searchQuery,
        page: String(state.page),
        pageSize: String(state.pageSize),
        paginate: "true",
      });

      const res = await fetch(`${endpoint}?${params}`);
      const data = await res.json();
      if (data && typeof data === "object" && "items" in data) {
        state.items = data.items || [];
        state.total = data.total || 0;
        state.page = data.page || 1;
        state.totalPages = data.totalPages || 1;
      } else {
        state.items = Array.isArray(data) ? data : [];
        state.total = state.items.length;
        state.page = 1;
        state.totalPages = 1;
      }
      renderList();
    } catch (e) {
      mailListEl.innerHTML = `<div class="empty-state">Error loading transmissions: ${e.message}</div>`;
    }
  }

  // ─── Google Account Dropdown ────────────────────────────────────────────────

  function renderAccountDropdown(agents) {
    const allActive = state.activeAccount === "all";
    let html = `
      <button class="account-item-btn ${allActive ? "active" : ""}" data-handle="all" aria-current="${allActive ? "true" : "false"}">
        <span class="account-item-left">
          <span class="item-avatar" style="background:var(--primary-blue);color:#fff;">👑</span>
          <span class="account-item-copy">
            <strong class="account-item-name">God Mode</strong>
            <span class="account-item-role">All accounts · sending as user</span>
            <span class="account-item-address">amq://all-agents</span>
          </span>
        </span>
      </button>
    `;

    for (const agent of sortAgentsForPresence(agents)) {
      const active = state.activeAccount === agent.handle;
      const profile = agent.profile || {};
      const name = profile.name || agent.handle;
      const role = profile.role || "Swarm Agent";
      const emoji = profile.emoji || agent.handle.slice(0, 1).toUpperCase();
      const color = safeCssColor(profile.color, "#1a73e8");
      const unreadBadge = agent.unreadCount > 0 ? `<span class="badge">${agent.unreadCount} new</span>` : "";

      html += `
        <button class="account-item-btn ${active ? "active" : ""}" data-handle="${escapeHtml(agent.handle)}" aria-current="${active ? "true" : "false"}" aria-label="Switch to ${escapeHtml(name)}">
          <span class="account-item-left">
            <span class="item-avatar" style="background:${escapeHtml(color)};color:#fff;">${escapeHtml(emoji)}</span>
            <span class="account-item-copy">
              <strong class="account-item-name">${escapeHtml(name)}</strong>
              <span class="account-item-role">${escapeHtml(role)}</span>
              <span class="account-item-address">${escapeHtml(agent.handle)}@amq</span>
            </span>
          </span>
          ${unreadBadge}
        </button>
      `;
    }

    accountDropdownList.innerHTML = html;

    accountDropdownList.querySelectorAll(".account-item-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        switchActiveAccount(btn.dataset.handle);
        accountDropdown.classList.add("hidden");
        userProfileBtn.setAttribute("aria-expanded", "false");
      });
    });
  }

  function switchActiveAccount(handle) {
    state.activeAccount = handle;
    state.activePersona = handle === "all" ? "user" : handle;
    localStorage.setItem("agmail_persona", state.activePersona);

    const currentPersona = getActiveSender();

    if (handle === "all") {
      headerAccountLabel.textContent = "👑 God Mode";
      currentUserAvatar.textContent = "👑";
      currentUserAvatar.style.backgroundColor = "var(--primary-blue)";
      dropdownLargeAvatar.textContent = "👑";
      dropdownLargeAvatar.style.backgroundColor = "var(--primary-blue)";
      dropdownUserTitle.textContent = "God Mode";
      dropdownUserRole.textContent = "All transmissions · sending as user";
      dropdownUserEmail.textContent = "amq://all-agents";
    } else {
      const agentObj = state.agents.find((x) => x.handle === handle);
      const prof = agentObj?.profile || { name: handle, emoji: handle.slice(0, 1).toUpperCase(), color: "#1a73e8", role: "Persona" };
      headerAccountLabel.textContent = prof.name;
      currentUserAvatar.textContent = prof.emoji;
      currentUserAvatar.style.backgroundColor = prof.color;
      dropdownLargeAvatar.textContent = prof.emoji;
      dropdownLargeAvatar.style.backgroundColor = prof.color;
      dropdownUserTitle.textContent = prof.name;
      dropdownUserRole.textContent = prof.role || "Swarm Agent";
      dropdownUserEmail.textContent = `${handle}@amq`;
    }

    replyAsUserEl.textContent = currentPersona;
    renderAccountDropdown(state.agents);
    renderPresenceList(state.agents);
    fetchData();
  }

  // Toggle account dropdown on user profile click
  userProfileBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = accountDropdown.classList.contains("hidden");
    accountDropdown.classList.toggle("hidden");
    userProfileBtn.setAttribute("aria-expanded", String(opening));
  });

  // Close dropdown on outside click
  document.addEventListener("click", (e) => {
    if (!accountDropdown.contains(e.target) && !userProfileBtn.contains(e.target)) {
      accountDropdown.classList.add("hidden");
      userProfileBtn.setAttribute("aria-expanded", "false");
    }
  });

  // ─── Swarm Presence List ────────────────────────────────────────────────────

  function safeCssColor(value, fallback = "#1a73e8") {
    const color = String(value || "").trim();
    return /^#[0-9a-f]{3,8}$/i.test(color) ? color : fallback;
  }

  function agentStatusView(agent) {
    const raw = String(agent?.herdrStatus && agent.herdrStatus !== "unknown" ? agent.herdrStatus : agent?.status || "offline").toLowerCase();
    const status = raw === "online" || raw === "active" ? "idle" : raw;
    // Stale snapshot detection: the server re-polls Herdr on a safety timer,
    // but if the observed-at timestamp lags, the pill may show a dead state.
    // Flag it via data-stale (CSS only — label text stays stable for tests).
    const live = ["working", "idle", "done", "blocked"].includes(status);
    const observedMs = agent?.herdrObservedAt ? Date.parse(agent.herdrObservedAt) : NaN;
    const stale = live && Number.isFinite(observedMs) && Date.now() - observedMs > 120000;
    const views = {
      working: { label: "Working", description: "Active turn", tone: "working" },
      idle: { label: "Idle", description: "Turn ended · ready for input", tone: "idle" },
      done: { label: "Done", description: "Turn completed · ready for input", tone: "done" },
      blocked: { label: "Blocked", description: "Waiting for intervention", tone: "blocked" },
      error: { label: "Needs attention", description: "State error", tone: "blocked" },
      offline: { label: "Offline", description: "No live Herdr state", tone: "offline" },
    };
    return { status, stale, ...(views[status] || views.offline) };
  }

  function getAgentTask(handle) {
    if (!handle || !state.board?.columns) return null;
    const rank = { in_progress: 0, blocked: 1, backlog: 2, done: 3 };
    return Object.values(state.board.columns)
      .flat()
      .filter((task) => task.owner === handle)
      .sort((left, right) => {
        const rankDelta = (rank[left.status] ?? 9) - (rank[right.status] ?? 9);
        if (rankDelta !== 0) return rankDelta;
        return String(right.updated || right.created || "").localeCompare(String(left.updated || left.created || ""));
      })[0] || null;
  }

  function agentActivityText(agent, task) {
    const activity = agent?.herdrActivity || {};
    const statusView = agentStatusView(agent);
    const stateLabel = activity.stateLabels?.[statusView.status] || activity.stateLabels?.[agent?.herdrStatus] || "";
    const token = Array.isArray(activity.tokens) ? activity.tokens.find((value) => typeof value === "string" && value.trim()) : "";
    const title = [activity.title, activity.terminalTitle, agent?.herdrTitle]
      .find((value) => {
        const text = String(value || "").trim();
        return text && !/^(opencode|codex|claude code|agent|herdr)$/i.test(text);
      }) || "";
    if (stateLabel) return stateLabel;
    if (token) return token;
    if (title) return title;
    if (task?.title) return task.title;
    if (agent?.herdrStatus && agent.herdrStatus !== "unknown") return statusView.description;
    return "No live Herdr activity signal";
  }

  function agentDisplayName(agent) {
    return String(agent?.profile?.name || agent?.handle || "").trim();
  }

  function compareAgentNames(left, right) {
    const nameDelta = agentDisplayName(left).localeCompare(agentDisplayName(right), "en", { sensitivity: "base" });
    if (nameDelta !== 0) return nameDelta;
    return String(left?.handle || "").localeCompare(String(right?.handle || ""), "en", { sensitivity: "base" });
  }

  function activePresenceHandle() {
    return state.activeAccount && state.activeAccount !== "all" ? state.activeAccount : "";
  }

  function sortAgentsForPresence(agents) {
    const activeHandle = activePresenceHandle();
    return [...agents].sort((left, right) => {
      const activeDelta = Number(left?.handle !== activeHandle) - Number(right?.handle !== activeHandle);
      return activeDelta || compareAgentNames(left, right);
    });
  }

  function renderPresenceList(agents) {
    const sorted = sortAgentsForPresence(agents);
    let html = "";
    for (const agent of sorted) {
      const profile = agent.profile || {};
      const name = profile.name || agent.handle;
      const role = profile.role || "Swarm Agent";
      const emoji = profile.emoji || agent.handle.slice(0, 1).toUpperCase();
      const color = safeCssColor(profile.color);
      const statusView = agentStatusView(agent);
      const live = Boolean(agent.herdrStatus && agent.herdrStatus !== "unknown");
      const current = state.activeAccount === agent.handle;
      const task = getAgentTask(agent.handle);
      const activity = agentActivityText(agent, task);

      html += `
        <button type="button" class="presence-item${live ? " presence-live" : ""}${current ? " presence-current" : ""}" data-agent-handle="${escapeHtml(agent.handle)}" aria-current="${current ? "true" : "false"}" aria-haspopup="dialog" aria-label="View activity for ${escapeHtml(name)}, ${escapeHtml(statusView.description)}" title="${escapeHtml(activity)}">
          <span class="presence-avatar-wrap">
            <span class="mini-avatar" style="background:${escapeHtml(color)};color:#fff;">${escapeHtml(emoji)}</span>
            <span class="presence-dot ${statusView.tone}"></span>
          </span>
          <span class="presence-details">
            <span class="presence-name-row">
              <span class="presence-name">${escapeHtml(agent.handle)}</span>
              <span class="presence-status-pill ${statusView.tone}"${statusView.stale ? ' data-stale="true"' : ""} title="${escapeHtml(statusView.description)}${statusView.stale ? " · snapshot may be stale" : ""}">${statusView.label}</span>
            </span>
            <span class="presence-role">${escapeHtml(role)}</span>
          </span>
          <span class="presence-chevron" aria-hidden="true">›</span>
        </button>
      `;
    }
    presenceListEl.innerHTML = html;
    presenceListEl.querySelectorAll(".presence-item").forEach((button) => {
      button.addEventListener("click", () => openPanesFocus(button.dataset.agentHandle));
    });
    if (agentActivityDialog?.open) renderAgentActivity();
  }

  function renderAgentActivity() {
    const handle = state.activeAgentHandle;
    const agent = state.agents.find((item) => item.handle === handle);
    if (!agent || !agentActivityDialog) return false;
    const profile = agent.profile || {};
    const statusView = agentStatusView(agent);
    const task = getAgentTask(handle);
    const activity = agent.herdrActivity || {};
    const title = String(activity.title || activity.terminalTitle || agent.herdrTitle || "").trim();
    const observedAt = activity.observedAt || agent.herdrObservedAt;
    const taskStatus = task ? task.status.replaceAll("_", " ") : "No active task assigned";
    const taskTone = { in_progress: "working", blocked: "blocked", done: "done", backlog: "idle" }[task?.status] || "offline";

    agentActivityAvatar.textContent = profile.emoji || handle.slice(0, 1).toUpperCase();
    agentActivityAvatar.style.backgroundColor = safeCssColor(profile.color);
    agentActivityName.textContent = profile.name || handle;
    agentActivityHandle.textContent = `${handle}@amq`;
    agentActivityRole.textContent = profile.role || "Swarm Agent";
    agentActivityStatus.textContent = statusView.label;
    agentActivityStatus.title = statusView.description;
    agentActivityStatus.className = `agent-activity-status ${statusView.tone}`;
    agentActivityHeadline.textContent = agentActivityText(agent, task);
    agentActivityTask.textContent = task?.title || "No board task is currently assigned to this agent.";
    agentActivityTaskStatus.textContent = taskStatus;
    agentActivityTaskStatus.className = `agent-task-status ${taskTone}`;
    const liveModel = agent.runtimeModel || activity.model || "";
    const modelSource = agent.modelSource || activity.modelSource || "";
    agentActivityModel.textContent = liveModel || profile.model || "Not configured";
    agentActivityModel.title = liveModel
      ? `Live harness model${modelSource ? ` · ${modelSource}` : ""}`
      : profile.model
        ? "Configured profile model"
        : "No model reported by the harness or profile";
    agentActivityUnread.textContent = String(agent.unreadCount || 0);
    agentActivityPane.textContent = agent.herdrPaneId || "Not tracked";
    agentActivityObserved.textContent = observedAt ? new Date(observedAt).toLocaleString() : "No live snapshot";
    viewAgentTaskBtn.hidden = !task;
    agentActivityDialog.dataset.agentHandle = handle;
    fetchAgentPane(handle);
    return true;
  }

  // Live pane tail appended to the activity card (messenger-style detail).
  // Fire-and-forget with a generation guard: slow reads never overwrite a
  // newer agent selection, and refreshes never blank existing content.
  let agentPaneGen = 0;
  async function fetchAgentPane(handle) {
    if (!agentPaneOutput || !handle) return;
    const myGen = ++agentPaneGen;
    const firstPaint = !agentPaneOutput.dataset.loadedFor;
    if (firstPaint || agentPaneOutput.dataset.loadedFor !== handle) {
      agentPaneOutput.textContent = "Reading live pane…";
    }
    if (refreshAgentPaneBtn) refreshAgentPaneBtn.disabled = true;
    try {
      const res = await fetch(`/api/panes?handle=${encodeURIComponent(handle)}&lines=40`);
      const panes = await res.json();
      if (myGen !== agentPaneGen) return;
      const pane = Array.isArray(panes) ? panes[0] : null;
      if (!pane) {
        agentPaneOutput.textContent = "No live pane tracked for this agent.";
      } else if (pane.ok) {
        agentPaneOutput.textContent = pane.output || "(pane produced no output)";
      } else {
        agentPaneOutput.textContent = "Pane unavailable (Herdr not connected).";
      }
      agentPaneOutput.dataset.loadedFor = handle;
      requestAnimationFrame(() => fitPaneOutput(agentPaneOutput));
    } catch {
      if (myGen !== agentPaneGen) return;
      agentPaneOutput.textContent = "Unable to read the live pane.";
    } finally {
      if (refreshAgentPaneBtn) refreshAgentPaneBtn.disabled = false;
    }
  }

  function openAgentActivity(handle) {
    state.activeAgentHandle = handle;
    if (!renderAgentActivity()) {
      state.activeAgentHandle = null;
      return;
    }
    if (agentActivityDialog.open) return;
    if (typeof agentActivityDialog.showModal === "function") agentActivityDialog.showModal();
    else agentActivityDialog.setAttribute("open", "");
    requestAnimationFrame(() => closeAgentActivityBtn?.focus());
  }

  function closeAgentActivity() {
    if (typeof agentActivityDialog.close === "function") agentActivityDialog.close();
    else agentActivityDialog.removeAttribute("open");
  }

  closeAgentActivityBtn?.addEventListener("click", closeAgentActivity);
  refreshAgentPaneBtn?.addEventListener("click", () => {
    if (state.activeAgentHandle) fetchAgentPane(state.activeAgentHandle);
  });
  agentActivityDialog?.addEventListener("click", (event) => {
    if (event.target !== agentActivityDialog) return;
    const bounds = agentActivityDialog.getBoundingClientRect();
    const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    if (outside) closeAgentActivity();
  });
  agentActivityDialog?.addEventListener("close", () => {
    state.activeAgentHandle = null;
  });
  viewAgentInboxBtn?.addEventListener("click", () => {
    const handle = state.activeAgentHandle;
    closeAgentActivity();
    if (!handle) return;
    switchActiveAccount(handle);
    switchView("mail");
    if (window.innerWidth <= 768) {
      document.body.classList.remove("sidebar-open");
      sidebarBackdrop.classList.add("hidden");
    }
  });
  viewAgentTaskBtn?.addEventListener("click", () => {
    const task = getAgentTask(state.activeAgentHandle);
    closeAgentActivity();
    if (!task) return;
    switchView("board");
    requestAnimationFrame(() => openTaskSheet(task.id));
  });


  function hangoutTimestamp(value) {
    if (!value) return "No timestamp";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "No timestamp" : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  // Latest *report* per agent: prefer messages authored by the agent itself
  // (their own status reports), ignore anything older than 7 days so a
  // stale thread can't masquerade as current activity.
  const HANGOUT_RECENCY_MS = 7 * 24 * 60 * 60 * 1000;
  function latestHangoutMessage(agent) {
    let own = null;
    let ownTime = -1;
    let mention = null;
    let mentionTime = -1;
    const cutoff = Date.now() - HANGOUT_RECENCY_MS;
    for (const thread of state.hangoutThreads) {
      for (const message of thread.messages || []) {
        const time = message.created ? new Date(message.created).getTime() : 0;
        if (!Number.isFinite(time) || time < cutoff) continue;
        if (message.from === agent.handle) {
          if (time >= ownTime) {
            own = message;
            ownTime = time;
          }
          continue;
        }
        const recipients = Array.isArray(message.to) ? message.to : [message.to].filter(Boolean);
        const relevant = message.targetAccount === agent.handle || recipients.includes(agent.handle);
        if (!relevant) continue;
        if (time >= mentionTime) {
          mention = message;
          mentionTime = time;
        }
      }
    }
    return own || mention;
  }

  // Latest-report threads backing the Panes view (unified "what agents are
  // doing" screen; the old Hangouts dialog was removed as redundant).
  async function fetchPaneReports() {
    try {
      const response = await fetch("/api/threads?account=all&folder=all&pageSize=100&paginate=true");
      const data = await response.json();
      state.hangoutThreads = Array.isArray(data) ? data : (data.items || []);
      if (state.currentView === "panes") renderPaneCards();
    } catch {}
  }

  function openComposeForAgent(agent) {
    openComposeBtn.click();
    composeToEl.value = agent.handle;
    composeThreadEl.value = `hangout/${agent.handle}`;
    composeSubjectEl.value = `Status check: ${agent.profile?.name || agent.handle}`;
    composeBodyEl.value = `Checking in on ${agent.profile?.name || agent.handle}.\n\nCurrent activity: ${agentActivityText(agent, getAgentTask(agent.handle))}\n\n`;
  }

  function levenshtein(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }

  function highlightTerms(htmlText, query) {
    if (!htmlText || !query) return htmlText;

    const rawTokens = (query.match(/(?:[^\s"]+|"[^"]*")+/g) || []);
    const tokens = [];

    for (const raw of rawTokens) {
      const clean = raw.replace(/^"|"$/g, "").trim();
      if (!clean) continue;
      if (clean.includes(":")) {
        const idx = clean.indexOf(":");
        const prefix = clean.slice(0, idx).toLowerCase();
        const val = clean.slice(idx + 1).replace(/^"|"$/g, "").trim();
        if ((prefix === "from" || prefix === "to" || prefix === "recipient") && val && val.toLowerCase() !== "me") {
          tokens.push(val);
        }
      } else if (clean.length >= 1) {
        tokens.push(clean);
      }
    }

    if (!tokens.length) return htmlText;

    let result = htmlText;
    for (const term of tokens) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`(?![^<]*>)(${escaped})`, "gi");
      if (regex.test(result)) {
        result = result.replace(regex, '<mark class="search-highlight">$1</mark>');
      } else if (term.length >= 4) {
        // Fuzzy word match highlighting for typo queries (e.g. filtwr -> filter)
        const t = term.toLowerCase();
        result = result.replace(/(?![^<]*>)\b([a-zA-Z0-9_-]+)\b/g, (match, word) => {
          const w = word.toLowerCase();
          if (Math.abs(w.length - t.length) <= 2 && levenshtein(w, t) <= (t.length <= 5 ? 1 : 2)) {
            return `<mark class="search-highlight">${word}</mark>`;
          }
          return match;
        });
      }
    }
    return result;
  }


  function getContextualSmartReplies(subject = "", body = "", kind = "") {
    const text = (subject + " " + body).toLowerCase();
    if (text.includes("lock") || text.includes("contention") || text.includes("blocked")) {
      return [
        "Understood, clearing contention on my lane.",
        "Lane clear, proceeding with coordination lock.",
        "Checked, no conflicting process active.",
      ];
    }
    if (text.includes("test") || text.includes("verify") || text.includes("gate") || text.includes("pass")) {
      return [
        "Verification pass confirmed.",
        "Investigating test results on my branch.",
        "Evidence confirmed in logs.",
      ];
    }
    if (kind === "todo" || text.includes("todo") || text.includes("claim") || text.includes("task")) {
      return [
        "Ack, task claimed and starting work.",
        "Acknowledged, on it.",
        "Task noted, will report back with evidence.",
      ];
    }
    if (text.includes("question") || text.includes("?") || text.includes("consult")) {
      return [
        "Reviewing the question, investigating options.",
        "Understood, checking requirements.",
        "Will provide details shortly.",
      ];
    }
    return [
      "Ack, received and processing.",
      "Understood, thank you.",
      "Acknowledged, checking status.",
    ];
  }

  // ─── Mail List & Thread Rendering ──────────────────────────────────────────

  function renderList() {
    let filtered = [...state.items];

    // Filter by category
    if (state.activeCategory === "gate") {
      filtered = filtered.filter((item) => {
        const text = (item.subject + " " + (item.latestSnippet || item.snippet || "")).toLowerCase();
        return text.includes("gate") || text.includes("verify") || text.includes("pass") || text.includes("lock");
      });
    } else if (state.activeCategory === "brainstorm") {
      filtered = filtered.filter((item) => {
        const text = (item.subject + " " + (item.latestSnippet || item.snippet || "")).toLowerCase();
        return text.includes("brainstorm") || text.includes("survey") || text.includes("design");
      });
    }
    if (state.activeFolder === "starred") {
      filtered = filtered.filter((item) => state.starredIds.has(state.viewMode === "threads" ? item.threadId : item.id));
      // Starred is client-side state, so the server's all-mail total is not
      // the filtered total. Keep the visible result honest for this page.
      state.total = filtered.length;
      state.totalPages = 1;
      state.page = 1;
    }

    const countLabel = state.viewMode === "threads" ? "threads" : "messages";
    const start = state.total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
    const end = Math.min(state.page * state.pageSize, state.total);
    pageInfoEl.textContent = state.total > 0 ? `${start}-${end} of ${state.total.toLocaleString()} ${countLabel}` : `0 ${countLabel}`;

    if (prevPageBtn) prevPageBtn.disabled = state.page <= 1;
    if (nextPageBtn) nextPageBtn.disabled = state.page >= state.totalPages;

    const currentPersona = getActiveSender();
    filterInfoEl.textContent = `Account: ${state.activeAccount} • Persona: ${currentPersona} • Mode: ${state.viewMode}`;

    if (!filtered.length) {
      mailListEl.innerHTML = `<div class="empty-state">No transmissions found matching criteria.</div>`;
      return;
    }

    if (state.viewMode === "threads") {
      renderThreadList(filtered);
    } else {
      renderFlatList(filtered);
    }
  }

  function renderThreadList(threads) {
    let html = "";
    for (const t of threads) {
      const isUnread = t.hasUnread;
      const isStarred = state.starredIds.has(t.threadId);
      const isSelected = state.selectedThreadId === t.threadId;
      const dateStr = formatTimestamp(t.latestCreated);

      const senders = t.participants.join(", ");
      const countSuffix = t.messageCount > 1 ? `<span class="thread-count-badge">(${t.messageCount})</span>` : "";

      let badgesHtml = "";
      if (isUnread) badgesHtml += `<span class="tag-badge tag-new">New</span>`;
      if (t.hasImage) badgesHtml += `<span title="Contains image artifacts">🖼️</span>`;
      if (t.hasAttachment) badgesHtml += `<span title="Contains file attachments">📎</span>`;
      if ((t.subject + " " + t.latestSnippet).includes("PASS")) badgesHtml += `<span class="tag-badge tag-gate">Gate</span>`;

      const subjectHighlighted = highlightTerms(escapeHtml(t.subject || "(no subject)"), state.searchQuery);
      const snippetHighlighted = highlightTerms(escapeHtml(t.latestSnippet || ""), state.searchQuery);
      const sendersHighlighted = highlightTerms(escapeHtml(senders), state.searchQuery);

      html += `
        <div class="mail-row ${isUnread ? "unread" : "read"} ${isSelected ? "selected" : ""}" data-thread-id="${t.threadId}" role="button" tabindex="0" aria-current="${isSelected ? "true" : "false"}">
          <div class="mail-row-actions">
            <button class="star-btn ${isStarred ? "starred" : ""}" data-star-id="${t.threadId}" title="Star thread">
              ${isStarred ? "★" : "☆"}
            </button>
          </div>
          <div class="mail-sender" title="${senders}">
            <span>${sendersHighlighted}</span> ${countSuffix}
          </div>
          <div class="mail-subject-wrap">
            <span class="mail-subject">${subjectHighlighted}</span>
            <span class="mail-snippet">: ${snippetHighlighted}</span>
            <div class="mail-badges">${badgesHtml}</div>
          </div>
          <div class="mail-date">${dateStr}</div>
        </div>
      `;
    }

    mailListEl.innerHTML = html;

    mailListEl.querySelectorAll(".mail-row").forEach((row) => {
      const activate = () => {
        const threadId = row.dataset.threadId;
        const thread = state.items.find((t) => t.threadId === threadId);
        if (thread) openThread(thread);
      };
      row.addEventListener("click", (e) => {
        if (!e.target.closest(".star-btn")) activate();
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
    });

    attachStarListeners();
  }

  function renderFlatList(messages) {
    let html = "";
    for (const m of messages) {
      const isStarred = state.starredIds.has(m.id);
      const isUnread = m.isNew;
      const isSelected = state.selectedMessageId === m.id;
      const dateStr = formatTimestamp(m.created);

      let badgesHtml = "";
      if (isUnread) badgesHtml += `<span class="tag-badge tag-new">New</span>`;
      if (m.hasImage) badgesHtml += `<span title="Contains image artifacts">🖼️</span>`;
      if (m.hasAttachment) badgesHtml += `<span title="Contains file attachments">📎</span>`;
      if ((m.subject + " " + m.body).includes("PASS")) badgesHtml += `<span class="tag-badge tag-gate">Gate</span>`;

      const subjectHighlighted = highlightTerms(escapeHtml(m.subject || "(no subject)"), state.searchQuery);
      const snippetHighlighted = highlightTerms(escapeHtml(m.snippet || ""), state.searchQuery);
      const senderHighlighted = highlightTerms(escapeHtml(m.from || "unknown"), state.searchQuery);

      html += `
        <div class="mail-row ${isUnread ? "unread" : "read"} ${isSelected ? "selected" : ""}" data-msg-id="${m.id}" role="button" tabindex="0" aria-current="${isSelected ? "true" : "false"}">
          <div class="mail-row-actions">
            <button class="star-btn ${isStarred ? "starred" : ""}" data-star-id="${m.id}" title="Star message">
              ${isStarred ? "★" : "☆"}
            </button>
          </div>
          <div class="mail-sender" title="${m.from || "unknown"}">
            ${senderHighlighted}
          </div>
          <div class="mail-subject-wrap">
            <span class="mail-subject">${subjectHighlighted}</span>
            <span class="mail-snippet">: ${snippetHighlighted}</span>
            <div class="mail-badges">${badgesHtml}</div>
          </div>
          <div class="mail-date">${dateStr}</div>
        </div>
      `;
    }

    mailListEl.innerHTML = html;

    mailListEl.querySelectorAll(".mail-row").forEach((row) => {
      const activate = () => {
        const msgId = row.dataset.msgId;
        const msg = state.items.find((m) => m.id === msgId);
        if (msg) openSingleMessage(msg);
      };
      row.addEventListener("click", (e) => {
        if (!e.target.closest(".star-btn")) activate();
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
    });

    attachStarListeners();
  }

  function attachStarListeners() {
    mailListEl.querySelectorAll(".star-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.starId;
        if (state.starredIds.has(id)) {
          state.starredIds.delete(id);
        } else {
          state.starredIds.add(id);
        }
        localStorage.setItem("agmail_starred", JSON.stringify([...state.starredIds]));
        renderList();
      });
    });
  }

  function syncSelectedMailRow() {
    mailListEl.querySelectorAll(".mail-row").forEach((row) => {
      const selected = state.viewMode === "threads"
        ? row.dataset.threadId === state.selectedThreadId
        : row.dataset.msgId === state.selectedMessageId;
      row.classList.toggle("selected", selected);
      row.setAttribute("aria-current", selected ? "true" : "false");
    });
  }

  function showMessageDetail() {
    state.detailOpen = true;
    contentSplitterEl.classList.add("detail-open");
    mailDetailViewEl.classList.remove("hidden");
    syncSelectedMailRow();
    mailDetailViewEl.scrollTop = 0;
    requestAnimationFrame(() => {
      const latestMessage = threadMessagesListEl.querySelector(".thread-card.expanded") || threadMessagesListEl.lastElementChild;
      if (latestMessage) {
        const detailTop = mailDetailViewEl.getBoundingClientRect().top;
        const headerHeight = mailDetailViewEl.querySelector(".detail-header")?.getBoundingClientRect().height || 0;
        const latestTop = latestMessage.getBoundingClientRect().top - detailTop;
        mailDetailViewEl.scrollTop = Math.max(0, latestTop - headerHeight - 12);
        if (state.readingLayout === "full" || window.matchMedia("(max-width: 768px)").matches) {
          latestMessage.tabIndex = -1;
          latestMessage.focus({ preventScroll: true });
        }
      } else if (state.readingLayout === "full" || window.matchMedia("(max-width: 768px)").matches) {
        mailDetailViewEl.focus({ preventScroll: true });
      }
    });
  }

  function hideMessageDetail(restoreFocus = false) {
    state.detailOpen = false;
    contentSplitterEl.classList.remove("detail-open");
    mailDetailViewEl.classList.add("hidden");
    if (restoreFocus) {
      requestAnimationFrame(() => mailListEl.querySelector(".mail-row.selected")?.focus({ preventScroll: true }));
    }
  }

  async function markMessageRead(message) {
    // Dashboard persona/account switching is an inspection surface, not an
    // agent action. Never move an impersonated mailbox message new -> cur;
    // only the agent's explicit drain/read path may do that.
    if (state.activeAccount !== "user") return;
    if (!message?.isNew || state.activeAccount === "all") return;
    const account = message.targetAccount || state.activeAccount;
    if (!account || account === "all") return;
    try {
      const res = await fetch(`/api/messages/${encodeURIComponent(message.id)}/read?account=${encodeURIComponent(account)}`, { method: "POST" });
      if (!res.ok) return;
      message.isNew = false;
      const thread = state.items.find((item) => item.threadId === state.selectedThreadId);
      if (thread) thread.hasUnread = (thread.messages || []).some((item) => item.isNew);
      renderList();
    } catch {}
  }

  function markThreadRead(messages) {
    return Promise.all((messages || []).filter((message) => message.isNew).map((message) => markMessageRead(message)));
  }

  // ─── Open Thread (Conversation View) ────────────────────────────────────────

  function openThread(thread) {
    state.selectedThreadId = thread.threadId;

    if (state.searchQuery) {
      detailSubjectEl.innerHTML = highlightTerms(escapeHtml(thread.subject || "(no subject)"), state.searchQuery);
    } else {
      detailSubjectEl.textContent = thread.subject || "(no subject)";
    }
    detailThreadBadgeEl.textContent = `#${thread.threadId} (${thread.messageCount})`;

    const msgs = thread.messages || [];
    let html = "";

    msgs.forEach((m, idx) => {
      const isLatest = idx === msgs.length - 1;
      const agentObj = state.agents.find((x) => x.handle === m.from);
      const prof = agentObj?.profile || { name: m.from, emoji: (m.from || "?").slice(0, 1).toUpperCase(), color: "#1a73e8", role: "Persona" };
      const dateStr = m.created ? new Date(m.created).toLocaleString() : "";
      const toStr = Array.isArray(m.to) ? m.to.join(", ") : (m.to || "all");
      const renderedBody = renderMarkdown(m.body);
      const highlightedBody = state.searchQuery ? highlightTerms(renderedBody, state.searchQuery) : renderedBody;
      const attachmentsHtml = renderAttachmentsSection(m.attachments);

      html += `
        <div class="thread-card ${isLatest ? "expanded" : "collapsed"}" data-card-idx="${idx}" data-msg-id="${m.id}" data-msg-from="${m.from}">
          <div class="thread-card-header">
            <div class="thread-card-header-left">
              <div class="thread-card-avatar" style="background:${prof.color};color:#fff;">${prof.emoji}</div>
              <strong class="thread-card-author">${prof.name}</strong>
              <span class="thread-card-snippet">${escapeHtml(m.snippet || "")}</span>
            </div>
            <div class="thread-card-date">${dateStr}</div>
          </div>
          <div class="thread-card-body">
            <div style="font-size:12px;color:#5f6368;margin-bottom:12px;">
              <span>from: <strong>${m.from}</strong> (${prof.role}) &lt;${m.from}@amq&gt;</span> • 
              <span>to: ${toStr}</span> • 
              <span>date: ${dateStr}</span>
            </div>
            <div class="md-content">${highlightedBody}</div>
            ${attachmentsHtml}
          </div>
        </div>
      `;
    });

    threadMessagesListEl.innerHTML = html;

    // Attach card expansion clicks
    threadMessagesListEl.querySelectorAll(".thread-card-header").forEach((header) => {
      header.addEventListener("click", () => {
        const card = header.closest(".thread-card");
        card.classList.toggle("collapsed");
        card.classList.toggle("expanded");
      });
    });

    // Set reply context to latest message
    const latestMsg = msgs[msgs.length - 1];
    state.selectedMessageId = latestMsg ? latestMsg.id : null;
    quickReplyTextEl.value = "";

    // Dynamic contextual Smart Replies
    const replies = getContextualSmartReplies(latestMsg?.subject || "", latestMsg?.body || "", latestMsg?.kind || "");
    smartRepliesChipsEl.innerHTML = replies
      .map((r) => `<button class="chip" data-text="${escapeHtml(r)}">${escapeHtml(r)}</button>`)
      .join("");

    void markThreadRead(msgs);
    showMessageDetail();
  }

  function openSingleMessage(msg) {
    state.selectedMessageId = msg.id;

    if (state.searchQuery) {
      detailSubjectEl.innerHTML = highlightTerms(escapeHtml(msg.subject || "(no subject)"), state.searchQuery);
    } else {
      detailSubjectEl.textContent = msg.subject || "(no subject)";
    }
    detailThreadBadgeEl.textContent = msg.thread ? `#${msg.thread}` : "";

    const agentObj = state.agents.find((x) => x.handle === msg.from);
    const prof = agentObj?.profile || { name: msg.from, emoji: (msg.from || "?").slice(0, 1).toUpperCase(), color: "#1a73e8", role: "Persona" };
    const dateStr = msg.created ? new Date(msg.created).toLocaleString() : "";
    const toStr = Array.isArray(msg.to) ? msg.to.join(", ") : (msg.to || "all");
    const renderedBody = renderMarkdown(msg.body);
    const highlightedBody = state.searchQuery ? highlightTerms(renderedBody, state.searchQuery) : renderedBody;
    const attachmentsHtml = renderAttachmentsSection(msg.attachments);

    threadMessagesListEl.innerHTML = `
      <div class="thread-card expanded" data-msg-id="${msg.id}" data-msg-from="${msg.from}">
        <div class="thread-card-header">
          <div class="thread-card-header-left">
            <div class="thread-card-avatar" style="background:${prof.color};color:#fff;">${prof.emoji}</div>
            <strong class="thread-card-author">${prof.name}</strong>
          </div>
          <div class="thread-card-date">${dateStr}</div>
        </div>
        <div class="thread-card-body">
          <div style="font-size:12px;color:#5f6368;margin-bottom:12px;">
            <span>from: <strong>${msg.from}</strong> (${prof.role}) &lt;${msg.from}@amq&gt;</span> • 
            <span>to: ${toStr}</span> • 
            <span>date: ${dateStr}</span>
          </div>
          <div class="md-content">${highlightedBody}</div>
          ${attachmentsHtml}
        </div>
      </div>
    `;

    quickReplyTextEl.value = "";

    // Dynamic contextual Smart Replies
    const replies = getContextualSmartReplies(msg.subject || "", msg.body || "", msg.kind || "");
    smartRepliesChipsEl.innerHTML = replies
      .map((r) => `<button class="chip" data-text="${escapeHtml(r)}">${escapeHtml(r)}</button>`)
      .join("");

    void markMessageRead(msg);
    showMessageDetail();
  }

  // Expand / collapse all cards in thread
  let allExpanded = false;
  expandCollapseBtn.addEventListener("click", () => {
    allExpanded = !allExpanded;
    threadMessagesListEl.querySelectorAll(".thread-card").forEach((card) => {
      if (allExpanded) {
        card.classList.remove("collapsed");
        card.classList.add("expanded");
      } else {
        card.classList.add("collapsed");
        card.classList.remove("expanded");
      }
    });
  });

  // ─── Markdown Renderer ──────────────────────────────────────────────────────

  function renderMarkdown(md) {
    if (!md) return "";

    // 1. Normalize line endings to LF
    const text = String(md).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // 2. Extract fenced code blocks line-by-line so comments (# ...) are never treated as headings
    const lines = text.split("\n");
    let inCodeBlock = false;
    let codeFence = "";
    let codeLang = "";
    let codeLines = [];
    const proseLines = [];
    const codeBlocks = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!inCodeBlock) {
        const fenceMatch = line.match(/^[ \t]*(`{3,}|~{3,})([a-zA-Z0-9_+#.-]*)[^\n]*$/);
        if (fenceMatch) {
          inCodeBlock = true;
          codeFence = fenceMatch[1];
          codeLang = (fenceMatch[2] || "code").trim();
          codeLines = [];
          continue;
        }
        proseLines.push(line);
      } else {
        const closeMatch = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
        if (closeMatch && closeMatch[1][0] === codeFence[0] && closeMatch[1].length >= codeFence.length) {
          inCodeBlock = false;
          const cleanCode = codeLines.join("\n");
          const escapedCode = escapeHtml(cleanCode);
          const blockHtml = `<div class="code-block-wrapper">
  <div class="code-block-header">
    <span class="code-lang">${escapeHtml(codeLang || "code")}</span>
    <button class="copy-code-btn" onclick="copyCode(this)">Copy</button>
  </div>
  <pre><code>${escapedCode}</code></pre>
</div>`;
          const idx = codeBlocks.length;
          codeBlocks.push(blockHtml);
          proseLines.push(`\x00AMQ_BLOCK_${idx}_\x00`);
          continue;
        }
        codeLines.push(line);
      }
    }

    // Handle unclosed fenced code block at end of input
    if (inCodeBlock) {
      const cleanCode = codeLines.join("\n");
      const escapedCode = escapeHtml(cleanCode);
      const blockHtml = `<div class="code-block-wrapper">
  <div class="code-block-header">
    <span class="code-lang">${escapeHtml(codeLang || "code")}</span>
    <button class="copy-code-btn" onclick="copyCode(this)">Copy</button>
  </div>
  <pre><code>${escapedCode}</code></pre>
</div>`;
      const idx = codeBlocks.length;
      codeBlocks.push(blockHtml);
      proseLines.push(`\x00AMQ_BLOCK_${idx}_\x00`);
    }

    let prose = proseLines.join("\n");

    // 3. Extract inline code so inline snippets are not affected by prose formatting
    const inlineCodes = [];
    prose = prose.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (match, fence, code) => {
      const escaped = escapeHtml(code);
      const idx = inlineCodes.length;
      inlineCodes.push(`<code class="inline-code">${escaped}</code>`);
      return `\x00AMQ_INLINE_${idx}_\x00`;
    });

    // 4. Escape remaining HTML in prose for injection protection
    let html = escapeHtml(prose);

    // 5. Blockquotes (handling both escaped &gt; and unescaped >)
    html = html.replace(/^(?:&gt;|>)[ \t]?(.*$)/gm, '<blockquote class="md-quote">$1</blockquote>');
    html = html.replace(/<\/blockquote>\n<blockquote class="md-quote">/g, "<br>");

    // 6. Headings in prose (requiring whitespace after # to avoid false matches on tags or includes)
    html = html.replace(/^######[ \t]+(.*$)/gm, '<h6 class="md-h6">$1</h6>');
    html = html.replace(/^#####[ \t]+(.*$)/gm, '<h5 class="md-h5">$1</h5>');
    html = html.replace(/^####[ \t]+(.*$)/gm, '<h4 class="md-h4">$1</h4>');
    html = html.replace(/^###[ \t]+(.*$)/gm, '<h3 class="md-h3">$1</h3>');
    html = html.replace(/^##[ \t]+(.*$)/gm, '<h2 class="md-h2">$1</h2>');
    html = html.replace(/^#[ \t]+(.*$)/gm, '<h1 class="md-h1">$1</h1>');

    // 7. Markdown tables in prose
    const tableRegex = /((?:^[ \t]*\|?[^\n\r|]+(?:\|[^\n\r|]+)+\|?[ \t]*\n)(?:^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+(?:[ \t]*:?-+:?[ \t]*)\|?[ \t]*\n)(?:^[ \t]*\|?[^\n\r|]+(?:\|[^\n\r|]+)+\|?[ \t]*(?:\n|$))+)/gm;
    html = html.replace(tableRegex, (match) => {
      const tableLines = match.trim().split(/\n/).map((l) => l.trim()).filter(Boolean);
      if (tableLines.length < 2) return match;
      const parseRow = (line) => {
        let clean = line;
        if (clean.startsWith("|")) clean = clean.slice(1);
        if (clean.endsWith("|")) clean = clean.slice(0, -1);
        return clean.split("|").map((c) => c.trim());
      };
      const headerCols = parseRow(tableLines[0]);
      const alignLine = parseRow(tableLines[1]);
      const aligns = alignLine.map((col) => {
        const left = col.startsWith(":");
        const right = col.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        return "left";
      });
      let tableHtml = '<div class="table-container"><table class="md-table"><thead><tr>';
      headerCols.forEach((col, idx) => {
        const align = aligns[idx] || "left";
        tableHtml += `<th style="text-align: ${align}">${col}</th>`;
      });
      tableHtml += "</tr></thead><tbody>";
      for (let j = 2; j < tableLines.length; j++) {
        const rowCols = parseRow(tableLines[j]);
        tableHtml += "<tr>";
        headerCols.forEach((_, idx) => {
          const cell = rowCols[idx] !== undefined ? rowCols[idx] : "";
          const align = aligns[idx] || "left";
          tableHtml += `<td style="text-align: ${align}">${cell}</td>`;
        });
        tableHtml += "</tr>";
      }
      tableHtml += "</tbody></table></div>\n";
      return tableHtml;
    });

    // 8. Bold, Italic, Strikethrough in prose
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
    html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");

    // 9. Lists in prose
    html = html.replace(/^([0-9]+\.|\([0-9]+\))[ \t]+(.*$)/gm, '<div class="md-list-item"><span class="md-list-num">$1</span> <span>$2</span></div>');
    html = html.replace(/^[-*+][ \t]+(.*$)/gm, '<div class="md-bullet-item">• $1</div>');

    // 10. Links in prose: [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="md-link">$1</a>');

    // 11. Paragraph breaks in prose
    html = html.replace(/\n{2,}/g, '<div class="md-para-break"></div>');

    // 12. Restore inline code
    for (let k = 0; k < inlineCodes.length; k++) {
      html = html.replace(`\x00AMQ_INLINE_${k}_\x00`, () => inlineCodes[k]);
    }

    // 13. Restore code blocks
    for (let b = 0; b < codeBlocks.length; b++) {
      html = html.replace(`\x00AMQ_BLOCK_${b}_\x00`, () => codeBlocks[b]);
    }

    return html;
  }

  // ─── Attachments Section ───────────────────────────────────────────────────

  function renderAttachmentsSection(attachments) {
    if (!attachments || !attachments.length) return "";

    const images = attachments.filter((a) => a.isImage);
    const videos = attachments.filter((a) => !a.isImage && a.isVideo);
    const otherFiles = attachments.filter((a) => !a.isImage && !a.isVideo);

    let html = `<div class="attachments-container">`;
    html += `<div class="attachments-header"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5V6H9v9.5a3 3 0 0 0 6 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg> <span>Attachments & Visual Artifacts (${attachments.length})</span></div>`;

    if (images.length) {
      html += `<div class="attachment-gallery">`;
      for (const img of images) {
        if (!img.exists) {
          html += `
            <div class="attachment-image-card missing" title="Image referenced in transmission but not found on disk: ${escapeHtml(img.originalRef || img.path)}">
              <div class="attachment-thumb-wrap missing-thumb">
                <span class="missing-thumb-icon">⚠️</span>
                <span class="missing-thumb-text">Image not found on disk</span>
              </div>
              <span class="attachment-filename">${escapeHtml(img.name)}</span>
            </div>
          `;
        } else {
          const fileUrl = img.url || `/api/file?path=${encodeURIComponent(img.path)}`;
          html += `
            <div class="attachment-image-card" onclick="openImageLightbox('${fileUrl}', '${escapeHtml(img.name)}')">
              <div class="attachment-thumb-wrap">
                <img src="${fileUrl}" alt="${escapeHtml(img.name)}" loading="lazy" onerror="this.onerror=null;this.parentElement.innerHTML='<div class=\\'broken-img\\'>🖼️ ${escapeHtml(img.name)}</div>'">
              </div>
              <span class="attachment-filename">${escapeHtml(img.name)}</span>
            </div>
          `;
        }
      }
      html += `</div>`;
    }

    if (videos.length) {
      html += `<div class="attachment-gallery attachment-video-gallery">`;
      for (const vid of videos) {
        if (!vid.exists) {
          html += `
            <div class="attachment-image-card missing" title="Video referenced in transmission but not found on disk: ${escapeHtml(vid.originalRef || vid.path)}">
              <div class="attachment-thumb-wrap missing-thumb">
                <span class="missing-thumb-icon">⚠️</span>
                <span class="missing-thumb-text">Video not found on disk</span>
              </div>
              <span class="attachment-filename">${escapeHtml(vid.name)}</span>
            </div>
          `;
        } else {
          // Same-origin blob/file stream: allowed by media-src 'self'.
          // No Range/206 support yet, so seeking is unavailable — short
          // pilot clips play progressively (use faststart MP4s).
          const fileUrl = vid.url || `/api/file?path=${encodeURIComponent(vid.path)}`;
          html += `
            <div class="attachment-image-card attachment-video-card">
              <div class="attachment-thumb-wrap">
                <video controls preload="metadata" src="${fileUrl}" style="max-width:100%;max-height:320px;"></video>
              </div>
              <span class="attachment-filename">${escapeHtml(vid.name)}</span>
            </div>
          `;
        }
      }
      html += `</div>`;
    }

    if (otherFiles.length) {
      html += `<div class="attachment-files-list">`;
      for (const f of otherFiles) {
        if (!f.exists) {
          html += `
            <div class="attachment-file-chip missing" title="File referenced in transmission but not found on disk: ${escapeHtml(f.originalRef || f.path)}">
              <span class="file-icon">⚠️</span>
              <span class="file-name">${escapeHtml(f.name)}</span>
              <span class="file-missing-badge">missing</span>
            </div>
          `;
        } else {
          const fileUrl = f.url || `/api/file?path=${encodeURIComponent(f.path)}`;
          const icon = f.isLog ? "📄" : "📎";
          const sizeBadge = f.sizeDisplay ? `<span class="file-size">(${escapeHtml(f.sizeDisplay)})</span>` : "";
          html += `
            <a href="${fileUrl}" target="_blank" class="attachment-file-chip" title="${escapeHtml(f.path)}">
              <span class="file-icon">${icon}</span>
              <span class="file-name">${escapeHtml(f.name)}</span>
              ${sizeBadge}
              <span class="file-action">↗</span>
            </a>
          `;
        }
      }
      html += `</div>`;
    }

    html += `</div>`;
    return html;
  }

  // ─── Toolbar View Mode Toggle ───────────────────────────────────────────────

  viewModeThreadsBtn.addEventListener("click", () => {
    viewModeThreadsBtn.classList.add("active");
    viewModeFlatBtn.classList.remove("active");
    state.viewMode = "threads";
    state.page = 1;
    fetchData();
  });

  viewModeFlatBtn.addEventListener("click", () => {
    viewModeFlatBtn.classList.add("active");
    viewModeThreadsBtn.classList.remove("active");
    state.viewMode = "flat";
    state.page = 1;
    fetchData();
  });

  // ─── Folders & Categories ───────────────────────────────────────────────────

  document.querySelectorAll(".folder-list .nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".folder-list .nav-item").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.activeFolder = btn.dataset.folder;
      state.page = 1;
      if (state.detailOpen) hideMessageDetail();
      if (state.currentView !== "mail") {
        switchView("mail");
      } else {
        fetchData();
      }
    });
  });

  document.querySelectorAll(".category-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".category-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.activeCategory = btn.dataset.category;
      state.page = 1;
      if (state.detailOpen) hideMessageDetail();
      if (state.currentView !== "mail") {
        switchView("mail");
      } else {
        renderList();
      }
    });
  });

  // ─── Search & Google-style Autocomplete Dropdown ───────────────────────────

  let selectedSuggestionIndex = -1;
  let currentSuggestions = [];

  function updateSearchState() {
    const val = searchInputEl.value.trim();
    if (val.length > 0) {
      headerSearchContainer.classList.add("has-query");
      clearSearchBtn.classList.remove("hidden");
    } else {
      headerSearchContainer.classList.remove("has-query");
      clearSearchBtn.classList.add("hidden");
    }
  }

  function getSearchSuggestions(inputVal) {
    const isTrailingSpace = (inputVal || "").endsWith(" ");
    const parts = (inputVal || "").split(/\s+/).filter(Boolean);
    const existingTokens = new Set(parts.map((p) => p.toLowerCase()));
    const activeToken = isTrailingSpace ? "" : (parts[parts.length - 1] || "").toLowerCase();

    const currentPersona = getActiveSender();
    const personaObj = Array.isArray(state.agents) ? state.agents.find((x) => x.handle === currentPersona) : null;
    const personaTitle = personaObj?.profile?.name || currentPersona;
    const personaAvatar = personaObj?.profile?.emoji || "👤";

    // Standard filter operators
    const baseItems = [
      { token: "from:me", icon: personaAvatar, desc: `Sent by me (${personaTitle})` },
      { token: "to:me", icon: "📥", desc: `Received by me (${personaTitle})` },
      { token: "is:unread", icon: "📬", desc: "Unread transmissions" },
      { token: "is:starred", icon: "⭐", desc: "Starred transmissions" },
      { token: "is:read", icon: "✉️", desc: "Read transmissions" },
      { token: "has:attachment", icon: "📎", desc: "Transmissions with attachments" },
      { token: "has:image", icon: "🖼️", desc: "Transmissions with images" },
    ];

    // Dynamic agent filters derived from state.agents (never hardcoded)
    const agentItems = [];
    if (Array.isArray(state.agents)) {
      for (const agent of state.agents) {
        const handle = agent.name;
        const title = agent.title || "Agent";
        const avatar = agent.avatar || "🤖";
        agentItems.push({
          token: `from:${handle}`,
          icon: avatar,
          desc: `Transmissions sent by ${handle} (${title})`,
        });
        agentItems.push({
          token: `to:${handle}`,
          icon: "📨",
          desc: `Transmissions addressed to ${handle}`,
        });
      }
    }

    const allCandidates = [...baseItems, ...agentItems];

    // Exclude tokens that are already completely typed into the search bar
    const available = allCandidates.filter((item) => {
      const lower = item.token.toLowerCase();
      if (lower === activeToken) return false;
      if (existingTokens.has(lower) && activeToken !== lower) return false;
      return true;
    });

    if (!activeToken) {
      // When input is blank or after a space, show quick filter suggestions
      return available.slice(0, 10);
    }

    // Score and filter by active typing token
    const scored = [];
    for (const item of available) {
      const lowerTok = item.token.toLowerCase();
      const lowerDesc = item.desc.toLowerCase();

      if (lowerTok.startsWith(activeToken)) {
        scored.push({ item, score: 100 });
      } else if (lowerTok.includes(activeToken)) {
        scored.push({ item, score: 70 });
      } else if (lowerDesc.includes(activeToken)) {
        scored.push({ item, score: 40 });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.item).slice(0, 10);
  }

  function highlightMatch(text, query) {
    if (!query) return escapeHtml(text);
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return escapeHtml(text);
    const before = escapeHtml(text.slice(0, idx));
    const match = escapeHtml(text.slice(idx, idx + query.length));
    const after = escapeHtml(text.slice(idx + query.length));
    return `${before}<strong>${match}</strong>${after}`;
  }

  function renderSuggestions(query) {
    currentSuggestions = getSearchSuggestions(query);
    selectedSuggestionIndex = -1;

    if (!currentSuggestions.length) {
      searchAutocompleteDropdownEl.classList.add("hidden");
      searchBarEl.classList.remove("dropdown-open");
      return;
    }

    const tokens = (query || "").split(/\s+/).filter(Boolean);
    const isTrailingSpace = (query || "").endsWith(" ");
    const activeToken = isTrailingSpace ? "" : (tokens[tokens.length - 1] || "");

    let html = "";
    currentSuggestions.forEach((item, idx) => {
      html += `
        <div class="suggestion-item" data-token="${escapeHtml(item.token)}" data-index="${idx}">
          <span class="suggestion-icon">${item.icon}</span>
          <div class="suggestion-content">
            <span class="suggestion-token">${highlightMatch(item.token, activeToken)}</span>
            <span class="suggestion-desc">${escapeHtml(item.desc)}</span>
          </div>
        </div>
      `;
    });

    searchSuggestionsListEl.innerHTML = html;
    searchAutocompleteDropdownEl.classList.remove("hidden");
    searchBarEl.classList.add("dropdown-open");
  }

  function hideSearchSuggestions() {
    searchAutocompleteDropdownEl.classList.add("hidden");
    searchBarEl.classList.remove("dropdown-open");
    selectedSuggestionIndex = -1;
  }

  function updateSuggestionSelection() {
    const items = searchSuggestionsListEl.querySelectorAll(".suggestion-item");
    items.forEach((item, idx) => {
      const isSel = idx === selectedSuggestionIndex;
      item.classList.toggle("selected", isSel);
      if (isSel) {
        item.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function applySuggestion(token) {
    let val = searchInputEl.value;
    const parts = val.split(/\s+/).filter(Boolean);

    if (parts.length > 0 && !val.endsWith(" ")) {
      const last = parts[parts.length - 1].toLowerCase();
      if (
        token.toLowerCase().startsWith(last) ||
        (last.includes(":") && token.toLowerCase().startsWith(last.split(":")[0] + ":")) ||
        token.toLowerCase().includes(last)
      ) {
        parts[parts.length - 1] = token;
        val = parts.join(" ") + " ";
      } else {
        val = parts.join(" ") + " " + token + " ";
      }
    } else {
      val = (val.trim() ? val.trim() + " " : "") + token + " ";
    }

    // Deduplicate tokens
    const unique = [];
    for (const p of val.split(/\s+/).filter(Boolean)) {
      if (!unique.includes(p)) {
        unique.push(p);
      }
    }

    const nextVal = unique.join(" ") + " ";
    searchInputEl.value = nextVal;
    state.searchQuery = nextVal.trim();
    updateSearchState();
    fetchData();

    // Re-render suggestions for the updated query so user can click another token immediately
    renderSuggestions(nextVal);
    searchInputEl.focus();
  }

  // Prevent mousedown inside dropdown from stealing focus or triggering blur on search input
  searchAutocompleteDropdownEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
  });

  // Click suggestion row to add to query
  searchSuggestionsListEl.addEventListener("click", (e) => {
    const row = e.target.closest(".suggestion-item");
    if (!row) return;
    const token = row.dataset.token;
    if (token) {
      applySuggestion(token);
    }
  });

  // Focus and input listeners
  searchInputEl.addEventListener("focus", () => {
    headerSearchContainer.classList.add("search-focused");
    renderSuggestions(searchInputEl.value);
  });

  searchInputEl.addEventListener("blur", () => {
    setTimeout(() => {
      headerSearchContainer.classList.remove("search-focused");
      hideSearchSuggestions();
    }, 150);
  });

  let searchTimer = null;
  searchInputEl.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const val = e.target.value;
    updateSearchState();
    renderSuggestions(val);
    searchTimer = setTimeout(() => {
      state.searchQuery = val.trim();
      fetchData();
    }, 200);
  });

  // Keyboard navigation for dropdown
  searchInputEl.addEventListener("keydown", (e) => {
    const isOpen = !searchAutocompleteDropdownEl.classList.contains("hidden");

    if (e.key === "ArrowDown") {
      if (!isOpen) {
        renderSuggestions(searchInputEl.value);
        return;
      }
      e.preventDefault();
      if (currentSuggestions.length > 0) {
        selectedSuggestionIndex = (selectedSuggestionIndex + 1) % currentSuggestions.length;
        updateSuggestionSelection();
      }
    } else if (e.key === "ArrowUp") {
      if (!isOpen) return;
      e.preventDefault();
      if (currentSuggestions.length > 0) {
        selectedSuggestionIndex = (selectedSuggestionIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
        updateSuggestionSelection();
      }
    } else if (e.key === "Enter") {
      if (isOpen && selectedSuggestionIndex >= 0 && currentSuggestions[selectedSuggestionIndex]) {
        e.preventDefault();
        applySuggestion(currentSuggestions[selectedSuggestionIndex].token);
      } else {
        hideSearchSuggestions();
        state.searchQuery = searchInputEl.value.trim();
        fetchData();
      }
    } else if (e.key === "Escape") {
      if (isOpen) {
        e.preventDefault();
        hideSearchSuggestions();
      }
    }
  });

  clearSearchBtn.addEventListener("click", () => {
    searchInputEl.value = "";
    updateSearchState();
    state.searchQuery = "";
    hideSearchSuggestions();
    fetchData();
    searchInputEl.focus();
  });

  document.addEventListener("click", (e) => {
    if (!headerSearchContainer.contains(e.target)) {
      hideSearchSuggestions();
    }
  });

  backToListBtn.addEventListener("click", () => {
    hideMessageDetail(true);
  });

  refreshBtn.addEventListener("click", () => {
    fetchStatus();
    fetchAgents();
    fetchData();
  });

  // Toggle bridge daemon
  bridgeStatusPill.addEventListener("click", async () => {
    try {
      await fetch("/api/bridge/toggle", { method: "POST" });
      fetchStatus();
    } catch {}
  });

  // Smart Replies
  smartRepliesChipsEl.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    quickReplyTextEl.value = chip.dataset.text;
    quickReplyTextEl.focus();
  });

  // Send Quick Reply
  sendQuickReplyBtn.addEventListener("click", async () => {
    const text = quickReplyTextEl.value.trim();
    if (!text || !state.selectedMessageId) return;

    sendQuickReplyBtn.disabled = true;
    sendQuickReplyBtn.textContent = "Sending...";

    try {
      const currentPersona = getActiveSender();
      const res = await fetch("/api/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: currentPersona,
          replyToId: state.selectedMessageId,
          body: text,
        }),
      });

      const data = await res.json();
      if (data.ok) {
        quickReplyTextEl.value = "";
        fetchData();
      } else {
        alert("Error sending reply: " + (data.error || "unknown"));
      }
    } catch (e) {
      alert("Error: " + e.message);
    } finally {
      sendQuickReplyBtn.disabled = false;
      sendQuickReplyBtn.innerHTML = `
        <svg viewBox="0 0 24 24"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        <span>Send Reply (amq)</span>
      `;
    }
  });

  // ─── Compose Modal ─────────────────────────────────────────────────────────

  function populateComposeDropdowns(agents) {
    let fromOptions = `<option value="user">user (Human operator)</option>`;
    let toOptions = `<option value="coordinator">coordinator</option>`;

    for (const a of agents) {
      fromOptions += `<option value="${a.handle}">${a.handle}</option>`;
      if (a.handle !== "coordinator") {
        toOptions += `<option value="${a.handle}">${a.handle}</option>`;
      }
    }

    composeFromEl.innerHTML = fromOptions;
    composeToEl.innerHTML = toOptions;
  }

  openComposeBtn.addEventListener("click", () => {
    composeModalEl.classList.remove("hidden");
    const currentPersona = getActiveSender();
    composeFromEl.value = currentPersona;
    composeFromEl.disabled = state.activeAccount === "all";
    composeSubjectEl.focus();
  });

  if (composeTemplateEl) {
    composeTemplateEl.addEventListener("change", (e) => {
      const val = e.target.value;
      if (val === "task") {
        composeSubjectEl.value = "todo: [summary]";
        composeBodyEl.value = "Task request (reply needed / ack):\n\nContext:\n[Brief context]\n\nWhat needs to be done:\n- [Action item 1]\n- [Action item 2]\n";
        composeToEl.value = "coordinator";
      } else if (val === "verify") {
        composeSubjectEl.value = "verify-all: PASS";
        composeBodyEl.value = "Verification Report (5 parts):\n1. What was asked: \n2. What was done + files touched: \n3. Evidence (numbers, logs): `bash tools/verify-all.sh --quick`\n4. Blockers / dependencies: none\n5. Board status: updated in STATUS.md\n";
        composeToEl.value = "coordinator";
      } else if (val === "question") {
        composeSubjectEl.value = "question: [topic]";
        composeBodyEl.value = "Question:\n\nContext and alternatives evaluated:\n";
      } else if (val === "lock") {
        composeSubjectEl.value = "notice: godot lock coordination";
        composeBodyEl.value = "Lock notice:\nLane clear. Using tools/godot-lock.sh only.\npgrep check: clean.\n";
      }
    });
  }

  closeComposeBtn.addEventListener("click", () => {
    composeModalEl.classList.add("hidden");
  });

  composeFormEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const from = getActiveSender(composeFromEl.value);
    const to = composeToEl.value;
    const subject = composeSubjectEl.value;
    const thread = composeThreadEl.value;
    const body = composeBodyEl.value;

    const submitBtn = document.getElementById("compose-submit-btn");
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending...";

    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, subject, thread, body }),
      });
      const data = await res.json();

      if (data.ok) {
        composeModalEl.classList.add("hidden");
        composeSubjectEl.value = "";
        composeBodyEl.value = "";
        composeThreadEl.value = "";
        fetchData();
      } else {
        alert("Send failed: " + (data.error || "unknown"));
      }
    } catch (err) {
      alert("Error: " + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Send";
    }
  });

  // ─── Server-Sent Events (SSE) ───────────────────────────────────────────────

  function initSSE() {
    try {
      const evtSource = new EventSource("/api/events");
      evtSource.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          if (payload.type === "mail_update" || payload.type === "presence_update") {
            fetchStatus();
            fetchAgents();
             fetchData();
             if (state.currentView === "panes") fetchPanes();
             if (state.selectedTaskId) {
              const currentTask = findTaskById(state.selectedTaskId);
              if (currentTask) renderSheetTransmissions(currentTask);
            }
          } else if (payload.type === "board_update") {
            fetchBoard().then(() => {
              if (state.selectedTaskId) {
                const currentTask = findTaskById(state.selectedTaskId);
                if (currentTask) {
                  renderSheetTransmissions(currentTask);
                  if (sheetStageButtons) {
                    sheetStageButtons.querySelectorAll(".sheet-stage-btn").forEach((btn) => {
                      btn.classList.toggle("active", btn.dataset.stage === currentTask.status);
                    });
                  }
                }
              }
            });
          } else if (payload.type === "herdr_agents_refresh") {
            fetchAgents();
          } else if (payload.type === "herdr_agent_update") {
            const { handle, herdrStatus, stateLabels, title, at } = payload;
            const agent = state.agents.find((item) => item.handle === handle);
            if (agent && herdrStatus) {
              agent.status = herdrStatus !== "unknown" ? herdrStatus : agent.status;
              agent.herdrStatus = herdrStatus;
              agent.herdrObservedAt = at || agent.herdrObservedAt;
              if (agent.herdrActivity) {
                agent.herdrActivity.status = herdrStatus;
                agent.herdrActivity.observedAt = at || agent.herdrActivity.observedAt;
                if (stateLabels) agent.herdrActivity.stateLabels = stateLabels;
                if (title) agent.herdrActivity.title = title;
              }
               renderPresenceList(state.agents);
               if (state.currentView === "panes") {
                 renderPaneCards();
                 fetchBoard();
               }
               if (agentActivityDialog?.dataset.agentHandle === handle) renderAgentActivity();
            }
          }
        } catch {}
      };
      evtSource.onerror = () => {
        setTimeout(initSSE, 5000);
      };
    } catch {}
  }


  // ─── Global Window Helpers for Lightbox & Code Copy ─────────────────────────

  window.openImageLightbox = function (url, filename) {
    lightboxImg.src = url;
    lightboxTitle.textContent = filename || "Image Preview";
    lightboxDownloadLink.href = url;
    lightboxModal.classList.remove("hidden");
  };

  window.closeLightbox = function () {
    lightboxModal.classList.add("hidden");
    lightboxImg.src = "";
  };

  lightboxCloseBtn.addEventListener("click", window.closeLightbox);
  lightboxBackdrop.addEventListener("click", window.closeLightbox);

  window.copyCode = function (btn) {
    const pre = btn.closest(".code-block-wrapper").querySelector("pre code");
    if (!pre) return;
    navigator.clipboard.writeText(pre.innerText).then(() => {
      const original = btn.textContent;
      btn.textContent = "Copied!";
      btn.style.color = "#81c995";
      setTimeout(() => {
        btn.textContent = original;
        btn.style.color = "";
      }, 1500);
    });
  };

  // ─── Utilities ─────────────────────────────────────────────────────────────

  function formatTimestamp(isoStr) {
    if (!isoStr) return "";
    const d = new Date(isoStr);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function showToast(msg) {
    const toast = document.createElement("div");
    toast.className = "agmail-toast";
    toast.textContent = msg;
    toast.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#202124;color:#fff;padding:10px 20px;border-radius:20px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.25);z-index:100000;transition:opacity 0.25s ease;";
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 260);
    }, 2500);
  }

  function findMessageById(id) {
    if (!id) return null;
    if (state.viewMode === "flat") {
      return state.items.find((m) => m.id === id);
    }
    for (const thread of state.items) {
      if (thread.messages) {
        const found = thread.messages.find((m) => m.id === id);
        if (found) return found;
      }
    }
    return null;
  }

  // ─── Pagination Controls Setup ──────────────────────────────────────────────

  function setupPagination() {
    if (prevPageBtn) {
      prevPageBtn.addEventListener("click", () => {
        if (state.page > 1) {
          state.page--;
          fetchData();
        }
      });
    }
    if (nextPageBtn) {
      nextPageBtn.addEventListener("click", () => {
        if (state.page < state.totalPages) {
          state.page++;
          fetchData();
        }
      });
    }
  }

  // ─── Right-Click Context Menu Setup ─────────────────────────────────────────

  function setupContextMenu() {
    if (!chatContextMenu) return;

    document.addEventListener("contextmenu", (e) => {
      const targetCard = e.target.closest(".thread-card, .mail-row");
      const targetPresence = e.target.closest(".presence-item");
      const inAppMain = e.target.closest(".app-main, .mail-detail-container, .mail-list-container, .app-sidebar");

      if (!targetCard && !targetPresence && !inAppMain) {
        chatContextMenu.classList.add("hidden");
        return;
      }

      e.preventDefault();

      const sel = window.getSelection();
      const selectedText = sel ? sel.toString().trim() : "";

      let targetMsgId = targetCard?.dataset?.msgId || state.selectedMessageId;
      let targetMsgFrom = targetCard?.dataset?.msgFrom;
      let targetHandle = targetPresence?.querySelector(".presence-name")?.textContent?.trim();

      if (targetCard && targetMsgId) {
        const found = findMessageById(targetMsgId);
        if (found) {
          targetMsgFrom = found.from;
        }
      }

      const activeAuthor = targetMsgFrom || targetHandle;

      state.contextTarget = {
        msgId: targetMsgId,
        msgFrom: activeAuthor,
        handle: targetHandle,
        selectedText,
      };

      if (targetPresence && targetHandle) {
        // Context: Specific Agent in Presence list
        ctxHeaderTitle.textContent = "Agent Swarm";
        ctxHeaderSub.textContent = `@${targetHandle}`;

        ctxReply.style.display = "flex";
        ctxReplyText.textContent = `Message @${targetHandle}`;

        ctxQuote.style.display = "none";

        ctxFilterSender.style.display = "flex";
        ctxFilterSenderText.textContent = `Filter messages from:${targetHandle}`;

        ctxCopyId.style.display = "flex";
        ctxCopyIdText.textContent = `Copy address (${targetHandle}@amq)`;

        ctxRegisterAgent.style.display = "flex";
        ctxRegisterText.textContent = `Configure profile for @${targetHandle}...`;
      } else if (targetCard && targetMsgId) {
        // Context: Specific Message Card or Mail Row
        ctxHeaderTitle.textContent = "Transmission";
        ctxHeaderSub.textContent = activeAuthor ? `@${activeAuthor} • ${targetMsgId}` : targetMsgId;

        ctxReply.style.display = "flex";
        ctxReplyText.textContent = activeAuthor ? `Reply to @${activeAuthor}` : "Reply to transmission";

        ctxQuote.style.display = (selectedText || targetMsgId) ? "flex" : "none";
        ctxQuoteText.textContent = selectedText
          ? `Quote: "${selectedText.slice(0, 24)}..."`
          : "Quote message in reply";

        ctxFilterSender.style.display = activeAuthor ? "flex" : "none";
        ctxFilterSenderText.textContent = `View all from @${activeAuthor}`;

        ctxCopyId.style.display = "flex";
        ctxCopyIdText.textContent = `Copy message ID (${targetMsgId})`;

        ctxRegisterAgent.style.display = "flex";
        ctxRegisterText.textContent = activeAuthor
          ? `Configure profile for @${activeAuthor}...`
          : "Register new agent profile...";
      } else {
        // Context: General Swarm Workspace
        ctxHeaderTitle.textContent = "AGmail Swarm";
        ctxHeaderSub.textContent = `Account: ${state.activeAccount} (${state.total} items)`;

        ctxReply.style.display = "flex";
        ctxReplyText.textContent = "Compose new transmission";

        ctxQuote.style.display = "none";
        ctxFilterSender.style.display = "none";
        ctxCopyId.style.display = "none";

        ctxRegisterAgent.style.display = "flex";
        ctxRegisterText.textContent = "Register new agent profile...";
      }

      const menuWidth = 240;
      const menuHeight = 220;
      let x = e.clientX;
      let y = e.clientY;
      if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 8;
      if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 8;

      chatContextMenu.style.left = `${Math.max(4, x)}px`;
      chatContextMenu.style.top = `${Math.max(4, y)}px`;
      chatContextMenu.classList.remove("hidden");
    });

    document.addEventListener("click", (e) => {
      if (!chatContextMenu.contains(e.target)) {
        chatContextMenu.classList.add("hidden");
      }
    });

    if (ctxReply) {
      ctxReply.addEventListener("click", () => {
        chatContextMenu.classList.add("hidden");
        const author = state.contextTarget?.msgFrom || state.contextTarget?.handle;
        if (state.contextTarget?.msgId && !mailDetailViewEl.classList.contains("hidden")) {
          state.selectedMessageId = state.contextTarget.msgId;
          quickReplyTextEl.focus();
          if (author && !quickReplyTextEl.value) {
            quickReplyTextEl.value = `@${author} `;
          }
        } else {
          // Open compose dialog pre-addressed to author
          composeModalEl.classList.remove("hidden");
          if (author && composeToEl) {
            composeToEl.value = author;
          }
          composeSubjectEl.focus();
        }
      });
    }

    if (ctxQuote) {
      ctxQuote.addEventListener("click", () => {
        chatContextMenu.classList.add("hidden");
        quickReplyTextEl.focus();
        const quoteText = state.contextTarget?.selectedText || "";
        if (quoteText) {
          const quoted = quoteText.split("\n").map((l) => `> ${l}`).join("\n");
          quickReplyTextEl.value = `${quoted}\n\n${quickReplyTextEl.value}`;
        } else if (state.contextTarget?.msgId) {
          const msg = findMessageById(state.contextTarget.msgId);
          if (msg?.body) {
            const snippet = msg.body.slice(0, 200).split("\n").map((l) => `> ${l}`).join("\n");
            quickReplyTextEl.value = `${snippet}\n\n${quickReplyTextEl.value}`;
          }
        }
      });
    }

    if (ctxFilterSender) {
      ctxFilterSender.addEventListener("click", () => {
        chatContextMenu.classList.add("hidden");
        const author = state.contextTarget?.msgFrom || state.contextTarget?.handle;
        if (author) {
          searchInputEl.value = `from:${author} `;
          state.searchQuery = `from:${author}`;
          state.page = 1;
          fetchData();
        }
      });
    }

    if (ctxCopyId) {
      ctxCopyId.addEventListener("click", () => {
        chatContextMenu.classList.add("hidden");
        const toCopy = state.contextTarget?.msgId || (state.contextTarget?.handle ? `${state.contextTarget.handle}@amq` : "");
        if (toCopy) {
          navigator.clipboard.writeText(toCopy).then(() => {
            showToast(`Copied: ${toCopy}`);
          }).catch(() => {});
        }
      });
    }

    if (ctxRegisterAgent) {
      ctxRegisterAgent.addEventListener("click", () => {
        chatContextMenu.classList.add("hidden");
        const author = state.contextTarget?.msgFrom || state.contextTarget?.handle;
        openRegisterAgentModal(author);
      });
    }
  }

  // ─── Agent Briefs & Profile Configuration ───────────────────────────────────

  async function fetchBriefs() {
    try {
      const res = await fetch("/api/agent-briefs");
      if (res.ok) {
        state.briefs = await res.json();
        renderBriefChips();
      }
    } catch {}
  }

  function renderBriefChips() {
    if (!briefChipsList) return;
    if (!state.briefs || state.briefs.length === 0) {
      briefChipsList.innerHTML = '<span class="brief-chips-loading">No brief files found in .opencode/agents, .agents, .pi</span>';
      return;
    }
    let html = "";
    for (const b of state.briefs) {
      html += `<button type="button" class="brief-chip" data-handle="${escapeHtml(b.handle)}" title="${escapeHtml(b.role || b.description || b.handle)}">${escapeHtml(b.handle)}</button>`;
    }
    briefChipsList.innerHTML = html;

    briefChipsList.querySelectorAll(".brief-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const handle = btn.dataset.handle;
        if (handle) {
          applyBriefByHandle(handle);
        }
      });
    });
  }

  async function applyBriefByHandle(handle) {
    if (!handle) return;
    const cleanHandle = handle.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    newAgentHandleInput.value = cleanHandle;

    // Check in-memory briefs first
    let brief = state.briefs?.find((b) => b.handle === cleanHandle);
    if (!brief) {
      try {
        const res = await fetch(`/api/agent-briefs?handle=${encodeURIComponent(cleanHandle)}`);
        if (res.ok) {
          const data = await res.json();
          brief = data.brief;
        }
      } catch {}
    }

    if (brief) {
      if (newAgentNameInput) {
        newAgentNameInput.value = brief.name || formatAgentTitle(cleanHandle);
      }
      if (newAgentRoleInput) {
        newAgentRoleInput.value = brief.role || brief.description || "";
      }
      if (newAgentModelInput && brief.model) {
        newAgentModelInput.value = brief.model;
      }
      if (newAgentPromptInput) {
        newAgentPromptInput.value = brief.prompt || "";
      }
      if (briefSourceBadge) {
        briefSourceBadge.textContent = brief.source ? `📄 ${brief.source}` : "📄 disk brief";
        briefSourceBadge.style.display = "inline-block";
      }
      showToast(`Pulled brief for @${cleanHandle}`);
    } else {
      // Check existing agent profile in state.agents
      const existing = state.agents.find((a) => a.handle === cleanHandle);
      if (existing?.profile) {
        if (newAgentNameInput) newAgentNameInput.value = existing.profile.name || "";
        if (newAgentRoleInput) newAgentRoleInput.value = existing.profile.role || "";
        if (newAgentModelInput) newAgentModelInput.value = existing.profile.model || "";
        if (newAgentPromptInput) newAgentPromptInput.value = existing.profile.prompt || "";
        if (briefSourceBadge) {
          briefSourceBadge.textContent = existing.profile.briefSource ? `📄 ${existing.profile.briefSource}` : "Saved profile";
          briefSourceBadge.style.display = "inline-block";
        }
      } else {
        if (briefSourceBadge) briefSourceBadge.style.display = "none";
      }
    }
  }

  function openRegisterAgentModal(prefillHandle) {
    if (!registerAgentBackdrop) return;
    registerAgentForm.reset();
    if (briefSourceBadge) {
      briefSourceBadge.style.display = "none";
      briefSourceBadge.textContent = "";
    }

    if (prefillHandle && typeof prefillHandle === "string") {
      if (agentModalTitle) agentModalTitle.textContent = `Configure Profile: @${prefillHandle}`;
      newAgentHandleInput.value = prefillHandle;
      applyBriefByHandle(prefillHandle);
    } else {
      if (agentModalTitle) agentModalTitle.textContent = "Configure Agent Profile";
    }

    fetchBriefs();
    registerAgentBackdrop.classList.remove("hidden");
    if (!prefillHandle) {
      newAgentHandleInput.focus();
    }
  }

  function closeRegisterAgentModal() {
    if (registerAgentBackdrop) registerAgentBackdrop.classList.add("hidden");
  }

  function setupRegisterAgentModal() {
    if (openRegisterAgentBtn) {
      openRegisterAgentBtn.addEventListener("click", () => openRegisterAgentModal());
    }
    if (closeRegisterAgentBtn) {
      closeRegisterAgentBtn.addEventListener("click", closeRegisterAgentModal);
    }
    if (cancelRegisterAgentBtn) {
      cancelRegisterAgentBtn.addEventListener("click", closeRegisterAgentModal);
    }

    if (pullDiskBriefBtn) {
      pullDiskBriefBtn.addEventListener("click", () => {
        const handle = newAgentHandleInput.value.trim();
        if (handle) {
          applyBriefByHandle(handle);
        } else {
          showToast("Enter an agent handle first");
        }
      });
    }

    let handleDebounce;
    if (newAgentHandleInput) {
      newAgentHandleInput.addEventListener("input", () => {
        clearTimeout(handleDebounce);
        handleDebounce = setTimeout(() => {
          const val = newAgentHandleInput.value.trim().toLowerCase();
          const match = state.briefs?.find((b) => b.handle === val);
          if (match) {
            applyBriefByHandle(val);
          }
        }, 400);
      });
    }

    if (registerAgentForm) {
      registerAgentForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const handle = newAgentHandleInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
        if (!handle) return;

        const payload = {
          handle,
          name: newAgentNameInput.value.trim() || undefined,
          role: newAgentRoleInput.value.trim() || undefined,
          model: (newAgentModelInput?.value || "").trim() || null,
          prompt: newAgentPromptInput ? newAgentPromptInput.value.trim() || undefined : undefined,
        };

        try {
          const res = await fetch("/api/agents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (data.ok) {
            closeRegisterAgentModal();
            await fetchAgents();
            await fetchBriefs();
            showToast(`Agent @${handle} saved successfully!`);
          } else {
            alert(`Failed to save agent: ${data.error || "Unknown error"}`);
          }
        } catch (err) {
          alert(`Error: ${err.message}`);
        }
      });
    }
  }

  // ─── Swarm Coordination Kanban Board ───────────────────────────────────────

  async function fetchBoard() {
    try {
      const res = await fetch("/api/board");
      const data = await res.json();
      if (data.ok) {
         state.board = data;
         if (agentActivityDialog?.open) renderAgentActivity();
         renderCoordinatorMetrics();
         if (state.currentView === "panes") renderPaneCards();
        if (boardTotalCountEl) {
          boardTotalCountEl.textContent = data.stats?.total || 0;
        }
        if (state.currentView === "board") {
          renderBoard();
        }
        if (taskModalBackdrop && !taskModalBackdrop.classList.contains("hidden")) {
          renderTaskOwnerTip();
        }
      }
    } catch (err) {
      console.warn("[board] Failed to fetch board:", err.message);
    }
  }

  function switchView(viewName) {
    state.currentView = viewName;

    navViewMail?.classList.toggle("active", viewName === "mail");
    navViewBoard?.classList.toggle("active", viewName === "board");
    navViewPanes?.classList.toggle("active", viewName === "panes");
    navViewMetrics?.classList.toggle("active", viewName === "metrics");
    mailViewSection?.classList.toggle("hidden", viewName !== "mail");
    boardViewSection?.classList.toggle("hidden", viewName !== "board");
    panesViewSection?.classList.toggle("hidden", viewName !== "panes");
    metricsViewSection?.classList.toggle("hidden", viewName !== "metrics");
    if (viewName === "board" || viewName === "metrics") {
      fetchBoard();
    } else if (viewName === "panes") {
      fetchBoard();
      fetchPanes();
    }  }

  function formatMetricDuration(ms) {
    if (ms === null || ms === undefined) return "—";
    const seconds = Math.max(0, Math.round(Number(ms) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  }

  function renderCoordinatorMetrics() {
    if (!coordinatorMetricsGrid || !coordinatorAlerts) return;
    const metrics = state.board?.coordinator;
    if (!metrics) {
      coordinatorMetricsGrid.innerHTML = `<div class="kanban-empty">Coordinator metrics are unavailable.</div>`;
      coordinatorAlerts.innerHTML = "";
      return;
    }
    const byStatus = metrics.agents?.byStatus || {};
    const stages = metrics.cards?.byStage || {};
    const cards = [
      ["Working agents", byStatus.working ?? 0],
      ["Blocked agents", byStatus.blocked ?? 0],
      ["Stopped agents", byStatus.stopped ?? 0],
      ["Idle agents", byStatus.idle ?? 0],
      ["Backlog cards", stages.backlog ?? 0],
      ["Doing cards", stages.doing ?? 0],
      ["Review cards", stages.review ?? 0],
      ["Blocked cards", stages.blocked ?? 0],
      ["Oldest queue", formatMetricDuration(metrics.queue?.oldestAgeMs)],
      ["Retries", metrics.retries?.count ?? 0],
    ];
    coordinatorMetricsGrid.innerHTML = cards.map(([label, value]) =>
      `<div class="coordinator-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`
    ).join("");
    const alerts = Array.isArray(metrics.alerts) ? metrics.alerts : [];
    coordinatorAlerts.innerHTML = alerts.length
      ? alerts.map((alert) => `<div class="coordinator-alert severity-${escapeHtml(alert.severity || "warning")}"><strong>${escapeHtml(alert.id)}</strong><span>${escapeHtml(alert.message)}</span><small>Next: ${escapeHtml(alert.recommendedAction || "Inspect coordinator dashboard.")}</small></div>`).join("")
      : `<div class="coordinator-alert coordinator-alert-clear"><strong>Clear</strong><span>No current threshold alerts.</span></div>`;
    if (coordinatorMetricsUpdated) coordinatorMetricsUpdated.textContent = `Updated ${new Date(metrics.generatedAt || Date.now()).toLocaleTimeString()}`;
  }

  // Terminal-style autofit: measure the longest line and shrink the
  // monospace type so it fits without wrapping (real terminals never wrap;
  // they scroll). Falls back to horizontal scroll for extreme cases.
  const paneMeasureCtx = document.createElement("canvas").getContext("2d");
  function fitPaneOutput(el) {
    if (!el || !el.isConnected) return;
    const text = el.textContent || "";
    const longest = text.split("\n").reduce((m, l) => Math.max(m, l.length), 0) || 1;
    const style = getComputedStyle(el);
    const avail = Math.max(50, el.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0"));
    let size = parseFloat(style.fontSize) || 11.5;
    paneMeasureCtx.font = `${size}px ${style.fontFamily}`;
    const ratio = paneMeasureCtx.measureText("0".repeat(100)).width / 100 / size;
    size = Math.min(11.5, Math.max(7, avail / (longest * (ratio || 0.6))));
    el.style.fontSize = `${size.toFixed(2)}px`;
  }
  function fitVisiblePaneOutputs() {
    document.querySelectorAll(".pane-card-output, .agent-pane-output").forEach(fitPaneOutput);
  }
  let paneFitTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(paneFitTimer);
    paneFitTimer = setTimeout(fitVisiblePaneOutputs, 150);
  });

  // ─── Panes View: live terminal tails ──────────────────────────────────────
  let panesFetchGen = 0;
  async function fetchPanes() {
    if (!panesGridEl) return;
    const myGen = ++panesFetchGen;
    const focus = state.panesFocus || "";
    const lines = state.panesLines || 40;
    const firstPaint = !panesGridEl.querySelector(".pane-card");
    if (firstPaint) {
      panesGridEl.innerHTML = `<div class="kanban-empty">Reading live pane tails…</div>`;
    }
    if (refreshPanesBtn) refreshPanesBtn.disabled = true;
    try {
      const params = new URLSearchParams({ lines: String(lines) });
      if (focus) params.set("handle", focus);
      const res = await fetch(`/api/panes?${params.toString()}`);
      const panes = await res.json();
      if (myGen !== panesFetchGen || state.currentView !== "panes") return;
      state.lastPanes = Array.isArray(panes) ? panes : [];
      renderPaneCards();
      if (panesUpdatedAtEl) panesUpdatedAtEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
      fetchPaneReports();
    } catch {
      if (myGen !== panesFetchGen) return;
      panesGridEl.innerHTML = `<div class="kanban-empty">Unable to read pane tails.</div>`;
    } finally {
      if (refreshPanesBtn) refreshPanesBtn.disabled = false;
    }
  }

  // Single-lane focus: sidebar click opens Panes showing only that agent,
  // fullscreen-width, with its parsed status header.
  function openPanesFocus(handle) {
    state.panesFocus = handle || null;
    if (window.innerWidth <= 768) {
      document.body.classList.remove("sidebar-open");
      sidebarBackdrop?.classList.add("hidden");
    }
    switchView("panes");
  }
  function renderPanesFocusBanner() {
    const focus = state.panesFocus || "";
    panesFocusBanner?.classList.toggle("hidden", !focus);
    if (panesFocusName) panesFocusName.textContent = focus;
    panesGridEl?.classList.toggle("panes-focus", Boolean(focus));
  }

  // Unified lane card: live status + assigned task + latest AMQ report +
  // live terminal tail. This is the single "what agents are doing" screen.
  function renderPaneCards() {
    if (!panesGridEl) return;
    renderPanesFocusBanner();
    const list = Array.isArray(state.lastPanes) ? state.lastPanes : [];
    if (!list.length) {
      panesGridEl.innerHTML = `<div class="kanban-empty">No registered lanes.</div>`;
      return;
    }    panesGridEl.innerHTML = list
      .map((p) => {
        const agent = state.agents.find((a) => a.handle === p.handle);
        const statusView = agentStatusView(agent || { handle: p.handle, status: "offline" });
        const task = getAgentTask(p.handle);
        const activity = agent ? agentActivityText(agent, task) : "No live activity signal";
        const message = latestHangoutMessage({ handle: p.handle });
        const messageText = message ? message.snippet || message.body || "No report text" : "No AMQ report yet";
        return `
        <article class="pane-card" data-pane-handle="${escapeHtml(p.handle)}">
          <div class="pane-card-header">
            <strong class="pane-card-name">${escapeHtml(p.handle)}</strong>
            <span class="presence-status-pill ${statusView.tone}"${statusView.stale ? ' data-stale="true"' : ""}>${statusView.label}</span>
            <span class="pane-card-time">${escapeHtml(hangoutTimestamp(p.at))}</span>
          </div>
          <div class="pane-card-sub"><span class="hangout-card-label">Activity</span><strong>${escapeHtml(activity)}</strong></div>
          <div class="pane-card-sub"><span class="hangout-card-label">Task</span><span>${escapeHtml(task ? task.title : "No active task assigned")}</span></div>
          <div class="pane-card-sub"><span class="hangout-card-label">Latest report</span><span class="hangout-message">${escapeHtml(messageText)}</span></div>
              <pre class="pane-card-output">${p.ok ? escapeHtml(p.output || "(empty)") : "Pane unavailable (Herdr not connected)."}</pre>
          <div class="pane-card-actions">
            <button type="button" class="btn btn-secondary" data-pane-action="activity" data-pane-handle="${escapeHtml(p.handle)}">Activity</button>
            <button type="button" class="btn btn-primary" data-pane-action="message" data-pane-handle="${escapeHtml(p.handle)}">Message</button>
          </div>
        </article>`;
      })
      .join("");
    panesGridEl.querySelectorAll("[data-pane-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const agent = state.agents.find((item) => item.handle === button.dataset.paneHandle);
        if (!agent) return;
        if (button.dataset.paneAction === "activity") {
          openAgentActivity(agent.handle);
        } else {
          openComposeForAgent(agent);
        }
      });
    });
    requestAnimationFrame(fitVisiblePaneOutputs);
  }

  function renderBoard() {
    if (!state.board || !state.board.columns) return;
    const { columns, stats, owners } = state.board;

    // Update Stats Pills
    if (statTotalEl) statTotalEl.textContent = stats.total || 0;
    if (statProgressEl) statProgressEl.textContent = stats.in_progress || 0;
    if (statBlockedEl) statBlockedEl.textContent = stats.blocked || 0;
    if (statDoneEl) statDoneEl.textContent = stats.done || 0;

    if (colCountBacklog) colCountBacklog.textContent = columns.backlog.length;
    if (colCountInProgress) colCountInProgress.textContent = columns.in_progress.length;
    if (colCountBlocked) colCountBlocked.textContent = columns.blocked.length;
    if (colCountDone) colCountDone.textContent = columns.done.length;

    // Render Agent Filter Chips
    if (boardAgentFilterBar) {
      const filterOwners = ["all", ...(owners || [])];
      let chipsHtml = "";
      for (const o of filterOwners) {
        const isActive = state.boardFilterAgent === o;
        const agentObj = state.agents.find((a) => a.handle === o);
        const name = o === "all" ? "All Agents" : (agentObj?.profile?.name || o);
        const emoji = o === "all" ? "👥" : (agentObj?.profile?.emoji || "🤖");
        chipsHtml += `
          <button class="board-filter-chip ${isActive ? "active" : ""}" data-agent="${escapeHtml(o)}">
            <span>${emoji}</span>
            <span>${escapeHtml(name)}</span>
          </button>
        `;
      }
      boardAgentFilterBar.innerHTML = chipsHtml;

      boardAgentFilterBar.querySelectorAll(".board-filter-chip").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.boardFilterAgent = btn.dataset.agent;
          renderBoard();
        });
      });
    }

    const query = (state.boardSearchQuery || "").toLowerCase();

    function filterCards(cardList) {
      return (cardList || []).filter((c) => {
        if (state.boardFilterAgent !== "all" && c.owner !== state.boardFilterAgent) {
          return false;
        }
        if (query) {
          const matchText = `${c.title} ${c.owner} ${c.description || ""}`.toLowerCase();
          if (!matchText.includes(query)) return false;
        }
        return true;
      });
    }

    const colContainers = {
      backlog: cardsBacklogEl,
      in_progress: cardsInProgressEl,
      blocked: cardsBlockedEl,
      done: cardsDoneEl,
    };

    const emptyMessages = {
      backlog: "No tasks in backlog",
      in_progress: "No tasks in flight",
      blocked: "No blocked items",
      done: "No completed tasks",
    };

    for (const [colName, containerEl] of Object.entries(colContainers)) {
      if (!containerEl) continue;
      const filtered = filterCards(columns[colName]);
      if (colName === "done") {
        // Newest-completed first. Cards only carry created/updated (updated
        // bumps on every stage move), so updated desc approximates
        // "date the card entered this column".
        filtered.sort((a, b) => (b.updated || b.created || "").localeCompare(a.updated || a.created || ""));
      }

      if (!filtered.length) {
        containerEl.innerHTML = `<div class="kanban-empty">${emptyMessages[colName]}</div>`;
        continue;
      }

      let cardsHtml = "";
      for (const card of filtered) {
        const agentObj = state.agents.find((a) => a.handle === card.owner);
        const prof = agentObj?.profile || {
          name: card.owner,
          emoji: (card.owner || "?").slice(0, 1).toUpperCase(),
          color: "#1a73e8",
        };

        const isEmVoo = card.source === "status_em_voo";
        const isCustom = card.source === "custom";
        const sourceBadge = isEmVoo
          ? `<span class="kanban-source-badge badge-em-voo">Em Voo</span>`
          : isCustom
          ? `<span class="kanban-source-badge">Custom</span>`
          : "";

        // Navigation move buttons
        let actionsHtml = "";
        if (colName === "backlog") {
          actionsHtml += `<button class="kanban-move-btn" data-move-id="${card.id}" data-target-col="in_progress" title="Move to Em Voo">Start ➡️</button>`;
        } else if (colName === "in_progress") {
          actionsHtml += `<button class="kanban-move-btn" data-move-id="${card.id}" data-target-col="backlog" title="Back to backlog">⬅️</button>`;
          actionsHtml += `<button class="kanban-move-btn" data-move-id="${card.id}" data-target-col="blocked" title="Mark Blocked">🛑</button>`;
          actionsHtml += `<button class="kanban-move-btn" data-move-id="${card.id}" data-target-col="done" title="Mark Done">✅</button>`;
        } else if (colName === "blocked") {
          actionsHtml += `<button class="kanban-move-btn" data-move-id="${card.id}" data-target-col="in_progress" title="Unblock: resume work in Em Voo">🚀 Resume</button>`;
          actionsHtml += `<button class="kanban-move-btn" data-move-id="${card.id}" data-target-col="done" title="Mark Done: close with proof">✅ Done</button>`;
        } else if (colName === "done") {
          actionsHtml += `<button class="kanban-move-btn" data-move-id="${card.id}" data-target-col="in_progress" title="Reopen to Em Voo">↩️</button>`;
        }

        if (isCustom) {
          actionsHtml += `<button class="kanban-move-btn" data-delete-id="${card.id}" title="Delete custom task">🗑️</button>`;
        }

        cardsHtml += `
          <div class="kanban-card" id="kcard-${escapeHtml(card.id)}" data-task-id="${escapeHtml(card.id)}" data-col="${colName}" draggable="true">
            <div class="kanban-card-header">
              <div class="kanban-card-title">${escapeHtml(card.title)}</div>
              ${sourceBadge}
            </div>
            ${card.description ? `<div class="kanban-card-desc">${escapeHtml(card.description)}</div>` : ""}
            <div class="kanban-card-footer">
              <div class="kanban-owner-badge" title="Owner: ${escapeHtml(card.owner)}">
                <div class="kanban-owner-avatar" style="background:${prof.color};">${prof.emoji}</div>
                <span>${escapeHtml(prof.name)}</span>
              </div>
              <div class="kanban-card-actions">
                ${actionsHtml}
              </div>
            </div>
          </div>
        `;
      }

      containerEl.innerHTML = cardsHtml;
    }

    attachKanbanListeners();
  }

  function attachKanbanListeners() {
    // 1. Action move buttons
    document.querySelectorAll(".kanban-move-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const deleteId = btn.dataset.deleteId;
        if (deleteId) {
          if (confirm("Delete this custom task?")) {
            deleteTaskCard(deleteId);
          }
          return;
        }

        const taskId = btn.dataset.moveId;
        const targetCol = btn.dataset.targetCol;
        if (taskId && targetCol) {
          moveTaskCard(taskId, targetCol);
        }
      });
    });

    // 2. Drag and drop + card click opening for Task Sheet
    let isDragging = false;
    document.querySelectorAll(".kanban-card").forEach((card) => {
      card.addEventListener("dragstart", (e) => {
        isDragging = true;
        const taskId = card.dataset.taskId;
        e.dataTransfer.setData("text/plain", taskId);
        e.dataTransfer.effectAllowed = "move";
        card.classList.add("is-dragging");
      });

      card.addEventListener("dragend", () => {
        card.classList.remove("is-dragging");
        setTimeout(() => {
          isDragging = false;
        }, 80);
      });

      // Click card to open Ficha (Task Sheet)
      card.addEventListener("click", (e) => {
        if (isDragging) return;
        if (e.target.closest(".kanban-move-btn")) return;
        const taskId = card.dataset.taskId;
        if (taskId) {
          openTaskSheet(taskId);
        }
      });
    });

    // 3. Drop zones on each column list
    document.querySelectorAll(".kanban-cards-list").forEach((list) => {
      list.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        list.classList.add("drag-over");
      });

      list.addEventListener("dragleave", () => {
        list.classList.remove("drag-over");
      });

      list.addEventListener("drop", (e) => {
        e.preventDefault();
        list.classList.remove("drag-over");
        const taskId = e.dataTransfer.getData("text/plain");
        const targetCol = list.dataset.col;
        if (taskId && targetCol) {
          moveTaskCard(taskId, targetCol);
        }
      });
    });
  }

  async function moveTaskCard(taskId, targetCol) {
    if (!state.board || !state.board.columns) return;

    // Optimistic local state update
    let movedTask = null;
    for (const [colName, list] of Object.entries(state.board.columns)) {
      const idx = list.findIndex((t) => t.id === taskId);
      if (idx >= 0) {
        movedTask = list.splice(idx, 1)[0];
        break;
      }
    }

    if (movedTask) {
      movedTask.status = targetCol;
      state.board.columns[targetCol].unshift(movedTask);
      renderBoard();
    }

    // Sync sheet stage button if sheet is open for this task
    if (state.selectedTaskId === taskId && sheetStageButtons) {
      sheetStageButtons.querySelectorAll(".sheet-stage-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.stage === targetCol);
      });
    }

    try {
      await fetch(`/api/board/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: targetCol,
          from: getActiveSender(),
          notify: true,
        }),
      });
      showToast(`Task moved to ${targetCol} (AMQ alert sent)`);
    } catch (err) {
      console.warn("[board] Move task failed:", err.message);
      fetchBoard();
    }
  }

  async function deleteTaskCard(taskId) {
    if (state.selectedTaskId === taskId) {
      closeTaskSheet();
    }
    try {
      await fetch(`/api/board/tasks/${encodeURIComponent(taskId)}`, {
        method: "DELETE",
      });
      fetchBoard();
    } catch (err) {
      alert("Delete failed: " + err.message);
    }
  }

  function renderTaskOwnerTip() {
    if (!taskOwnerTip || !taskOwnerSelect) return;
    const owner = taskOwnerSelect.value;
    if (!owner) {
      taskOwnerTip.hidden = true;
      taskOwnerTip.textContent = "";
      return;
    }
    const tasks = [...(state.board?.columns?.in_progress || []), ...(state.board?.columns?.blocked || [])]
      .filter((task) => task.owner === owner);
    const claimed = tasks.filter((task) => task.status === "in_progress");
    const blocked = tasks.filter((task) => task.status === "blocked");
    taskOwnerTip.hidden = false;
    taskOwnerTip.className = tasks.length ? "task-owner-tip warning" : "task-owner-tip";
    if (!tasks.length) {
      taskOwnerTip.textContent = `@${owner} has no claimed or blocked board tasks.`;
      return;
    }
    const titles = tasks.slice(0, 2).map((task) => task.title).join(" · ");
    taskOwnerTip.textContent = `Before assigning: @${owner} has ${claimed.length} claimed and ${blocked.length} blocked. Review: ${titles}`;
  }

  function openNewTaskModal() {
    if (!taskModalBackdrop) return;

    // Populate assigned agent options
    if (taskOwnerSelect) {
      let optionsHtml = "";
      const currentPersona = getActiveSender();
      const handles = state.agents.map((a) => a.handle);
      if (!handles.includes("coordinator")) handles.unshift("coordinator");
      if (!handles.includes("user")) handles.push("user");

      for (const h of handles) {
        const agentObj = state.agents.find((a) => a.handle === h);
        const name = h === "user" ? "Human operator" : agentObj?.profile?.name || h;
        const selected = h === currentPersona ? "selected" : "";
        optionsHtml += `<option value="${escapeHtml(h)}" ${selected}>@${escapeHtml(h)} (${escapeHtml(name)})</option>`;
      }
      taskOwnerSelect.innerHTML = optionsHtml;
    }

    if (taskTitleInput) taskTitleInput.value = "";
    if (taskDescInput) taskDescInput.value = "";
    if (taskStatusSelect) taskStatusSelect.value = "backlog";

    const notifyCheckbox = document.getElementById("task-notify-checkbox");
    if (notifyCheckbox) notifyCheckbox.checked = true;

    renderTaskOwnerTip();
    taskModalBackdrop.classList.remove("hidden");
    taskTitleInput?.focus();
  }

  function closeNewTaskModal() {
    taskModalBackdrop?.classList.add("hidden");
  }

  async function submitNewTask(e) {
    e.preventDefault();
    const title = taskTitleInput?.value.trim();
    if (!title) return;

    const notifyVal = document.getElementById("task-notify-checkbox")?.checked ?? true;
    const from = getActiveSender();
    const payload = {
      title,
      owner: taskOwnerSelect?.value || from,
      status: taskStatusSelect?.value || "backlog",
      description: taskDescInput?.value.trim() || "",
      notify: notifyVal && taskOwnerSelect?.value !== from,
      from,
    };

    try {
      const res = await fetch("/api/board/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) {
        closeNewTaskModal();
        await fetchBoard();
        const notifyMsg = payload.notify ? " & automail dispatched" : "";
        showToast(`Task "${title.slice(0, 30)}" created${notifyMsg}!`);
      } else {
        alert("Failed to create task: " + (data.error || "unknown"));
      }
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  // ─── Task Sheet (Ficha do Card) Logic ───────────────────────────────────────

  function findTaskById(taskId) {
    if (!state.board?.columns) return null;
    for (const list of Object.values(state.board.columns)) {
      const match = list.find((t) => t.id === taskId);
      if (match) return match;
    }
    return null;
  }

  async function fetchTaskTransmissions(task) {
    if (!task) return [];
    try {
      const res = await fetch(`/api/messages?account=all&folder=all&pageSize=100&query=${encodeURIComponent(task.id)}`);
      const data = await res.json();
      let msgs = Array.isArray(data) ? data : data?.items || [];

      const cleanTitle = (task.title || "").replace(/^\[em voo\]\s*/i, "").trim();
      if (cleanTitle.length >= 6) {
        try {
          const res2 = await fetch(`/api/messages?account=all&folder=all&pageSize=50&query=${encodeURIComponent(cleanTitle.slice(0, 25))}`);
          const data2 = await res2.json();
          const msgs2 = Array.isArray(data2) ? data2 : data2?.items || [];
          for (const m of msgs2) {
            if (!msgs.some((x) => x.id === m.id)) msgs.push(m);
          }
        } catch {}
      }

      const taskId = (task.id || "").toLowerCase();
      const taskThread = `agboard/${task.id}`.toLowerCase();
      const lowerTitle = cleanTitle.toLowerCase();

      const matched = msgs.filter((m) => {
        const mThread = (m.thread || "").toLowerCase();
        const mSubj = (m.subject || "").toLowerCase();
        const mBody = (m.body || "").toLowerCase();
        return (
          mThread === taskThread ||
          mThread === taskId ||
          mThread.endsWith(`/${taskId}`) ||
          mSubj.includes(taskId) ||
          mBody.includes(taskId) ||
          (lowerTitle.length >= 6 && (mSubj.includes(lowerTitle) || (mSubj.includes("[agboard]") && mSubj.includes(lowerTitle.slice(0, 15)))))
        );
      });

      matched.sort((a, b) => {
        const tA = a.created ? new Date(a.created).getTime() : 0;
        const tB = b.created ? new Date(b.created).getTime() : 0;
        return tA - tB;
      });

      return matched;
    } catch {
      return [];
    }
  }

  // Generation guard + silent background refresh for the task-drawer thread
  // list. Every SSE tick re-invokes this; without the guard the drawer
  // flashes "Carregando..." forever and racing fetches overwrite each other.
  let sheetThreadGen = 0;
  let sheetThreadTaskId = null;
  async function renderSheetTransmissions(task) {
    if (!task || !sheetThreadList) return;
    const myGen = ++sheetThreadGen;
    const firstPaint = sheetThreadTaskId !== task.id || !sheetThreadList.querySelector(".sheet-msg-card");
    sheetThreadTaskId = task.id;
    if (firstPaint) {
      sheetThreadList.innerHTML = `<div class="sheet-msg-empty"><span>Carregando transmissões...</span></div>`;
    }

    const msgs = await fetchTaskTransmissions(task);
    if (myGen !== sheetThreadGen || state.selectedTaskId !== task.id) return; // stale: a newer refresh won
    if (sheetThreadBadge) sheetThreadBadge.textContent = msgs.length;
    if (sheetTabBadge) sheetTabBadge.textContent = msgs.length;

    if (!msgs.length) {
      sheetThreadList.innerHTML = `
        <div class="sheet-msg-empty">
          <span>📬 Nenhuma transmissão registrada ainda nesta ficha.</span><br>
          <span style="font-size:11.5px;color:var(--text-muted);margin-top:4px;display:inline-block;">Use o campo abaixo para enviar a primeira ordem ou atualização diretamente pelo AMQ.</span>
        </div>
      `;
      return;
    }

    let html = "";
    msgs.forEach((m, idx) => {
      const isLatest = idx === msgs.length - 1;
      const agentObj = state.agents.find((x) => x.handle === m.from);
      const prof = agentObj?.profile || {
        name: m.from,
        emoji: (m.from || "?").slice(0, 1).toUpperCase(),
        color: "#1a73e8",
        role: "Persona",
      };
      const dateStr = m.created ? new Date(m.created).toLocaleString() : "";
      const toStr = Array.isArray(m.to) ? m.to.join(", ") : (m.to || "all");
      const renderedBody = renderMarkdown(m.body || "");
      const attachmentsHtml = renderAttachmentsSection(m.attachments);

      html += `
        <div class="sheet-msg-card ${isLatest ? "expanded" : "collapsed"}" data-msg-id="${escapeHtml(m.id)}">
          <div class="sheet-msg-header">
            <div class="sheet-msg-header-left">
              <div class="sheet-msg-avatar" style="background:${prof.color};">${prof.emoji}</div>
              <strong class="sheet-msg-author">${escapeHtml(prof.name)}</strong>
              <span class="sheet-msg-snippet">${escapeHtml(m.snippet || "")}</span>
            </div>
            <div class="sheet-msg-date">${dateStr}</div>
          </div>
          <div class="sheet-msg-body" style="display:${isLatest ? "block" : "none"};">
            <div style="font-size:11.5px;color:#5f6368;margin-bottom:8px;">
              <span>De: <strong>${escapeHtml(m.from || "")}</strong> (${escapeHtml(prof.role)}) &lt;${escapeHtml(m.from || "")}@amq&gt;</span> • 
              <span>Para: ${escapeHtml(toStr)}</span> • 
              <span>${dateStr}</span>
            </div>
            <div class="md-content">${renderedBody}</div>
            ${attachmentsHtml}
          </div>
        </div>
      `;
    });

    sheetThreadList.innerHTML = html;

    sheetThreadList.querySelectorAll(".sheet-msg-header").forEach((hdr) => {
      hdr.addEventListener("click", () => {
        const card = hdr.closest(".sheet-msg-card");
        const body = card.querySelector(".sheet-msg-body");
        if (body.style.display === "none") {
          body.style.display = "block";
          card.classList.remove("collapsed");
          card.classList.add("expanded");
        } else {
          body.style.display = "none";
          card.classList.remove("expanded");
          card.classList.add("collapsed");
        }
      });
    });
  }

  function openTaskSheet(taskId) {
    if (!taskId) return;
    const foundTask = findTaskById(taskId);
    if (!foundTask) return;

    state.selectedTaskId = taskId;

    // Header info
    if (sheetTaskId) sheetTaskId.textContent = `#${foundTask.id}`;
    if (sheetTaskSource) {
      const isEmVoo = foundTask.source === "status_em_voo";
      const isCustom = foundTask.source === "custom";
      sheetTaskSource.textContent = isEmVoo ? "Em Voo (STATUS.md)" : isCustom ? "Custom AMQ" : "STATUS.md";
      sheetTaskSource.className = `kanban-source-badge ${isEmVoo ? "badge-em-voo" : ""}`;
    }
    if (sheetTaskTitle) sheetTaskTitle.textContent = foundTask.title;

    // Stage buttons
    if (sheetStageButtons) {
      sheetStageButtons.querySelectorAll(".sheet-stage-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.stage === foundTask.status);
      });
    }

    // Populate Owner Select & Avatar
    if (sheetOwnerSelect) {
      let ownerOptions = "";
      const handles = state.agents.map((a) => a.handle);
      if (!handles.includes("coordinator")) handles.unshift("coordinator");

      for (const h of handles) {
        const agentObj = state.agents.find((a) => a.handle === h);
        const name = agentObj?.profile?.name || h;
        const sel = h === foundTask.owner ? "selected" : "";
        optionsHtml = `<option value="${escapeHtml(h)}" ${sel}>@${escapeHtml(h)} (${escapeHtml(name)})</option>`;
        ownerOptions += optionsHtml;
      }
      sheetOwnerSelect.innerHTML = ownerOptions;
      sheetOwnerSelect.value = foundTask.owner || "coordinator";
    }

    if (sheetOwnerAvatar) {
      const currentOwnerObj = state.agents.find((a) => a.handle === foundTask.owner);
      const prof = currentOwnerObj?.profile || {
        name: foundTask.owner,
        emoji: (foundTask.owner || "?").slice(0, 1).toUpperCase(),
        color: "#1a73e8",
      };
      sheetOwnerAvatar.textContent = prof.emoji;
      sheetOwnerAvatar.style.backgroundColor = prof.color;
    }

    // Thread ID
    const threadKey = `agboard/${foundTask.id}`;
    if (sheetThreadId) sheetThreadId.textContent = threadKey;
    if (sheetDispatchThreadPreview) sheetDispatchThreadPreview.textContent = threadKey;

    // Description / Context
    if (sheetTaskDesc) {
      sheetTaskDesc.classList.remove("is-compact-scroll");
      if (sheetDescExpandIcon) sheetDescExpandIcon.textContent = "📖";
      if (sheetDescExpandText) sheetDescExpandText.textContent = "Foco na Descrição";
      sheetTaskDesc.scrollTop = 0;

      const rawDesc = foundTask.description || "";
      if (rawDesc.trim()) {
        sheetTaskDesc.innerHTML = renderMarkdown(rawDesc);
      } else {
        sheetTaskDesc.innerHTML = `<em style="color:var(--text-muted);font-size:13px;">Nenhuma descrição adicional informada para esta tarefa.</em>`;
      }
    }

    // Populate Dispatch From & To
    const handles = state.agents.map((a) => a.handle);
    if (!handles.includes("coordinator")) handles.unshift("coordinator");

    if (sheetDispatchFrom) {
      let fromOptions = "";
      const currentPersona = getActiveSender();
      for (const h of handles) {
        const sel = h === currentPersona ? "selected" : "";
        fromOptions += `<option value="${escapeHtml(h)}" ${sel}>${escapeHtml(h)}</option>`;
      }
      if (!handles.includes("user")) {
        fromOptions += `<option value="user" ${currentPersona === "user" ? "selected" : ""}>user (Human operator)</option>`;
      }
      sheetDispatchFrom.innerHTML = fromOptions;
    }

    if (sheetDispatchTo) {
      let toOptions = "";
      for (const h of handles) {
        const sel = h === foundTask.owner ? "selected" : "";
        toOptions += `<option value="${escapeHtml(h)}" ${sel}>${escapeHtml(h)}</option>`;
      }
      sheetDispatchTo.innerHTML = toOptions;
      sheetDispatchTo.value = foundTask.owner || "coordinator";
    }

    if (sheetDispatchBody) sheetDispatchBody.value = "";

    // Reset view tab to integrated view
    switchSheetTab("all");

    // Render linked transmissions
    renderSheetTransmissions(foundTask);

    // Show drawer
    taskSheetBackdrop?.classList.remove("hidden");
    taskSheetDrawer?.classList.remove("hidden");
  }

  function switchSheetTab(tabName) {
    if (!taskSheetDrawer) return;
    taskSheetDrawer.setAttribute("data-tab", tabName);
    if (sheetTabsBar) {
      sheetTabsBar.querySelectorAll(".sheet-tab-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === tabName);
      });
    }
    if (sheetDescBackBtn) {
      sheetDescBackBtn.style.display = tabName === "desc" ? "inline-flex" : "none";
    }
    if (sheetDescExpandIcon && sheetDescExpandText) {
      if (tabName === "desc") {
        sheetDescExpandIcon.textContent = "📜";
        sheetDescExpandText.textContent = "Visão Integrada";
      } else {
        sheetDescExpandIcon.textContent = "📖";
        sheetDescExpandText.textContent = "Foco na Descrição";
      }
    }
  }

  function closeTaskSheet() {
    if (taskSheetDrawer) {
      taskSheetDrawer.classList.add("hidden");
      taskSheetDrawer.classList.remove("drawer-wide");
      taskSheetDrawer.removeAttribute("data-tab");
      if (sheetWideIcon) sheetWideIcon.textContent = "↔️";
      if (sheetWideText) sheetWideText.textContent = "Expandir Ficha";
    }
    taskSheetBackdrop?.classList.add("hidden");
    state.selectedTaskId = null;
  }

  function setupKanbanBoard() {
    // Navigation view switching
    navViewMail?.addEventListener("click", () => switchView("mail"));
    navViewBoard?.addEventListener("click", () => switchView("board"));
    navViewPanes?.addEventListener("click", () => openPanesFocus(null));
    navViewMetrics?.addEventListener("click", () => switchView("metrics"));
    refreshPanesBtn?.addEventListener("click", () => fetchPanes());
    panesLinesSelect?.addEventListener("change", () => {
      state.panesLines = parseInt(panesLinesSelect.value, 10) || 40;
      fetchPanes();
    });
    clearPanesFocusBtn?.addEventListener("click", () => openPanesFocus(null));

    // Board search filter
    boardSearchInput?.addEventListener("input", (e) => {
      state.boardSearchQuery = e.target.value.trim();
      renderBoard();
    });

    // Refresh & sync button
    refreshBoardBtn?.addEventListener("click", () => {
      fetchBoard();
    });

    // New task modal triggers
    openNewTaskBtn?.addEventListener("click", openNewTaskModal);
    closeTaskModalBtn?.addEventListener("click", closeNewTaskModal);
    cancelTaskBtn?.addEventListener("click", closeNewTaskModal);
    newTaskForm?.addEventListener("submit", submitNewTask);
    taskOwnerSelect?.addEventListener("change", renderTaskOwnerTip);

    taskModalBackdrop?.addEventListener("click", (e) => {
      if (e.target === taskModalBackdrop) closeNewTaskModal();
    });

    // Task Sheet triggers
    closeTaskSheetBtn?.addEventListener("click", closeTaskSheet);
    sheetBackBtn?.addEventListener("click", closeTaskSheet);
    sheetDescBackBtn?.addEventListener("click", () => switchSheetTab("all"));
    taskSheetBackdrop?.addEventListener("click", closeTaskSheet);

    sheetTabsBar?.addEventListener("click", (e) => {
      const btn = e.target.closest(".sheet-tab-btn");
      if (!btn) return;
      const tab = btn.dataset.tab;
      if (tab) switchSheetTab(tab);
    });

    sheetDescExpandBtn?.addEventListener("click", () => {
      const currentTab = taskSheetDrawer?.getAttribute("data-tab") || "all";
      switchSheetTab(currentTab === "desc" ? "all" : "desc");
    });

    sheetWideBtn?.addEventListener("click", () => {
      if (!taskSheetDrawer) return;
      const isWide = taskSheetDrawer.classList.toggle("drawer-wide");
      if (sheetWideIcon) sheetWideIcon.textContent = isWide ? "><" : "↔️";
      if (sheetWideText) sheetWideText.textContent = isWide ? "Recolher Ficha" : "Expandir Ficha";
    });

    sheetCopyIdBtn?.addEventListener("click", () => {
      if (state.selectedTaskId) {
        navigator.clipboard.writeText(state.selectedTaskId).then(() => {
          showToast(`ID copiado: ${state.selectedTaskId}`);
        }).catch(() => {});
      }
    });

    sheetRefreshThreadBtn?.addEventListener("click", () => {
      if (state.selectedTaskId) {
        const task = findTaskById(state.selectedTaskId);
        if (task) renderSheetTransmissions(task);
      }
    });

    sheetStageButtons?.addEventListener("click", async (e) => {
      const btn = e.target.closest(".sheet-stage-btn");
      if (!btn) return;
      const targetStage = btn.dataset.stage;
      if (state.selectedTaskId && targetStage) {
        await moveTaskCard(state.selectedTaskId, targetStage);
        sheetStageButtons.querySelectorAll(".sheet-stage-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.stage === targetStage);
        });
        setTimeout(async () => {
          const task = findTaskById(state.selectedTaskId);
          if (task) renderSheetTransmissions(task);
        }, 350);
      }
    });

    sheetOwnerSelect?.addEventListener("change", async () => {
      const newOwner = sheetOwnerSelect.value;
      if (state.selectedTaskId && newOwner) {
        try {
          await fetch(`/api/board/tasks/${encodeURIComponent(state.selectedTaskId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              owner: newOwner,
              from: getActiveSender(),
              notify: true,
            }),
          });
          showToast(`Responsável alterado para @${newOwner} (notificação enviada)`);
          await fetchBoard();
          openTaskSheet(state.selectedTaskId);
        } catch (err) {
          alert("Erro ao alterar responsável: " + err.message);
        }
      }
    });

    sheetDispatchChips?.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      const tpl = chip.dataset.tpl;
      const task = findTaskById(state.selectedTaskId);
      const title = task?.title || "tarefa";

      if (tpl === "status") {
        sheetDispatchBody.value = `Status update requested for task: ${title}\n\nPlease report current verification gates and blockers.`;
      } else if (tpl === "block") {
        sheetDispatchBody.value = `⚠️ Task blocked: ${title}\n\nBlocker reason: [Descreva o bloqueio]\nAssistance needed from: [coordinator/outro agente]`;
      } else if (tpl === "done") {
        sheetDispatchBody.value = `✅ Task completed: ${title}\n\nEvidence / proof:\n- Verification command: bash tools/verify-all.sh --quick\n- Result: PASS`;
      } else if (tpl === "ack") {
        sheetDispatchBody.value = `ACK. Order received for task: ${title}. Work in progress.`;
      }
      sheetDispatchBody.focus();
    });

    sheetDispatchSendBtn?.addEventListener("click", async () => {
      if (!state.selectedTaskId) return;
      const bodyVal = sheetDispatchBody?.value.trim();
      if (!bodyVal) {
        alert("Digite uma mensagem para transmitir.");
        sheetDispatchBody?.focus();
        return;
      }

      const fromVal = getActiveSender(sheetDispatchFrom?.value || "");
      const toVal = sheetDispatchTo?.value || "coordinator";
      const task = findTaskById(state.selectedTaskId);

      sheetDispatchSendBtn.disabled = true;
      sheetDispatchSendBtn.innerHTML = `<span>Enviando...</span>`;

      try {
        const res = await fetch("/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: fromVal,
            to: [toVal],
            subject: `[AGboard] ${task ? task.title.slice(0, 50) : "Task update"}`,
            body: bodyVal,
            thread: `agboard/${state.selectedTaskId}`,
            kind: "task",
          }),
        });

        const data = await res.json();
        if (data.ok) {
          if (sheetDispatchBody) sheetDispatchBody.value = "";
          showToast(`Transmissão AMQ enviada para @${toVal}!`);
          await fetchData();
          const updatedTask = findTaskById(state.selectedTaskId);
          if (updatedTask) renderSheetTransmissions(updatedTask);
        } else {
          alert("Falha ao enviar transmissão: " + (data.error || "desconhecido"));
        }
      } catch (err) {
        alert("Erro: " + err.message);
      } finally {
        sheetDispatchSendBtn.disabled = false;
        sheetDispatchSendBtn.innerHTML = `
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          <span>Enviar Transmissão (AMQ)</span>
        `;
      }
    });

    // Close on Escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (taskSheetDrawer && !taskSheetDrawer.classList.contains("hidden")) {
          closeTaskSheet();
        }
      }
    });
  }

  // ─── Mobile Responsiveness & Drawer Setup ───────────────────────────────────

  function setupMobileLayout() {
    if (toggleSidebarBtn && sidebarBackdrop) {
      const isMobile = () => window.matchMedia("(max-width: 768px)").matches;
      toggleSidebarBtn.addEventListener("click", () => {
        if (isMobile()) {
          document.body.classList.toggle("sidebar-open");
          sidebarBackdrop.classList.toggle("hidden", !document.body.classList.contains("sidebar-open"));
        } else {
          // Desktop uses an in-flow collapse; it must not show the mobile
          // full-screen backdrop or dim the application.
          document.body.classList.toggle("sidebar-collapsed");
        }
      });

      sidebarBackdrop.addEventListener("click", () => {
        document.body.classList.remove("sidebar-open");
        sidebarBackdrop.classList.add("hidden");
      });

      window.addEventListener("resize", () => {
        if (!isMobile()) {
          document.body.classList.remove("sidebar-open");
          sidebarBackdrop.classList.add("hidden");
        }
      });

      // On mobile, clicking any nav folder item closes drawer
      document.querySelectorAll(".folder-list .nav-item, .sidebar-views-nav .view-tab-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (window.innerWidth <= 768) {
            document.body.classList.remove("sidebar-open");
            sidebarBackdrop.classList.add("hidden");
          }
        });
      });
    }
  }

  // ─── Pull / Scroll Down to Reload ──────────────────────────────────────────

  function setupPullToRefresh() {
    const ptrEl = document.getElementById("pull-to-refresh");
    const ptrLabel = document.getElementById("ptr-label");
    if (!ptrEl) return;

    let startY = 0;
    let currentY = 0;
    let isPulling = false;
    let isRefreshing = false;
    const threshold = 50;

    function getActiveScrollableContainer() {
      if (state.currentView === "board") {
        return document.querySelector(".kanban-grid") || boardViewSection;
      }
      if (state.detailOpen && !mailDetailViewEl.classList.contains("hidden")) {
        return mailDetailViewEl;
      }
      return mailListViewEl;
    }

    function isAtTop() {
      const container = getActiveScrollableContainer();
      if (!container) return window.scrollY <= 0;
      return container.scrollTop <= 1 && window.scrollY <= 0;
    }

    async function triggerReload() {
      if (isRefreshing) return;
      isRefreshing = true;
      ptrEl.classList.remove("pulling", "ready");
      ptrEl.classList.add("refreshing");
      if (ptrLabel) ptrLabel.textContent = "Atualizando dados...";

      try {
        await Promise.allSettled([
          fetchStatus(),
          fetchAgents(),
          fetchBriefs(),
          fetchWorktrees(),
          fetchData(),
          fetchBoard(),
        ]);
        if (ptrLabel) ptrLabel.textContent = "Atualizado!";
      } catch {
        if (ptrLabel) ptrLabel.textContent = "Erro ao atualizar";
      } finally {
        setTimeout(() => {
          ptrEl.classList.remove("refreshing");
          ptrEl.style.height = "0px";
          ptrEl.style.maxHeight = "0px";
          if (ptrLabel) ptrLabel.textContent = "Puxe para atualizar";
          isRefreshing = false;
        }, 400);
      }
    }

    // Touch events for mobile pull-to-refresh
    document.addEventListener("touchstart", (e) => {
      if (isRefreshing) return;
      if (isAtTop() && e.touches.length === 1) {
        startY = e.touches[0].clientY;
        currentY = startY;
        isPulling = true;
      }
    }, { passive: true });

    document.addEventListener("touchmove", (e) => {
      if (!isPulling || isRefreshing) return;
      currentY = e.touches[0].clientY;
      const diff = currentY - startY;

      if (diff > 0 && isAtTop()) {
        const pullDist = Math.min(70, diff * 0.45);
        ptrEl.classList.add("pulling");
        ptrEl.style.height = `${pullDist}px`;
        ptrEl.style.maxHeight = `${pullDist}px`;

        if (pullDist >= threshold) {
          ptrEl.classList.add("ready");
          if (ptrLabel) ptrLabel.textContent = "Solte para atualizar";
        } else {
          ptrEl.classList.remove("ready");
          if (ptrLabel) ptrLabel.textContent = "Puxe para atualizar";
        }
      } else {
        ptrEl.classList.remove("pulling", "ready");
        ptrEl.style.height = "0px";
        ptrEl.style.maxHeight = "0px";
      }
    }, { passive: true });

    document.addEventListener("touchend", () => {
      if (!isPulling || isRefreshing) return;
      isPulling = false;
      const diff = currentY - startY;
      const pullDist = Math.min(70, diff * 0.45);

      if (pullDist >= threshold && isAtTop()) {
        triggerReload();
      } else {
        ptrEl.classList.remove("pulling", "ready");
        ptrEl.style.height = "0px";
        ptrEl.style.maxHeight = "0px";
      }
    });

    // Click on indicator also triggers reload
    ptrEl.addEventListener("click", () => {
      triggerReload();
    });
  }

  // Boot
  applyThemePreference(state.themePreference, false);
  applyReadingLayout(state.readingLayout, false);
  fetchStatus();
  fetchAgents();
  fetchBriefs();
  fetchWorktrees();
  fetchModels();
  fetchData();
  fetchBoard();
  initSSE();
  setupPagination();
  setupContextMenu();
  setupRegisterAgentModal();
  setupKanbanBoard();
  setupMobileLayout();
  setupPullToRefresh();
})();

