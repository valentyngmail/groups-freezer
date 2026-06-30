document.addEventListener('DOMContentLoaded', async () => {
  let projectIndex = null;
  let projectsData = [];
  let currentProject = null;
  let historyStack = []; 
  let isUpdatingTabs = false; 
  let customPresets = []; 
  let archiveCurrentPage = 1;

  const urlParams = new URLSearchParams(window.location.search);
  projectIndex = urlParams.get('index');
  if (projectIndex === null) return;

  const freezeBtn = document.getElementById('btn-freeze-toggle');
  const undoBtn = document.querySelector('.undo-btn');
  const searchInput = document.querySelector('.top-search-input');
  
  const viewGridBtn = document.getElementById('view-grid-btn');
  const viewListBtn = document.getElementById('view-list-btn');
  const gridImportant = document.getElementById('grid-important');

  const wsInfoBtn = document.getElementById('ws-info-btn');
  const wsWelcomeBox = document.getElementById('ws-welcome-box');
  const wsWelcomeClose = document.getElementById('ws-welcome-close');
  const wsFrozenToast = document.getElementById('ws-frozen-toast');
  const wsFrozenToastClose = document.getElementById('ws-frozen-toast-close');

  const t = (key, fallback) => {
    if (window.I18nManager) {
      const msg = window.I18nManager.getMessage(key);
      return msg ? msg : fallback;
    }
    return fallback;
  };

  chrome.storage.local.get(['workspaceViewMode'], (res) => {
    if (res.workspaceViewMode === 'list') {
      gridImportant.classList.add('list-view');
      viewListBtn.classList.add('active');
      viewGridBtn.classList.remove('active');
    }
  });

  viewGridBtn.addEventListener('click', () => {
    gridImportant.classList.remove('list-view');
    viewGridBtn.classList.add('active');
    viewListBtn.classList.remove('active');
    chrome.storage.local.set({workspaceViewMode: 'grid'});
  });

  viewListBtn.addEventListener('click', () => {
    gridImportant.classList.add('list-view');
    viewListBtn.classList.add('active');
    viewGridBtn.classList.remove('active');
    chrome.storage.local.set({workspaceViewMode: 'list'});
  });

  if (window.I18nManager) await window.I18nManager.init();

  chrome.storage.local.get(['hasSeenWorkspaceWelcome'], (res) => {
    if (!res.hasSeenWorkspaceWelcome) {
      if (wsWelcomeBox) wsWelcomeBox.classList.add('show');
      chrome.storage.local.set({ hasSeenWorkspaceWelcome: true });
    }
  });

  if (wsInfoBtn && wsWelcomeBox) {
    wsInfoBtn.addEventListener('click', () => {
      wsWelcomeBox.classList.toggle('show');
    });
  }

  if (wsWelcomeClose && wsWelcomeBox) {
    wsWelcomeClose.addEventListener('click', () => {
      wsWelcomeBox.classList.remove('show');
    });
  }

  if (wsFrozenToastClose && wsFrozenToast) {
    wsFrozenToastClose.addEventListener('click', () => {
      wsFrozenToast.classList.remove('show');
    });
  }

  // =========================================================================
  // 🛡️ СОХРАНЕНИЕ СТРОГО ЧЕРЕЗ FIREWALL
  // =========================================================================
  async function saveState(syncUrls = true) {
    if (!currentProject) return;
    if (syncUrls) currentProject.urls = currentProject.cards.map(c => c.url);
    
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'SAVE_WORKSPACE_STATE',
        index: parseInt(projectIndex),
        project: currentProject
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[Workspace] Background disconnected. Save aborted to prevent database corruption.");
          resolve();
        } else {
          resolve();
        }
      });
    });
  }

  // ЗАЩИТА ОТ ЗАЛИПАНИЯ DRAG & DROP ПРИ НАЖАТИИ ESCAPE
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.card, .preset-pill').forEach(el => el.classList.remove('dragging'));
      document.querySelectorAll('.drag-over-preset, .drag-over-preset-sort').forEach(el => el.classList.remove('drag-over-preset', 'drag-over-preset-sort'));
      const archiveZone = document.getElementById('section-other');
      if (archiveZone) archiveZone.classList.remove('archive-active-drop');
      draggedCardEl = null;
    }
  });

  await loadProjectData();
  setupSearch();
  setupLiveListeners(); 

  window.addEventListener('error', (e) => {
    console.error("Global Error Caught:", e);
    if (window.HistoryManager) window.HistoryManager.addLog(`${t('logError', 'Error:')} ${e.message}`, 'error');
  });

  document.getElementById('clear-archive-btn').addEventListener('click', async () => {
    const confirmMessage = t('confirmClearArchive', 'Are you sure you want to clear the archive? All previously closed tabs in this group will be deleted permanently.');
    if (confirm(confirmMessage)) {
      pushToHistory();
      currentProject.cards = currentProject.cards.filter(c => c.shelf !== 'archive');
      await saveState(true);
      renderWorkspace();
    }
  });

  async function loadProjectData() {
    const data = await chrome.storage.local.get(['frozenProjects', 'namePresets']);
    projectsData = data.frozenProjects || [];
    currentProject = projectsData[parseInt(projectIndex)];
    customPresets = data.namePresets || ['Jira Task', 'Tech Spec', 'Dashboard', 'Meeting Notes'];

    if (!currentProject) { 
      document.body.innerHTML = `<h2 style="padding: 40px;">${t('msgProjectNotFound', 'Project not found.')}</h2>`; 
      return; 
    }
    currentProject.activityLog = currentProject.activityLog || [];

    // ЗАЩИТА ОТ ЗОМБИ-ID
    if (currentProject.isActive && currentProject.groupId) {
      try { 
        const g = await chrome.tabGroups.get(currentProject.groupId); 
        if (g.title === currentProject.title) {
          currentProject.isActive = true; 
        } else {
          console.warn("[Workspace] Zombie ID detected! Disconnecting from physical group.");
          currentProject.isActive = false;
          currentProject.groupId = null;
          await saveState(false);
        }
      } 
      catch (e) { 
        currentProject.isActive = false; 
        currentProject.groupId = null; 
        await saveState(false);
      }
    }

    if (!currentProject.isActive && wsFrozenToast) {
      setTimeout(() => {
        wsFrozenToast.classList.add('show');
        setTimeout(() => { wsFrozenToast.classList.remove('show'); }, 8000);
      }, 600);
    }

    if (!currentProject.cards || currentProject.cards.length === 0) {
      currentProject.cards = (currentProject.urls || []).map(url => createCardObject(url));
      await saveState(false); 
    }

    if (window.HistoryManager) window.HistoryManager.init(currentProject, () => saveState(false));
    if (window.ConstitutionManager) window.ConstitutionManager.init(currentProject, () => saveState(false), pushToHistory);
    if (window.TaskManager) window.TaskManager.init(currentProject, () => saveState(false), pushToHistory);

    renderWorkspace();
    syncWithPhysicalGroup();
    checkWsShadowBackup(); // Проверяем глобальный бэкап при загрузке
  }

  function createCardObject(url, tabId = null, title = null) {
    return { id: 'card_' + Math.random().toString(36).substr(2, 9), url: url, domain: AppUtils.getSafeDomain(url), title: title || url, note: '', cover: '', shelf: 'core', tabId: tabId, closedAt: null };
  }

  // =========================================================================
  // 🚀 ОПТИМИЗИРОВАННАЯ СИНХРОНИЗАЦИЯ (PARALLEL PROMISE.ALL)
  // =========================================================================
  async function syncWithPhysicalGroup() {
    if (!currentProject.isActive || !currentProject.groupId || isUpdatingTabs) return;
    isUpdatingTabs = true; 
    try {
      const physicalTabs = await chrome.tabs.query({ groupId: currentProject.groupId });
      let hasChanges = false;
      
      const processTab = async (tab) => {
        const safeUrl = tab.url || tab.pendingUrl || 'about:blank';
        if (safeUrl.includes('workspace.html')) return;
        
        let existingCard = currentProject.cards.find(c => c.tabId === tab.id);
        
        if (!existingCard) {
          existingCard = currentProject.cards.find(c => c.url === safeUrl && !c.tabId && c.shelf !== 'archive');
          if (existingCard) {
            existingCard.tabId = tab.id;
            hasChanges = true;
            return;
          }

          let meta = { desc: '', img: '' };
          const isHeavyOrSystem = safeUrl.startsWith('chrome://') || safeUrl.toLowerCase().endsWith('.pdf') || safeUrl === 'about:blank';
          
          if (!isHeavyOrSystem && tab.status === 'complete') {
            try {
              const scriptPromise = chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                  const getM = (n) => { const el = document.querySelector(`meta[name="${n}"], meta[property="${n}"]`); return el ? el.getAttribute('content') : ''; };
                  return { desc: getM('description') || '', img: getM('og:image') || '' };
                }
              }).catch(() => null);
              
              const res = await AppUtils.withTimeout(scriptPromise, 500);
              if(res && res[0] && res[0].result) meta = res[0].result;
            } catch(e) {}
          }

          let initialTitle = tab.title;
          if (!initialTitle || initialTitle === 'Loading...') {
            initialTitle = AppUtils.getCleanTitle(safeUrl, safeUrl); 
          }

          currentProject.cards.push({
            id: 'card_' + Math.random().toString(36).substr(2, 9),
            url: safeUrl, domain: AppUtils.getSafeDomain(safeUrl), title: initialTitle,
            note: (meta.desc || '').substring(0, 100), cover: meta.img || '', shelf: 'core', tabId: tab.id, closedAt: null
          });
          hasChanges = true;
        } else {
          let cardNeedsUpdate = false;
          
          if (existingCard.url !== safeUrl) {
            existingCard.url = safeUrl;
            existingCard.domain = AppUtils.getSafeDomain(safeUrl);
            cardNeedsUpdate = true;
          }
          
          if (tab.status === 'complete' && tab.title && tab.title !== 'Loading...' && existingCard.title !== tab.title) {
            if (!existingCard.isCustomTitle) {
              existingCard.title = tab.title;
              cardNeedsUpdate = true;
            }
          }

          if (cardNeedsUpdate) hasChanges = true;
        }
      };

      // Обрабатываем все вкладки параллельно для скорости
      await Promise.all(physicalTabs.map(t => processTab(t)));

      if (hasChanges) { await saveState(true); renderWorkspace(); }
    } catch (e) {
      console.error("Sync Error:", e);
    } finally {
      isUpdatingTabs = false; 
    }
  }

  function deduplicateArchive() {
    const urlMap = {};
    currentProject.cards.forEach(c => {
      if (c.shelf === 'archive') {
        const normUrl = AppUtils.getNormalizedUrl(c.url);
        if (!urlMap[normUrl]) urlMap[normUrl] = [];
        urlMap[normUrl].push(c);
      }
    });
    
    const idsToRemove = new Set();
    Object.values(urlMap).forEach(list => {
      if (list.length > 1) {
        list.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)); 
        const newest = list[0]; 

        for (let i = 1; i < list.length; i++) {
          const older = list[i];
          idsToRemove.add(older.id);

          if (older.note) {
            if (!newest.note) {
              newest.note = older.note;
            } else if (!newest.note.includes(older.note) && !older.note.includes(newest.note)) {
              newest.note = older.note + "\n---\n" + newest.note; 
            }
          }

          const olderClean = AppUtils.getCleanTitle(older.url, older.url); 
          if (older.title && older.title !== 'Loading...' && older.title !== older.url && older.title !== olderClean) {
            const newestClean = AppUtils.getCleanTitle(newest.url, newest.url);
            if (!newest.title || newest.title === 'Loading...' || newest.title === newest.url || newest.title === newestClean) {
              newest.title = older.title;
            }
          }
        }
      }
    });
    
    if (idsToRemove.size > 0) {
      currentProject.cards = currentProject.cards.filter(c => !idsToRemove.has(c.id));
    }
  }

  function renderPresets() {
    const container = document.getElementById('presets-container');
    if (!container) return;
    container.innerHTML = '';
    
    customPresets.forEach((p, index) => {
      const pill = document.createElement('div');
      pill.className = 'preset-pill'; pill.draggable = true; pill.dataset.name = p;
      pill.innerHTML = `<span class="preset-name" title="${p}">${p}</span><button class="preset-delete" title="${t('tooltipDeleteTag', 'Delete tag')}">✕</button>`;

      pill.querySelector('.preset-delete').addEventListener('click', async (e) => {
        e.stopPropagation(); customPresets.splice(index, 1);
        await chrome.storage.local.set({ namePresets: customPresets }); renderPresets();
      });

      pill.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('presetName', p); e.dataTransfer.setData('presetIndex', index);
        setTimeout(() => pill.classList.add('dragging'), 0);
      });
      pill.addEventListener('dragend', () => pill.classList.remove('dragging'));
      pill.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('presetindex')) { e.preventDefault(); pill.classList.add('drag-over-preset-sort'); } });
      pill.addEventListener('dragleave', () => pill.classList.remove('drag-over-preset-sort'));
      pill.addEventListener('drop', async (e) => {
        const fromIndex = e.dataTransfer.getData('presetIndex');
        if (fromIndex !== '') {
          e.preventDefault(); e.stopPropagation(); pill.classList.remove('drag-over-preset-sort');
          const moved = customPresets.splice(parseInt(fromIndex), 1)[0];
          customPresets.splice(index, 0, moved);
          await chrome.storage.local.set({ namePresets: customPresets }); renderPresets();
        }
      });
      container.appendChild(pill);
    });

    const inputHTML = document.createElement('input');
    inputHTML.type = 'text'; inputHTML.className = 'new-preset-input'; inputHTML.placeholder = t('placeholderNewTag', '+ New tag...');
    inputHTML.addEventListener('keypress', async (e) => {
      if (e.key === 'Enter' && e.target.value.trim()) {
        customPresets.push(e.target.value.trim()); await chrome.storage.local.set({ namePresets: customPresets }); renderPresets();
      }
    });
    container.appendChild(inputHTML);
  }

  function renderWorkspace() {
    const shortTitle = document.getElementById('ws-short-title');
    if (shortTitle) {
      shortTitle.textContent = currentProject.title || t('untitled', 'Group');
    }
    
    document.querySelector('.project-name-input').value = currentProject.longTitle || '';
    
    const badge = document.getElementById('ws-badge');
    const colors = { grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#e37400', green: '#1e8e3e', pink: '#d01884', purple: '#9334e6', cyan: '#007b83', orange: '#e8710a' };
    badge.style.backgroundColor = colors[currentProject.color] || '#1a73e8';
    document.getElementById('ws-count').textContent = `(${currentProject.cards.length})`;

    // =========================================================
    // ТОЛЬКО ОТОБРАЖЕНИЕ СТАТУСА (Без возможности клика)
    // =========================================================
    freezeBtn.disabled = true; 
    freezeBtn.style.opacity = '1'; 
    freezeBtn.style.cursor = 'default'; // Убираем курсор-палец
    
    if (currentProject.isActive) { 
      freezeBtn.className = 'status-btn active'; 
      freezeBtn.innerHTML = '🟢 ' + t('statusActive', 'ACTIVE'); 
    } else { 
      freezeBtn.className = 'status-btn frozen'; 
      freezeBtn.innerHTML = '❄️ ' + t('statusFrozen', 'FROZEN'); 
    }

    renderPresets();

    const gridCore = document.getElementById('grid-important');
    gridCore.innerHTML = '';

    const termGlobal = searchInput ? searchInput.value.toLowerCase() : '';

    currentProject.cards.forEach(cardData => {
      if (cardData.shelf === 'aux') cardData.shelf = 'core';
      if (cardData.shelf === 'core') {
        const cardEl = buildCardElement(cardData);
        
        if (termGlobal) {
            const textToSearch = `${cardData.title} ${cardData.domain} ${cardData.note || ''}`.toLowerCase();
            cardEl.style.display = textToSearch.includes(termGlobal) ? 'flex' : 'none';
        }
        
        gridCore.appendChild(cardEl);
      }
    });

    renderArchive(); 
    initDragAndDrop();
    updateBadges();
  }

  function renderArchive() {
    const gridOther = document.getElementById('grid-other');
    gridOther.innerHTML = '';

    let archiveCards = currentProject.cards.filter(c => c.shelf === 'archive');
    
    const termGlobal = searchInput ? searchInput.value.toLowerCase() : '';
    const fDate = document.getElementById('filter-date') ? document.getElementById('filter-date').value.toLowerCase() : '';
    const fTitle = document.getElementById('filter-title') ? document.getElementById('filter-title').value.toLowerCase() : '';
    const fUrl = document.getElementById('filter-url') ? document.getElementById('filter-url').value.toLowerCase() : '';
    const fNote = document.getElementById('filter-note') ? document.getElementById('filter-note').value.toLowerCase() : '';

    archiveCards = archiveCards.filter(c => {
      if (!c.closedAt) c.closedAt = Date.now();
      const dStr = new Date(c.closedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).toLowerCase();
      const tStr = AppUtils.getCleanTitle(c.title, c.url).toLowerCase();
      const uStr = c.url.toLowerCase();
      const nStr = (c.note || '').toLowerCase();

      if (termGlobal && !`${tStr} ${uStr} ${nStr}`.includes(termGlobal)) return false;
      if (fDate && !dStr.includes(fDate)) return false;
      if (fTitle && !tStr.includes(fTitle)) return false;
      if (fUrl && !uStr.includes(fUrl)) return false;
      if (fNote && !nStr.includes(fNote)) return false;

      return true;
    });

    archiveCards.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));

    const ITEMS_PER_PAGE = 20;
    const totalPages = Math.ceil(archiveCards.length / ITEMS_PER_PAGE) || 1;
    if (archiveCurrentPage > totalPages) archiveCurrentPage = totalPages;

    const pagedArchive = archiveCards.slice((archiveCurrentPage - 1) * ITEMS_PER_PAGE, archiveCurrentPage * ITEMS_PER_PAGE);

    if (pagedArchive.length > 0) {
      const table = document.createElement('div');
      table.className = 'archive-table';
      pagedArchive.forEach(cardData => { table.appendChild(buildArchiveRowElement(cardData)); });
      gridOther.appendChild(table);
    }

    const pagContainer = document.getElementById('archive-pagination');
    pagContainer.innerHTML = '';
    if (totalPages > 1) {
      const prev = document.createElement('button'); 
      prev.innerText = '◀ ' + t('btnPrev', 'PREV'); 
      prev.disabled = archiveCurrentPage === 1;
      prev.onclick = () => { archiveCurrentPage--; renderWorkspace(); };
      
      const info = document.createElement('span'); 
      info.innerText = `${t('msgPage', 'Page')} ${archiveCurrentPage} ${t('msgOf', 'of')} ${totalPages}`;
      
      const next = document.createElement('button'); 
      next.innerText = t('btnNext', 'NEXT') + ' ▶'; 
      next.disabled = archiveCurrentPage === totalPages;
      next.onclick = () => { archiveCurrentPage++; renderWorkspace(); };
      
      pagContainer.appendChild(prev); pagContainer.appendChild(info); pagContainer.appendChild(next);
    }
  }

  function buildArchiveRowElement(cardData) {
    const row = document.createElement('div');
    row.className = 'archive-row card'; 
    row.draggable = true;
    row.dataset.id = cardData.id;

    if (!cardData.closedAt) cardData.closedAt = Date.now();
    const dateObj = new Date(cardData.closedAt);
    const dateStr = dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const displayTitle = AppUtils.getCleanTitle(cardData.title, cardData.url);

    row.innerHTML = `
      <div class="arch-col-date" title="${dateStr}">${dateStr}</div>
      <div class="arch-col-title" title="${displayTitle}">${displayTitle}</div>
      <a href="${cardData.url}" target="_blank" draggable="false" class="arch-col-url" title="${cardData.url}">${cardData.url}</a>
      <textarea class="arch-col-note" placeholder="${t('placeholderNote', 'Add note...')}" rows="1" spellcheck="false">${cardData.note || ''}</textarea>
      <button class="arch-col-del" title="${t('tooltipDelete', 'Delete')}">✕</button>
    `;

    row.querySelector('.arch-col-url').addEventListener('mousedown', (e) => e.stopPropagation());

    const noteInput = row.querySelector('.arch-col-note');
    noteInput.addEventListener('mousedown', (e) => e.stopPropagation()); 
    setTimeout(() => AppUtils.autoResize(noteInput), 0);
    noteInput.addEventListener('input', () => AppUtils.autoResize(noteInput));
    
    let originalNote = cardData.note || '';
    noteInput.addEventListener('focus', () => { originalNote = noteInput.value; });
    noteInput.addEventListener('blur', async () => { 
      if (noteInput.value !== originalNote) {
        pushToHistory(); cardData.note = noteInput.value; 
        if (window.HistoryManager) window.HistoryManager.addLog(t('logNoteEdited', '✏️ Заметка изменена'));
        await saveState(false); 
      }
    });

    row.querySelector('.arch-col-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      pushToHistory(); 
      currentProject.cards = currentProject.cards.filter(c => c.id !== cardData.id); 
      await saveState(true); 
      renderWorkspace();
    });

    return row;
  }

  function buildCardElement(cardData) {
    const card = document.createElement('div');
    card.className = 'card'; card.setAttribute('draggable', 'true'); card.dataset.id = cardData.id;

    const displayTitle = AppUtils.getCleanTitle(cardData.title, cardData.url);
    const coverHtml = cardData.cover 
      ? `<div class="card-cover" style="background-image: url('${cardData.cover}')"></div>` 
      : `<div class="card-cover-color" style="background: ${AppUtils.getSmartGradient(cardData.url, cardData.domain)}"></div>`;

    card.innerHTML = `
      ${coverHtml}
      <div class="card-meta">
        <div class="card-favicon"><img src="https://www.google.com/s2/favicons?domain=${cardData.domain}&sz=64" class="favicon-img"></div>
        <div class="card-domain" title="${cardData.url}">${cardData.domain}</div>
        <div class="card-actions">
          <button class="card-remove-btn" title="${t('tooltipClose', 'Close')}">✕</button>
        </div>
      </div>
      <div class="card-body">
        <textarea class="card-title-input" rows="1" spellcheck="false" placeholder="${t('placeholderTitle', 'Title...')}">${displayTitle}</textarea>
        <textarea class="card-note-input" placeholder="${t('placeholderNote', '+ Add note...')}">${cardData.note || ''}</textarea>
      </div>
    `;

    const favImg = card.querySelector('.favicon-img');
    if (favImg) {
        favImg.addEventListener('error', function() { this.src = 'icon128.png'; });
    }

    const titleInput = card.querySelector('.card-title-input');
    setTimeout(() => AppUtils.autoResize(titleInput), 0);
    titleInput.addEventListener('input', () => AppUtils.autoResize(titleInput));
    
    let originalTitle = displayTitle;
    titleInput.addEventListener('focus', () => { originalTitle = titleInput.value; });
    titleInput.addEventListener('blur', async () => { 
      if (titleInput.value !== originalTitle) {
        pushToHistory(); 
        cardData.title = titleInput.value; 
        cardData.isCustomTitle = true; 
        if (window.HistoryManager) window.HistoryManager.addLog(`${t('logTitleEdited', '✏️ Изменено: ')}${titleInput.value}`);
        await saveState(false); 
      }
    });
    titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titleInput.blur(); }});

    card.querySelector('.card-domain').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (cardData.tabId && currentProject.isActive) {
        try { 
          await chrome.tabs.update(cardData.tabId, {active: true}); 
          const tab = await chrome.tabs.get(cardData.tabId); 
          await chrome.windows.update(tab.windowId, {focused: true}); 
          return;
        } 
        catch(err) {}
      } 
      const newTab = await chrome.tabs.create({url: cardData.url, active: true});
      if (currentProject.isActive && currentProject.groupId) {
          try {
              await chrome.tabs.group({ tabIds: newTab.id, groupId: currentProject.groupId });
              cardData.tabId = newTab.id;
              cardData.shelf = 'core';
              await saveState(true);
              renderWorkspace();
          } catch(err) {}
      }
    });

    card.querySelector('.card-note-input').addEventListener('change', async (e) => { 
      pushToHistory(); cardData.note = e.target.value; await saveState(false); 
    });

    card.querySelector('.card-remove-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      card.classList.add('closing');
      setTimeout(async () => {
        pushToHistory(); 
        cardData.shelf = 'archive'; 
        cardData.closedAt = Date.now();
        
        if (currentProject.isActive && cardData.tabId) { 
          try { 
            isUpdatingTabs = true; 
            await chrome.tabs.remove(cardData.tabId); 
            cardData.tabId = null; 
          } catch(err){} finally { 
            isUpdatingTabs = false; 
          } 
        }

        // НОВОЕ: Записываем действие в лог при закрытии через Дашборд!
        if (window.HistoryManager) {
          window.HistoryManager.addLog(`${t('logArchived', '📦 Sent to archive: ')}${cardData.domain}`);
        }

        deduplicateArchive();
        await saveState(); 
        renderWorkspace();
      }, 200); 
    });

    card.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('presetname')) { e.preventDefault(); e.stopPropagation(); card.classList.add('drag-over-preset'); }
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over-preset'));
    card.addEventListener('drop', async (e) => {
      const presetName = e.dataTransfer.getData('presetName');
      if (presetName && e.dataTransfer.types.includes('presetname')) { 
        e.preventDefault(); e.stopPropagation(); card.classList.remove('drag-over-preset');
        pushToHistory(); cardData.title = presetName;
        if (window.HistoryManager) window.HistoryManager.addLog(`${t('logTagAdded', '🏷️ Тег: ')}${presetName}`);
        await saveState(); renderWorkspace();
      }
    });

    return card;
  }

  function setupSearch() {
    if(searchInput) {
      searchInput.addEventListener('input', AppUtils.debounce((e) => {
        const term = e.target.value.toLowerCase();
        
        document.querySelectorAll('#section-core .card').forEach(card => {
          const id = card.dataset.id; const data = currentProject.cards.find(c => c.id === id); if (!data) return;
          const textToSearch = `${data.title} ${data.domain} ${data.note || ''}`.toLowerCase();
          const isMatch = textToSearch.includes(term);
          
          // Пустая строка возвращает управление CSS-классам (grid или flex)
          card.style.display = isMatch ? '' : 'none';
          
          if (isMatch) {
              const taTitle = card.querySelector('.card-title-input');
              const taNote = card.querySelector('.card-note-input');
              if (taTitle) AppUtils.autoResize(taTitle);
              if (taNote) AppUtils.autoResize(taNote);
          }
        });
        
        archiveCurrentPage = 1;
        renderArchive();
        initDragAndDrop();
      }, 250));
    }

    ['filter-date', 'filter-title', 'filter-url', 'filter-note'].forEach(id => {
      const el = document.getElementById(id);
      if(el) {
        el.addEventListener('input', AppUtils.debounce(() => {
          archiveCurrentPage = 1;
          renderArchive(); 
          initDragAndDrop();
        }, 250));
      }
    });
  }

  function pushToHistory() { 
    const snapshot = {
       ...currentProject,
      cards: currentProject.cards.map(c => ({...c})), 
      tasks: currentProject.tasks ? currentProject.tasks.map(t => ({...t})) : [],
      activityLog: currentProject.activityLog ? [...currentProject.activityLog] : []
    };
    historyStack.push(snapshot); 
    if (historyStack.length > 10) historyStack.shift(); 
  }

  if (undoBtn) {
    undoBtn.addEventListener('click', async () => {
      // ЗАЩИТА ОТ СПАМА КЛИКАМИ: Игнорируем клик, если процесс отмены уже идет
      if (isUpdatingTabs) return; 
      
      if (historyStack.length === 0) return alert(t('alertHistoryEmpty', 'History is empty.'));
      const previousState = historyStack.pop();
      const survivingLog = [...(currentProject.activityLog || [])];
      
      if (currentProject.isActive) {
        isUpdatingTabs = true;
        try {
          for (const oldCard of previousState.cards) {
            const currentCard = currentProject.cards.find(c => c.id === oldCard.id);
            if (!currentCard) continue;
            if (currentCard.shelf === 'archive' && oldCard.shelf !== 'archive') {
              const newTab = await chrome.tabs.create({ url: oldCard.url, active: false });
              await chrome.tabs.group({ tabIds: newTab.id, groupId: currentProject.groupId });
              oldCard.tabId = newTab.id;
            } else if (currentCard.shelf !== 'archive' && oldCard.shelf === 'archive') {
               if (currentCard.tabId) { await chrome.tabs.remove(currentCard.tabId).catch(()=>{}); }
               oldCard.tabId = null;
            } else if (currentCard.shelf !== 'archive' && oldCard.shelf !== 'archive') {
               oldCard.tabId = currentCard.tabId;
            }
          }
        } finally { isUpdatingTabs = false; }
      }

      currentProject = previousState; currentProject.activityLog = survivingLog;
      if(window.HistoryManager) { window.HistoryManager.project = currentProject; window.HistoryManager.addLog(t('logUndo', '⏪ Отмена'), 'info'); }
      await saveState(true);
      if (window.ConstitutionManager) window.ConstitutionManager.init(currentProject, () => saveState(false), pushToHistory);
      if (window.TaskManager) window.TaskManager.init(currentProject, () => saveState(false), pushToHistory);
      renderWorkspace(); syncTabsOrder();
    });
  }

  let draggedCardEl = null;

  function getDragAfterElement(container, x, y) {
    const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];
    const isList = container.classList.contains('list-view') || container.classList.contains('archive-table');

    return draggableElements.find(child => { 
        const box = child.getBoundingClientRect(); 
        if (isList) {
            return y <= box.top + box.height / 2; 
        } else {
            const inSameRow = y >= box.top && y <= box.bottom;
            if (inSameRow) {
                return x <= box.left + box.width / 2;
            }
            return y < box.top;
        }
    });
  }

  function initDragAndDrop() {
    document.querySelectorAll('.card').forEach(card => {
      if(card.dataset.dragInit) return; card.dataset.dragInit = "true";
      card.addEventListener('dragstart', function(e) { 
        if (!e.target.classList.contains('card-title-input') && 
            !e.target.classList.contains('card-note-input') &&
            !e.target.classList.contains('arch-col-note')) {
          draggedCardEl = this; setTimeout(() => this.classList.add('dragging'), 0); 
        } else { e.preventDefault(); }
      });
      card.addEventListener('dragend', function() { 
        this.classList.remove('dragging'); 
        const archiveZone = document.getElementById('section-other');
        if (archiveZone) archiveZone.classList.remove('archive-active-drop');
        draggedCardEl = null; 
      });
    });
    
    document.querySelectorAll('.drop-zone').forEach(zone => {
      if (zone.dataset.dndInit) return; zone.dataset.dndInit = "true";
      
      zone.addEventListener('dragover', e => {
        if (!draggedCardEl) return; e.preventDefault(); 
        
        const isFromArchive = draggedCardEl.closest('#section-other') !== null;
        
        if (zone.id === 'section-other') {
            if (!isFromArchive) {
                zone.classList.add('archive-active-drop');
                return; 
            } else {
                const table = zone.querySelector('.archive-table');
                if (table) {
                    const afterElement = getDragAfterElement(table, e.clientX, e.clientY);
                    if (afterElement && afterElement.parentNode === table) {
                        table.insertBefore(draggedCardEl, afterElement); 
                    } else {
                        table.appendChild(draggedCardEl);
                    }
                }
                return;
            }
        }
        
        if (zone.id === 'grid-important') {
            const afterElement = getDragAfterElement(zone, e.clientX, e.clientY);
            if (afterElement && afterElement.parentNode === zone) {
                zone.insertBefore(draggedCardEl, afterElement); 
            } else {
                zone.appendChild(draggedCardEl);
            }
        }
      });

      zone.addEventListener('dragleave', e => { 
        if (zone.id === 'section-other') {
          zone.classList.remove('archive-active-drop');
        }
      });

      zone.addEventListener('drop', async function(e) {
        if (!draggedCardEl) return; e.preventDefault(); 
        
        if (this.id === 'section-other') {
          this.classList.remove('archive-active-drop');
        }

        pushToHistory();
        
        let newShelf = 'core'; 
        if (this.id === 'section-other') newShelf = 'archive';
        
        const cardId = draggedCardEl.dataset.id; 
        const cardData = currentProject.cards.find(c => c.id === cardId); 
        const oldShelf = cardData.shelf;
        
        if (newShelf === 'archive' && oldShelf !== 'archive') {
          cardData.closedAt = Date.now();
          if (currentProject.isActive && cardData.tabId) {
            try { isUpdatingTabs = true; await chrome.tabs.remove(cardData.tabId); cardData.tabId = null; } catch (err) {} finally { isUpdatingTabs = false; }
          }
          if (window.HistoryManager) window.HistoryManager.addLog(`${t('logArchived', '📦 Sent to archive: ')}${cardData.domain}`);
        }
        
        if (oldShelf === 'archive' && newShelf !== 'archive' && currentProject.isActive) {
          try {
            isUpdatingTabs = true; const newTab = await chrome.tabs.create({ url: cardData.url, active: false });
            await chrome.tabs.group({ tabIds: newTab.id, groupId: currentProject.groupId }); cardData.tabId = newTab.id; 
            if (window.HistoryManager) window.HistoryManager.addLog(`${t('logTabRestored', '🌐 Tab restored: ')}${cardData.domain}`);
          } catch (err) {} finally { isUpdatingTabs = false; }
        }

        const newCardsArray = [];
        
        document.querySelectorAll('.card').forEach(domCard => {
          const matchedData = currentProject.cards.find(c => c.id === domCard.dataset.id);
          if(matchedData) { 
              if(matchedData.id === cardId) matchedData.shelf = newShelf; 
              newCardsArray.push(matchedData); 
          }
        });
        
        currentProject.cards.forEach(c => {
            if (!newCardsArray.find(nc => nc.id === c.id)) {
                newCardsArray.push(c);
            }
        });

        if (newShelf === 'archive' && oldShelf === 'archive') {
            const archiveCardsNow = newCardsArray.filter(c => c.shelf === 'archive');
            const draggedIdx = archiveCardsNow.findIndex(c => c.id === cardId);
            
            if (draggedIdx === 0) {
                const nextC = archiveCardsNow[1];
                if (nextC) cardData.closedAt = (nextC.closedAt || Date.now()) + 1000;
            } else if (draggedIdx === archiveCardsNow.length - 1) {
                const prevC = archiveCardsNow[draggedIdx - 1];
                if (prevC) cardData.closedAt = (prevC.closedAt || Date.now()) - 1000;
            } else if (draggedIdx > 0) {
                const prevC = archiveCardsNow[draggedIdx - 1];
                const nextC = archiveCardsNow[draggedIdx + 1];
                if (prevC && nextC) {
                    cardData.closedAt = ((prevC.closedAt || Date.now()) + (nextC.closedAt || Date.now())) / 2;
                }
            }
        }

        currentProject.cards = newCardsArray;
        
        deduplicateArchive();
        await saveState(); updateBadges(); syncTabsOrder(); renderWorkspace(); 
      });
    });
  }

  async function syncTabsOrder() {
    if (!currentProject.isActive || !currentProject.groupId || isUpdatingTabs) return;
    try {
      isUpdatingTabs = true; const groupTabs = await chrome.tabs.query({groupId: currentProject.groupId});
      if (groupTabs.length === 0) return;
      let currentIndex = Math.min(...groupTabs.map(t => t.index));
      const currentTab = await chrome.tabs.getCurrent();
      if (currentTab) { await chrome.tabs.move(currentTab.id, { index: currentIndex }); currentIndex++; }
      for (const card of currentProject.cards) {
         if (card.shelf !== 'archive' && card.tabId) {
            try { await chrome.tabs.move(card.tabId, {index: currentIndex}); currentIndex++; } catch(e) { card.tabId = null; }
         }
      }
    } catch(e) {} finally { isUpdatingTabs = false; }
  }

  function updateBadges() {
    const bImp = document.getElementById('badge-important'); const bOth = document.getElementById('badge-other');
    if (bImp) bImp.textContent = currentProject.cards.filter(c => c.shelf === 'core').length;
    if (bOth) bOth.textContent = currentProject.cards.filter(c => c.shelf === 'archive').length;
  }

  function setupLiveListeners() {
    
  let lastHistoryPushTime = 0; // Глобальный таймер для группировки истории (Anti-flood)

  chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    if (removeInfo.isWindowClosing || isUpdatingTabs || !currentProject || !currentProject.isActive) return;
    
    let cardChanged = false; let archivedUrls = [];
    currentProject.cards.forEach(card => {
      if (card.tabId === tabId) { 
        // АНТИ-ФЛУД: Группируем массовое закрытие в один шаг истории
        if (Date.now() - lastHistoryPushTime > 250) {
          pushToHistory();
          lastHistoryPushTime = Date.now();
        }
        
        card.shelf = 'archive'; card.tabId = null; card.closedAt = Date.now();
        archivedUrls.push(card.url); cardChanged = true; 
        
        // НОВОЕ: Записываем действие в визуальный Activity Log!
        if (window.HistoryManager) {
          window.HistoryManager.addLog(`${t('logArchived', '📦 Sent to archive: ')}${card.domain}`);
        }
      }
    });
    
    if (cardChanged) { 
      deduplicateArchive(); 
      await saveState(true); 
      renderWorkspace(); 
    }
  });
    
    let syncTimeout = null;
    const queueSync = () => {
      clearTimeout(syncTimeout);
      syncTimeout = setTimeout(() => syncWithPhysicalGroup(), 800);
    };

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (!currentProject || !currentProject.isActive) return;
      if (tab.groupId === currentProject.groupId) {
        if (isUpdatingTabs) queueSync();
        else syncWithPhysicalGroup();
      }
    });
    
    chrome.tabs.onMoved.addListener(() => { 
      if (!currentProject || !currentProject.isActive) return;
      if (isUpdatingTabs) queueSync();
      else syncWithPhysicalGroup(); 
    });

    chrome.tabGroups.onUpdated.addListener((group) => {
      if (isUpdatingTabs || !currentProject || group.id !== currentProject.groupId) return;
      currentProject.title = group.title || currentProject.title; currentProject.color = group.color; saveState(false); renderWorkspace();
    });

    // =========================================================================
    // 🛡️ НОВОЕ: СЛУШАЕМ ИЗМЕНЕНИЯ ИЗ POPUP (РЕАЛ-ТАЙМ СИНХРОНИЗАЦИЯ)
    // =========================================================================
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'local' && changes.frozenProjects) {
        if (isUpdatingTabs) return; // Игнорируем изменения, которые мы сами же и делаем
        
        const newProjects = changes.frozenProjects.newValue || [];
        const updatedProject = newProjects[parseInt(projectIndex)];
        
        if (updatedProject && currentProject) {
          // Если статус изменился извне (например, разморозили через Popup)
          if (currentProject.isActive !== updatedProject.isActive) {
             currentProject.isActive = updatedProject.isActive;
             currentProject.groupId = updatedProject.groupId;
             renderWorkspace(); // Мгновенно обновляем интерфейс (кнопку и текст)
          }
        }
      }
    });
  }

  document.querySelector('.project-name-input').addEventListener('change', async (e) => { 
    pushToHistory(); 
    currentProject.longTitle = e.target.value; 
    await saveState(); 
    
    // --- НОВОЕ: Синхронизируем длинное имя с Popup для активных групп ---
    if (currentProject.isActive) {
      const data = await chrome.storage.local.get(['projectMetadata']);
      const metadata = data.projectMetadata || {};
      // Ключ, по которому Popup ищет метаданные
      const key = currentProject.title || `Color_${currentProject.color}`;
      metadata[key] = { ...metadata[key], longTitle: e.target.value };
      await chrome.storage.local.set({ projectMetadata: metadata });
    }
  });

  // =========================================================================
  // ⚙️ ГЛОБАЛЬНЫЕ НАСТРОЙКИ WORKSPACE (ЭКСПОРТ, ИМПОРТ, РЕЗЕРВНОЕ ВОССТАНОВЛЕНИЕ)
  // =========================================================================

  // --- ЛОГИКА КНОПКИ "ИНФО" (Как работают бэкапы) ---
  const wsInfoBtnToggle = document.getElementById('ws-info-toggle-btn');
  const wsInfoText = document.getElementById('ws-backup-info-text');
  if (wsInfoBtnToggle && wsInfoText) {
    wsInfoBtnToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      wsInfoText.style.display = wsInfoText.style.display === 'block' ? 'none' : 'block';
    });
  }

  // --- ЛОГИКА ПОЯВЛЕНИЯ КРАСНОЙ КНОПКИ SHADOW BACKUP ---
  async function checkWsShadowBackup() {
    const result = await chrome.storage.local.get(['shadowBackup']);
    const wsEmergencyBtn = document.getElementById('ws-emergency-restore-btn');
    
    if (result.shadowBackup && result.shadowBackup.data && wsEmergencyBtn) {
      const date = new Date(result.shadowBackup.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      wsEmergencyBtn.style.display = 'flex';
      const prefix = t('rescueDataPrefix', 'Rescue Data (Last auto-backup:');
      wsEmergencyBtn.querySelector('.ws-rescue-text').textContent = `${prefix} ${date})`;

      wsEmergencyBtn.onclick = async () => {
        if (confirm(t('confirmRestore', 'WARNING! This will replace your data with the backup.\nContinue?'))) {
          await new Promise(resolve => chrome.runtime.sendMessage({ action: 'OVERWRITE_ALL_PROJECTS', projects: result.shadowBackup.data }, resolve));
          alert(t('alertRestored', '✅ Database successfully restored!'));
          window.location.reload();
        }
      };
    }
  }

  // --- ГЛОБАЛЬНЫЙ ЭКСПОРТ (WORKSPACE) ---
  const wsExportBtn = document.getElementById('ws-export-btn');
  if (wsExportBtn) {
    wsExportBtn.addEventListener('click', async () => {
      const data = await chrome.storage.local.get(['frozenProjects']);
      const projects = data.frozenProjects || [];
      const jsonString = JSON.stringify(projects, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; 
      a.download = `project_freezer_backup_${new Date().toISOString().split('T')[0]}.json`;
      a.click(); 
      URL.revokeObjectURL(url);
    });
  }

  // --- ГЛОБАЛЬНЫЙ ИМПОРТ (WORKSPACE) ---
  const wsImportFile = document.getElementById('ws-import-file');
  if (wsImportFile) {
    wsImportFile.addEventListener('change', async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const importedProjects = JSON.parse(e.target.result);
          if (!Array.isArray(importedProjects)) return alert(t('errFormat', 'Format error'));
          
          const isOverwrite = confirm(t('confirmImportMerge', "Do you want to REPLACE your entire database with this file?\n\n• Click 'OK' to completely OVERWRITE your data.\n• Click 'Cancel' to safely ADD (merge) these projects to your existing list."));

          const payload = { action: 'OVERWRITE_ALL_PROJECTS' };
          
          if (isOverwrite) {
            payload.projects = importedProjects;
          } else {
            const data = await chrome.storage.local.get(['frozenProjects']);
            payload.projects = [...(data.frozenProjects || []), ...importedProjects];
          }
          
          await new Promise(resolve => chrome.runtime.sendMessage(payload, resolve));
          
          alert(t('alertBackupSuccess', "✅ Backup successfully processed!"));
          window.location.reload(); 
        } catch (error) { 
          alert(t('errReadFile', 'Read error')); 
        }
        event.target.value = ''; 
      };
      reader.readAsText(file);
    });
  }

});
