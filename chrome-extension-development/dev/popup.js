document.addEventListener('DOMContentLoaded', async () => {
  const activeGroupsContainer = document.getElementById('active-groups');
  const frozenProjectsContainer = document.getElementById('frozen-projects');
  const frozenSection = document.getElementById('frozen-section');
  const activeSection = document.getElementById('active-section');
  
  const dedupeBtn = document.getElementById('dedupe-btn');
  const dedupeResult = document.getElementById('dedupe-result');
  const undoDedupeBtn = document.getElementById('undo-dedupe-btn');
  
  const exportBtn = document.getElementById('export-link');
  const importFile = document.getElementById('import-file');
  const globalSearch = document.getElementById('global-search');

  const backupPanel = document.getElementById('settings-panel');
  const backupToggle = document.getElementById('settings-accordion-toggle');
  const infoBtn = document.getElementById('info-toggle-btn');
  const infoText = document.getElementById('backup-info-text');
  const emergencyBtn = document.getElementById('emergency-restore-btn');

  const chromeColors = {
    grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#e37400',
    green: '#1e8e3e', pink: '#d01884', purple: '#9334e6', cyan: '#007b83', orange: '#e8710a'
  };

  const t = (key, fallback) => {
    return (window.I18nManager && window.I18nManager.getMessage(key)) || fallback;
  };

  function getSafeDomain(url) {
    if (!url || typeof url !== 'string') return 'Link';
    try { return new URL(url).hostname || 'Link'; } catch(e) { return 'Link'; }
  }

  function getSafeUrl(url) {
    return (url && typeof url === 'string') ? url : 'about:blank';
  }

  function log(context, message, data = {}) {
    console.log(`%c[${context}] %c${message}`, 'color: #8B5CF6; font-weight: bold;', 'color: inherit;', data);
  }

  let isProcessing = false;

  async function withLock(operation) {
    if (isProcessing) return;
    isProcessing = true;
    document.body.style.pointerEvents = 'none'; 
    document.body.style.opacity = '0.7';        
    document.body.style.cursor = 'wait';
    
    try {
      await operation();
    } catch (e) {
      log('Critical Error', e.message || e);
    } finally {
      document.body.style.pointerEvents = '';
      document.body.style.opacity = '1';
      document.body.style.cursor = '';
      isProcessing = false;
    }
  }

  function sendToFirewall(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[Popup] Firewall unreachable:", chrome.runtime.lastError);
        }
        resolve(response);
      });
    });
  }

  async function safeSetStorage(dataObj) {
    try {
      await chrome.storage.local.set(dataObj);
    } catch (e) {
      alert(t('errStorageQuota', '💾 Saving error! Storage might be full. Please export a backup and delete old projects.'));
      throw e;
    }
  }

  async function healPhantomGroups() {
    const data = await chrome.storage.local.get(['frozenProjects']);
    let projects = data.frozenProjects || [];
    let needsSave = false;
    const physicalGroups = await chrome.tabGroups.query({});

    for (let i = projects.length - 1; i >= 0; i--) {
      let p = projects[i];
      if (p.isActive) {
        const phys = physicalGroups.find(g => g.id === p.groupId);
        if (!phys || phys.title !== p.title) {
           log('Auto-Healer', `Found phantom/zombie: "${p.title}"`);
           const alreadyFrozen = projects.find(f => !f.isActive && f.title === p.title);
           if (alreadyFrozen) {
               projects.splice(i, 1); 
           } else {
               p.isActive = false; 
               p.groupId = null;
               p.date = Date.now();
           }
           needsSave = true;
        }
      }
    }
    if (needsSave) {
      await sendToFirewall({ action: 'OVERWRITE_ALL_PROJECTS', projects: projects });
    }
  }

  dedupeBtn.addEventListener('click', () => withLock(deduplicateTabs));
  undoDedupeBtn.addEventListener('click', () => withLock(undoDeduplicate));
  exportBtn.addEventListener('click', exportBackup);
  importFile.addEventListener('change', importBackup);
  
  let searchTimeout = null;
  globalSearch.addEventListener('input', () => { 
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      renderActiveGroups(globalSearch.value);
      renderFrozenProjects(globalSearch.value); 
    }, 250); // Ждем 250мс после последнего нажатия клавиши
  });

  if (backupToggle && backupPanel) {
    backupToggle.addEventListener('click', (e) => {
      if (e.target.closest('#info-toggle-btn') || e.target.closest('select')) return; 
      backupPanel.classList.toggle('expanded');
    });
  }

  if (infoBtn && infoText && backupPanel) {
    infoBtn.addEventListener('click', (e) => {
      e.stopPropagation(); 
      backupPanel.classList.add('expanded'); 
      infoText.style.display = infoText.style.display === 'block' ? 'none' : 'block';
    });
  }

  if (emergencyBtn) {
    emergencyBtn.addEventListener('click', () => {
      withLock(async () => {
        if (confirm(t('confirmRestore', 'WARNING! This will replace your data with the backup.\nContinue?'))) {
          const result = await chrome.storage.local.get(['shadowBackup']);
          if (result.shadowBackup && result.shadowBackup.data) {
            await sendToFirewall({ action: 'OVERWRITE_ALL_PROJECTS', projects: result.shadowBackup.data });
            alert(t('alertRestored', '✅ Database successfully restored!'));
            await healPhantomGroups(); 
            await render();
          }
        }
      });
    });
  }

  let draggedItemType = null; 
  let draggedItemData = null; 
  let draggedGroupCache = null;
  let lastHoveredGroup = null;
  let lastHoveredIsBottom = false;
  let lastHoveredFrozenIndex = null;

  async function render() {
    if (window.I18nManager) await window.I18nManager.init();
    await renderActiveGroups(globalSearch.value);
    await renderFrozenProjects(globalSearch.value);
  }

  async function getMetadata() {
    const data = await chrome.storage.local.get(['projectMetadata']);
    return data.projectMetadata || {};
  }

  async function saveMetadata(key, metaObj) {
    const metadata = await getMetadata();
    metadata[key] = { ...metadata[key], ...metaObj };
    await safeSetStorage({ projectMetadata: metadata });
  }

  async function deduplicateTabs() {
    const tabs = await chrome.tabs.query({});
    const urlMap = new Map();
    const tabsToClose = [];
    const closedTitles = [];
    const closedTabsUrls = []; 
    let movedCount = 0;

    for (const tab of tabs) {
      const currentUrl = tab.url || tab.pendingUrl;
      if (!currentUrl) continue;
      try {
        const urlObj = new URL(currentUrl);
        // Безопасная очистка: удаляем маркетинговые метки, сохраняем якоря для SPA
        const params = new URLSearchParams(urlObj.search);
        Array.from(params.keys()).forEach(key => {
            if (key.startsWith('utm_') || key === 'fbclid' || key === 'gclid') params.delete(key);
        });
        urlObj.search = params.toString();
        const cleanUrl = urlObj.toString().replace(/\/$/, "");
        
        if (!urlMap.has(cleanUrl)) urlMap.set(cleanUrl, []);
        urlMap.get(cleanUrl).push(tab);
      } catch (e) {}
    }

    for (const [url, duplicateTabs] of urlMap.entries()) {
      if (duplicateTabs.length > 1) {
        duplicateTabs.sort((a, b) => {
          const aInGroup = a.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE;
          const bInGroup = b.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE;
          if (aInGroup && !bInGroup) return -1;
          if (!aInGroup && bInGroup) return 1;
          return a.index - b.index;
        });
        const survivor = duplicateTabs[0];
        for (let i = 1; i < duplicateTabs.length; i++) {
          tabsToClose.push(duplicateTabs[i].id);
          closedTitles.push(duplicateTabs[i].title || url);
          closedTabsUrls.push(duplicateTabs[i].url || duplicateTabs[i].pendingUrl); 
        }
        if (survivor.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
          const groupTabs = await chrome.tabs.query({ groupId: survivor.groupId });
          if (groupTabs.length > 0) {
            groupTabs.sort((a, b) => a.index - b.index);
            const firstTab = groupTabs[0];
            const firstUrl = firstTab.url || firstTab.pendingUrl || '';
            let targetIndex = firstTab.index;
            if (firstUrl.includes('workspace.html')) targetIndex += 1; 

            if (survivor.index > targetIndex) {
              await chrome.tabs.move(survivor.id, { index: targetIndex }).catch(()=>{});
              movedCount++;
            }
          }
        }
      }
    }

    if (tabsToClose.length > 0) {
      await safeSetStorage({ lastClosedDuplicates: closedTabsUrls });
      await chrome.tabs.remove(tabsToClose).catch(()=>{});
      let reportHtml = `<strong>${t('dedupeKilled', 'Duplicates killed: ')}${tabsToClose.length} 🔫</strong><br>`;
      if (movedCount > 0) reportHtml += `<strong>${t('dedupeMoved', 'Moved forward: ')}${movedCount} ⬅️</strong><br><br>`;
      closedTitles.forEach(title => { reportHtml += `<div class="closed-item">🗑️ ${title}</div>`; });
      dedupeResult.innerHTML = reportHtml;
      dedupeResult.style.display = 'block';
      undoDedupeBtn.style.display = 'block'; 
      await render(); 
    } else {
      dedupeResult.innerHTML = `<strong>${t('dedupeClean', 'All clean! ✨')}</strong>`;
      dedupeResult.style.display = 'block';
      undoDedupeBtn.style.display = 'none';
      setTimeout(() => { dedupeResult.style.display = 'none'; }, 3000);
    }
  }

  async function undoDeduplicate() {
    const data = await chrome.storage.local.get(['lastClosedDuplicates']);
    const urlsToRestore = data.lastClosedDuplicates || [];
    if (urlsToRestore.length === 0) return;
    for (const url of urlsToRestore) { await chrome.tabs.create({ url: url, active: false }).catch(()=>{}); }
    await chrome.storage.local.remove(['lastClosedDuplicates']);
    undoDedupeBtn.style.display = 'none';
    dedupeResult.style.display = 'none';
    await render();
  }

  async function renderActiveGroups(searchQuery = '') {
    activeGroupsContainer.innerHTML = '';
    let groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
    const allTabs = await chrome.tabs.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });

    groups.sort((a, b) => {
      const tabsA = allTabs.filter(t => t.groupId === a.id);
      const tabsB = allTabs.filter(t => t.groupId === b.id);
      const minA = tabsA.length > 0 ? Math.min(...tabsA.map(t => t.index)) : Number.MAX_SAFE_INTEGER;
      const minB = tabsB.length > 0 ? Math.min(...tabsB.map(t => t.index)) : Number.MAX_SAFE_INTEGER;
      return minA - minB;
    });

    const metadata = await getMetadata();
    const query = searchQuery.toLowerCase().trim();
    const isSearching = query.length > 0;

    let matchCount = 0;

    for (const group of groups) {
      const tabs = allTabs.filter(t => t.groupId === group.id);
      const title = group.title || t('untitled', 'Untitled');
      const key = group.title || `Color_${group.color}`;
      const meta = metadata[key] || { longTitle: '' };
      
      if (query) {
        const titleMatch = title.toLowerCase().includes(query);
        const longTitleMatch = (meta.longTitle || '').toLowerCase().includes(query);
        if (!titleMatch && !longTitleMatch) continue;
      }
      matchCount++;

      const bgColor = chromeColors[group.color] || chromeColors.grey;
      const div = document.createElement('div');
      div.className = 'item'; div.style.cursor = 'pointer'; 
      
      const dragHandleHtml = !isSearching ? `<span class="drag-handle" title="Drag to sort or freeze">⋮⋮</span>` : '';

      const displayLongTitle = meta.longTitle ? `<span style="font-size: 12px; color: #888; margin-left: 8px;">${meta.longTitle}</span>` : '';
      div.innerHTML = `
        <div class="col-left">
          ${dragHandleHtml}
          <span class="group-badge" style="background-color: ${bgColor};">
            ${title} <span style="opacity: 0.8;">(${tabs.length})</span>
          </span>
          ${displayLongTitle}
        </div>
        <div class="col-action">
          <button class="action-icon-btn freeze-btn" title="${t('btnFreeze', 'Freeze')}">
            <svg width="16" height="16" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
              <polygon fill="currentColor" points="512,238.545 418.496,238.545 454.522,202.518 429.837,177.834 369.128,238.545 286.231,238.545 327.679,166.757 410.614,144.535 401.578,110.814 352.364,124.002 399.116,43.025 368.884,25.571 322.132,106.547 308.944,57.334 275.224,66.37 297.448,149.302 256,221.091 214.554,149.304 236.774,66.368 203.055,57.334 189.868,106.547 143.116,25.571 112.884,43.025 159.636,124.001 110.422,110.815 101.388,144.536 184.32,166.756 225.769,238.545 142.874,238.545 82.16,177.833 57.477,202.517 93.504,238.545 0,238.545 0,273.455 93.504,273.455 57.477,309.483 82.16,334.167 142.874,273.455 225.769,273.455 184.321,345.243 101.384,367.465 110.42,401.186 159.637,387.997 112.884,468.975 143.116,486.429 189.867,405.453 203.055,454.668 236.774,445.632 214.551,362.698 256,290.909 297.448,362.697 275.224,445.633 308.944,454.667 322.131,405.452 368.884,486.429 399.116,468.975 352.364,387.998 401.578,401.186 410.612,367.465 327.68,345.244 286.231,273.455 369.126,273.455 429.839,334.167 454.522,309.483 418.495,273.455 512,273.455"/>
            </svg>
          </button>
        </div>
      `;

      if (!isSearching) {
        div.draggable = true;
        
        div.addEventListener('dragstart', (e) => { 
          if (e.target.tagName === 'INPUT' || e.target.closest('button')) { e.preventDefault(); return; }
          draggedItemType = 'active'; 
          draggedItemData = group.id; 
          draggedGroupCache = { group, meta };
          
          e.dataTransfer.effectAllowed = 'move'; 
          e.dataTransfer.setData('text/plain', group.id.toString());
          
          setTimeout(() => div.classList.add('dragging'), 0);
          document.body.classList.add('is-dragging', 'is-dragging-active'); 
        });
        
        div.addEventListener('dragover', (e) => { 
          if (draggedItemType === 'active') { 
            e.preventDefault(); 
            e.dataTransfer.dropEffect = 'move';
            if (draggedItemData === group.id) return;
            const rect = div.getBoundingClientRect();
            const isDropBottom = (e.clientY - rect.top) >= (rect.height / 2);
            lastHoveredGroup = group.id;
            lastHoveredIsBottom = isDropBottom;
            document.querySelectorAll('#active-groups .item').forEach(i => i.classList.remove('drag-over-top', 'drag-over-bottom'));
            if (isDropBottom) { div.classList.add('drag-over-bottom'); } else { div.classList.add('drag-over-top'); }
          }
        });
        
        div.addEventListener('dragleave', (e) => { 
          div.classList.remove('drag-over-top', 'drag-over-bottom'); 
        });
        
        div.addEventListener('dragend', () => { 
          div.classList.remove('dragging'); 
          draggedItemType = null; draggedItemData = null; draggedGroupCache = null;
          lastHoveredGroup = null; lastHoveredFrozenIndex = null;
          document.querySelectorAll('.item').forEach(i => i.classList.remove('drag-over-top', 'drag-over-bottom')); 
          document.body.classList.remove('is-dragging', 'is-dragging-active', 'is-dragging-frozen'); 
          activeSection.classList.remove('active-active-drop');
          frozenSection.classList.remove('cryo-active-drop');
        });
      }

      div.addEventListener('click', (e) => {
        if (e.target.closest('input') || e.target.closest('button') || e.target.classList.contains('drag-handle')) return;

        withLock(async () => {
          const data = await chrome.storage.local.get(['frozenProjects']);
          let projects = data.frozenProjects || [];
          let existingIndex = projects.findIndex(p => p.groupId === group.id && p.isActive);

          if (existingIndex === -1) {
            const newProj = {
              title: title, longTitle: meta.longTitle, tags: '', color: group.color, urls: tabs.map(t => getSafeUrl(t.url || t.pendingUrl)),
              isActive: true, groupId: group.id,
              cards: tabs.filter(t => !(t.url || t.pendingUrl || '').includes('workspace.html')).map(t => {
                const safeUrl = getSafeUrl(t.url || t.pendingUrl);
                return { 
                  id: 'card_' + Math.random().toString(36).substr(2, 9), url: safeUrl, domain: getSafeDomain(safeUrl), 
                  title: t.title || safeUrl, note: '', cover: '', shelf: 'core', tabId: t.id, closedAt: null
                };
              })
            };
            projects.unshift(newProj);
            existingIndex = 0;
            await sendToFirewall({ action: 'OVERWRITE_ALL_PROJECTS', projects: projects });
          }

          const workspaceUrl = chrome.runtime.getURL(`workspace.html?index=${existingIndex}`);
          try { await chrome.tabGroups.update(group.id, { collapsed: false }); } catch(err) {}
          await new Promise(resolve => setTimeout(resolve, 150));
          
          const groupTabsAfter = await chrome.tabs.query({ groupId: group.id });
          const targetMinIndex = groupTabsAfter.length > 0 ? Math.min(...groupTabsAfter.map(t => t.index)) : 0;
          
          let wsTab = groupTabsAfter.find(t => (t.url || t.pendingUrl || '').includes('workspace.html'));

          if (wsTab) {
            if (!(wsTab.url || wsTab.pendingUrl || '').includes(`index=${existingIndex}`)) {
              await chrome.tabs.update(wsTab.id, { url: workspaceUrl, active: true }).catch(()=>{});
            } else {
              await chrome.tabs.update(wsTab.id, { active: true }).catch(()=>{});
            }
            await chrome.tabs.move(wsTab.id, { index: targetMinIndex }).catch(()=>{}); 
            await chrome.windows.update(wsTab.windowId, { focused: true }).catch(()=>{});
          } else {
            const newTab = await chrome.tabs.create({ windowId: group.windowId, url: workspaceUrl, active: false, index: targetMinIndex }).catch(()=>{});
            if(newTab) {
              await chrome.tabs.group({ tabIds: newTab.id, groupId: group.id }).catch(()=>{});
              await chrome.tabs.update(newTab.id, { active: true }).catch(()=>{});
              await chrome.windows.update(group.windowId, { focused: true }).catch(()=>{});
            }
          }
        });
      });

      // ИСПРАВЛЕННЫЙ ВЫЗОВ FREEZE С ПЕРЕДАЧЕЙ meta.longTitle
      div.querySelector('.freeze-btn').addEventListener('click', () => { 
        withLock(() => freezeGroup(group, tabs, meta.longTitle || '', '')); 
      });

      activeGroupsContainer.appendChild(div);
    }

    if (matchCount === 0) {
      activeGroupsContainer.innerHTML = `<div style="font-size: 11px; color: #888; padding: 10px;">${query ? t('searchNoResults', 'Search yielded no results.') : t('noActiveGroups', 'No active groups.')}</div>`;
    }
  }

  async function renderFrozenProjects(searchQuery = '') {
    frozenProjectsContainer.innerHTML = '';
    const data = await chrome.storage.local.get(['frozenProjects']);
    const projects = data.frozenProjects || [];
    const query = searchQuery.toLowerCase().trim();
    const isSearching = query.length > 0;

    const filteredProjects = projects.filter(p => {
      if (p.isActive) return false; 
      const titleMatch = (p.title || '').toLowerCase().includes(query);
      const longTitleMatch = (p.longTitle || '').toLowerCase().includes(query);
      return titleMatch || longTitleMatch;
    });

    if (filteredProjects.length === 0) {
      frozenProjectsContainer.innerHTML = `<div style="font-size: 11px; color: #888; padding: 10px;">${query ? t('searchNoResults', 'Search yielded no results.') : t('cryoEmpty', 'Cryochamber is empty.')}</div>`;
      return;
    }

    filteredProjects.forEach((project) => {
      const originalIndex = projects.indexOf(project);
      const bgColor = chromeColors[project.color] || chromeColors.grey;
      
      const dragHandleHtml = !isSearching ? `<span class="drag-handle" title="Drag to sort">⋮⋮</span>` : '';

      const div = document.createElement('div');
      div.className = 'item'; div.style.cursor = 'pointer';
      
      const displayLongTitle = project.longTitle ? `<span style="font-size: 12px; color: #888; margin-left: 8px;">${project.longTitle}</span>` : '';
      div.innerHTML = `
        <div class="col-left">
          ${dragHandleHtml}
          <span class="group-badge" style="background-color: ${bgColor}; opacity: 0.9;">
            ${project.title} <span style="opacity: 0.8; font-size: 11px;">(${project.cards ? project.cards.filter(c=>c.shelf==='core').length : 0})</span>
          </span>
          ${displayLongTitle}
        </div>
        <div class="col-action">
          <button class="action-icon-btn view-btn" title="${t('btnViewDashboard', 'Open dashboard only')}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
          </button>
          <button class="action-icon-btn restore-btn" title="${t('btnRestore', 'Restore')}">
            <svg width="16" height="16" viewBox="0 0 256 196" xmlns="http://www.w3.org/2000/svg">
              <g fill="none" stroke="currentColor" stroke-width="28" stroke-linecap="round" stroke-linejoin="round">
                <path d="M16 40 Q128 -10 240 40 L210 150 Q128 120 46 150 Z"/>
                <path d="M80 155 C95 135 95 120 80 100"/>
                <path d="M128 165 C145 140 145 120 128 100"/>
                <path d="M176 155 C191 135 191 120 176 100"/>
              </g>
              <g fill="currentColor">
                <polygon points="80,50 55,100 105,100"/>
                <polygon points="128,50 103,100 153,100"/>
                <polygon points="176,50 151,100 201,100"/>
              </g>
            </svg>
          </button>
          <button class="action-icon-btn delete-btn" title="${t('tooltipDeleteForever', 'Delete permanently')}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
        </div>
      `;

      if (!isSearching) {
        div.draggable = true;
        div.addEventListener('dragstart', (e) => { 
          if (e.target.tagName === 'INPUT' || e.target.closest('button')) { e.preventDefault(); return; }
          draggedItemType = 'frozen'; draggedItemData = originalIndex; 
          e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', originalIndex.toString()); 
          setTimeout(() => div.classList.add('dragging'), 0);
          document.body.classList.add('is-dragging', 'is-dragging-frozen'); 
        });
        
        div.addEventListener('dragover', (e) => { 
          if(draggedItemType === 'frozen') { 
            e.preventDefault(); e.dataTransfer.dropEffect = 'move';
            if (draggedItemData === originalIndex) return;
            const rect = div.getBoundingClientRect();
            const isDropBottom = (e.clientY - rect.top) >= (rect.height / 2);
            lastHoveredFrozenIndex = originalIndex;
            lastHoveredIsBottom = isDropBottom;
            document.querySelectorAll('#frozen-projects .item').forEach(i => i.classList.remove('drag-over-top', 'drag-over-bottom'));
            if (isDropBottom) { div.classList.add('drag-over-bottom'); } else { div.classList.add('drag-over-top'); }
          }
        });
        
        div.addEventListener('dragleave', (e) => { div.classList.remove('drag-over-top', 'drag-over-bottom'); });
        
        div.addEventListener('dragend', () => { 
          div.classList.remove('dragging'); 
          draggedItemType = null; draggedItemData = null; 
          lastHoveredGroup = null; lastHoveredFrozenIndex = null;
          document.querySelectorAll('.item').forEach(i => i.classList.remove('drag-over-top', 'drag-over-bottom')); 
          document.body.classList.remove('is-dragging', 'is-dragging-frozen', 'is-dragging-active'); 
          activeSection.classList.remove('active-active-drop');
          frozenSection.classList.remove('cryo-active-drop');
        });
      }

      // Теперь воркспейс открывается ТОЛЬКО по клику на кнопку "Глаз"
      div.querySelector('.view-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        
        const targetUrl = chrome.runtime.getURL(`workspace.html?index=${originalIndex}`);
        
        // ПРОВЕРКА: Ищем уже открытую вкладку с этим Workspace
        const existingTabs = await chrome.tabs.query({ url: targetUrl });
        
        if (existingTabs.length > 0) {
          const existingTab = existingTabs[0];
          await chrome.tabs.update(existingTab.id, { active: true });
          await chrome.windows.update(existingTab.windowId, { focused: true });
        } else {
          chrome.tabs.create({ url: targetUrl });
        }
      });
      
      div.querySelector('.restore-btn').addEventListener('click', () => {
        withLock(() => restoreProject(originalIndex, project));
      });
      
      div.querySelector('.delete-btn').addEventListener('click', () => {
        withLock(async () => {
          if (confirm(t('confirmDeleteProject', 'Delete project from archive permanently?'))) { 
            await sendToFirewall({ action: 'DELETE_GROUP', index: originalIndex }); 
            await render(); 
          }
        });
      });

      frozenProjectsContainer.appendChild(div);
    });
  }

  if(activeSection) {
    activeSection.addEventListener('dragover', (e) => {
      e.preventDefault(); 
      if (draggedItemType === 'frozen') {
        e.dataTransfer.dropEffect = 'move';
        activeSection.classList.add('active-active-drop');
        document.querySelectorAll('#frozen-projects .item').forEach(i => i.classList.remove('drag-over-top', 'drag-over-bottom'));
      } else if (draggedItemType === 'active') {
        e.dataTransfer.dropEffect = 'move';
      }
    });
    
    activeSection.addEventListener('dragleave', () => {
      activeSection.classList.remove('active-active-drop');
    });
    
    activeSection.addEventListener('drop', (e) => {
      e.preventDefault();
      activeSection.classList.remove('active-active-drop');
      document.querySelectorAll('.item').forEach(i => i.classList.remove('drag-over-top', 'drag-over-bottom'));
      
      const sType = draggedItemType; const sData = draggedItemData; const tGroup = lastHoveredGroup; const tIsBottom = lastHoveredIsBottom;

      withLock(async () => {
        if (sType === 'frozen' && sData !== null) {
          const data = await chrome.storage.local.get(['frozenProjects']);
          const projects = data.frozenProjects || [];
          const projectToRestore = projects[sData];
          if (projectToRestore) await restoreProject(sData, projectToRestore);
        } 
        else if (sType === 'active' && sData !== null && tGroup !== null) {
          if (sData === tGroup) return;
          try {
            const targetTabs = await chrome.tabs.query({ groupId: tGroup });
            const draggedTabs = await chrome.tabs.query({ groupId: sData });
            if (targetTabs.length > 0 && draggedTabs.length > 0) {
              let targetIndex = tIsBottom ? targetTabs[targetTabs.length - 1].index + 1 : targetTabs[0].index;
              if (draggedTabs[0].index < targetTabs[0].index) targetIndex -= draggedTabs.length;
              targetIndex = Math.max(0, targetIndex);
              await chrome.tabGroups.move(sData, { index: targetIndex }).catch(()=>{});
              setTimeout(() => render(), 250); 
            }
          } catch(err) {}
        }
      });
    });
  }

  if(frozenSection) {
    frozenSection.addEventListener('dragover', (e) => {
      e.preventDefault(); 
      if (draggedItemType === 'active') {
        e.dataTransfer.dropEffect = 'move';
        frozenSection.classList.add('cryo-active-drop');
        document.querySelectorAll('#active-groups .item').forEach(i => i.classList.remove('drag-over-top', 'drag-over-bottom'));
      } else if (draggedItemType === 'frozen') {
        e.dataTransfer.dropEffect = 'move';
      }
    });
    
    frozenSection.addEventListener('dragleave', () => { frozenSection.classList.remove('cryo-active-drop'); });
    
    frozenSection.addEventListener('drop', (e) => {
      e.preventDefault();
      frozenSection.classList.remove('cryo-active-drop');
      document.querySelectorAll('.item').forEach(i => i.classList.remove('drag-over-top', 'drag-over-bottom'));
      
      const sType = draggedItemType; const sData = draggedItemData; const sCache = draggedGroupCache; const tIndex = lastHoveredFrozenIndex; const tIsBottom = lastHoveredIsBottom;

      withLock(async () => {
        if (sType === 'active' && sCache) {
          const { group, meta } = sCache;
          const freshTabs = await chrome.tabs.query({ groupId: group.id });
          await freezeGroup(group, freshTabs, meta.longTitle, '');
        } 
        else if (sType === 'frozen' && sData !== null && tIndex !== null) {
          if (sData === tIndex) return;
          let newTargetIndex = tIndex;
          if (sData < tIndex) newTargetIndex--; 
          if (tIsBottom) newTargetIndex++; 
          
          await sendToFirewall({ 
            action: 'MOVE_FROZEN_GROUP', 
            sourceIndex: sData, 
            targetIndex: newTargetIndex 
          });
          await render(); 
        }
      });
    });
  }

// =========================================================================
  // 🛡️ ОБНОВЛЕННАЯ ФУНКЦИЯ FREEZE (ДЕЛЕГИРУЕТ РАБОТУ В ФОН)
  // =========================================================================
  async function freezeGroup(group, tabs, longTitle, tags) {
    log('Freeze', `Sending PROCESS_FREEZE command to Firewall for group: ${group.title}`);

    // Отправляем в Service Worker только сырые данные
    await sendToFirewall({
      action: 'PROCESS_FREEZE',
      group: { id: group.id, title: group.title, color: group.color },
      tabs: tabs.map(t => ({ id: t.id, url: t.url, pendingUrl: t.pendingUrl, title: t.title, status: t.status })),
      longTitle: longTitle
    });

    await render();
  }

  // =========================================================================
  // 🛡️ ОБНОВЛЕННАЯ ФУНКЦИЯ RESTORE (ДЕЛЕГИРУЕТ РАБОТУ В ФОН)
  // =========================================================================
  async function restoreProject(index, project) {
    log('Restore', `Sending PROCESS_RESTORE command to Firewall for project index: ${index}`);

    const allGroups = await chrome.tabGroups.query({});
    const existingGroup = allGroups.find(g => g.title === project.title);

    if (existingGroup) {
      await sendToFirewall({
        action: 'RESTORE_GROUP',
        index: index,
        groupId: existingGroup.id,
        cardsData: project.cards || []
      });
    } else {
      await sendToFirewall({
        action: 'PROCESS_RESTORE',
        index: index
      });

      // Сохраняем метаданные заголовка
      const key = project.title || `Color_${project.color}`;
      await saveMetadata(key, { longTitle: project.longTitle || ''});
    }

    globalSearch.value = ''; 
    await render();
  }

  async function exportBackup() {
    const data = await chrome.storage.local.get(['frozenProjects']);
    const projects = data.frozenProjects || [];
    const jsonString = JSON.stringify(projects, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `project_freezer_backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click(); URL.revokeObjectURL(url);
  }

  async function importBackup(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const importedProjects = JSON.parse(e.target.result);
        if (!Array.isArray(importedProjects)) return alert(t('errFormat', 'Format error'));
        
        const isOverwrite = confirm(t('confirmImportMerge', "Do you want to REPLACE your entire database with this file?\n\n• Click 'OK' to completely OVERWRITE your data.\n• Click 'Cancel' to safely ADD (merge) these projects to your existing list."));

        if (isOverwrite) {
          await sendToFirewall({ action: 'OVERWRITE_ALL_PROJECTS', projects: importedProjects });
        } else {
          const data = await chrome.storage.local.get(['frozenProjects']);
          const mergedProjects = [...(data.frozenProjects || []), ...importedProjects];
          await sendToFirewall({ action: 'OVERWRITE_ALL_PROJECTS', projects: mergedProjects });
        }
        
        await healPhantomGroups(); 
        await render();
        alert(t('alertBackupSuccess', "✅ Backup successfully processed!"));
      } catch (error) { 
        alert(t('errReadFile', 'Read error')); 
      }
      event.target.value = ''; 
    };
    reader.readAsText(file);
  }

  async function checkShadowBackup() {
    const result = await chrome.storage.local.get(['shadowBackup']);
    
    if (result.shadowBackup && result.shadowBackup.data) {
      const date = new Date(result.shadowBackup.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      if (emergencyBtn) {
        emergencyBtn.classList.add('show-btn');
        const prefix = t('rescueDataPrefix', 'Rescue Data (Last auto-backup:');
        emergencyBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4"></circle><line x1="4.93" y1="4.93" x2="9.17" y2="9.17"></line><line x1="14.83" y1="14.83" x2="19.07" y2="19.07"></line><line x1="14.83" y1="9.17" x2="19.07" y2="4.93"></line><line x1="14.83" y1="9.17" x2="18.36" y2="5.64"></line><line x1="4.93" y1="19.07" x2="9.17" y2="14.83"></line></svg>
          <span class="rescue-text">${prefix} ${date})</span>
        `;
      }
    }
  }

  async function initApp() {
    if (window.I18nManager) await window.I18nManager.init();
    
    if (globalSearch && t('searchGroups')) {
        globalSearch.placeholder = t('searchGroups', 'Search Groups...');
    }
    
    await healPhantomGroups(); 
    await checkShadowBackup();
    await render();
  }

  // ЗАЩИТА ОТ ЗАЛИПАНИЯ DRAG & DROP ПРИ НАЖАТИИ ESCAPE
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.body.classList.remove('is-dragging', 'is-dragging-active', 'is-dragging-frozen');
      document.querySelectorAll('.item').forEach(i => {
        i.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
      });
      if (activeSection) activeSection.classList.remove('active-active-drop');
      if (frozenSection) frozenSection.classList.remove('cryo-active-drop');
      draggedItemType = null; draggedItemData = null; draggedGroupCache = null;
    }
  });

  initApp();
});
