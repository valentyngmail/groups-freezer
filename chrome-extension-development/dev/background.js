// background.js - Единый центр управления и транзакций (Firewall)

class AsyncLock {
  constructor() { this.queue = Promise.resolve(); }
  acquire(task) {
    return new Promise((resolve, reject) => {
      this.queue = this.queue.then(async () => {
        try { resolve(await task()); } catch (e) { console.error("[Lock Error]:", e); reject(e); }
      });
    });
  }
}
const storageLock = new AsyncLock();

// Утилиты для безопасного парсинга URL
function getSafeUrl(url) { return (url && typeof url === 'string') ? url : 'about:blank'; }
function getSafeDomain(url) {
  if (!url || typeof url !== 'string') return 'Link';
  try { return new URL(url).hostname || 'Link'; } catch(e) { return 'Link'; }
}

// ==============================================================================
// БЛОК 1: ТЕНЕВЫЕ БЭКАПЫ (С ОТЛОЖЕННЫМ ЗАПУСКОМ)
// ==============================================================================
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('daily-backup', { periodInMinutes: 1440 });
  setTimeout(performBackup, 5000); 
});

chrome.runtime.onStartup.addListener(() => {
  setTimeout(performBackup, 15000);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'daily-backup') performBackup();
});

function performBackup() {
  storageLock.acquire(async () => {
    const data = await chrome.storage.local.get(['frozenProjects']);
    const currentProjects = data.frozenProjects || [];
    if (currentProjects.length > 0) {
      await chrome.storage.local.set({ shadowBackup: { timestamp: Date.now(), data: currentProjects } });
      console.log('Shadow backup created successfully:', new Date().toLocaleString());
    }
  });
}

// ==============================================================================
// БЛОК 2: АТОМАРНЫЕ ТРАНЗАКЦИИ И ТЯЖЕЛЫЕ ОПЕРАЦИИ В ФОНЕ
// ==============================================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  
  const executeTask = async (taskFn) => {
    try {
      const result = await storageLock.acquire(taskFn);
      sendResponse({ success: true, ...result });
    } catch (err) {
      console.error("[Firewall Error]:", err);
      sendResponse({ success: false, error: err.message });
    }
  };

  if (request.action === 'SAVE_WORKSPACE_STATE') {
    executeTask(async () => {
      const data = await chrome.storage.local.get(['frozenProjects']);
      let projects = data.frozenProjects || [];
      let targetIndex = request.index;
      let currentInDb = projects[targetIndex];

      // ЗАЩИТА ОТ СДВИГА ИНДЕКСОВ: Ищем проект по ID группы или заголовку+дате
      if (!currentInDb || (currentInDb.groupId !== request.project.groupId && currentInDb.date !== request.project.date)) {
        targetIndex = projects.findIndex(p => 
            (p.groupId && request.project.groupId && p.groupId === request.project.groupId) || 
            (p.title === request.project.title && p.date === request.project.date)
        );
        currentInDb = targetIndex !== -1 ? projects[targetIndex] : null;
      }

      if (currentInDb) {
        if (currentInDb.isActive === false && request.project.isActive === true) {
          console.warn(`[Firewall] BLOCKED corrupted save from dying workspace: ${request.project.title}`);
          return { status: 'blocked_phantom' }; 
        }
        projects[targetIndex] = request.project;
        await chrome.storage.local.set({ frozenProjects: projects });
        return { status: 'saved', correctedIndex: targetIndex };
      }
      return { status: 'not_found' };
    });
    return true; 
  }

  // 🔥 НОВАЯ ЛОГИКА ЗАМОРОЗКИ В ФОНЕ (Service Worker)
  if (request.action === 'PROCESS_FREEZE') {
    executeTask(async () => {
      const data = await chrome.storage.local.get(['frozenProjects']);
      let projects = data.frozenProjects || [];
      let existingIndex = projects.findIndex(p => p.groupId === request.group.id && p.isActive);
      
      const existingProject = existingIndex !== -1 ? projects[existingIndex] : null;
      const existingCards = existingProject ? (existingProject.cards || []) : [];
      
      const cardsData = [];
      const tabIdsToRemove = [];

      // Обрабатываем вкладки параллельно (с лимитом) для скорости
      const processTab = async (t) => {
        let currentUrl = t.url || t.pendingUrl || '';
        
        // Обязательно добавляем дашборд в очередь на удаление!
        if (currentUrl.includes('workspace.html')) {
           tabIdsToRemove.push(t.id);
           return; // Но пропускаем создание карточки для него
        }
        
        tabIdsToRemove.push(t.id);
        let safeUrl = getSafeUrl(currentUrl);
        
        if (safeUrl === 'about:blank' || safeUrl === '') {
            const oldCard = existingCards.find(c => c.tabId === t.id);
            if (oldCard && oldCard.url && oldCard.url !== 'about:blank') safeUrl = oldCard.url;
        }
        
        let meta = { desc: '', img: '' };
        // Пропускаем тяжелые PDF и локальные файлы, чтобы не вешать executeScript
        const isHeavyOrSystem = safeUrl.startsWith('chrome://') || safeUrl.toLowerCase().endsWith('.pdf') || safeUrl === 'about:blank';
        
        if (!isHeavyOrSystem && t.status === 'complete') {
          try {
            const scriptPromise = chrome.scripting.executeScript({
              target: { tabId: t.id },
              func: () => {
                const getM = (n) => {
                  const el = document.querySelector(`meta[name="${n}"], meta[property="${n}"]`);
                  if(!el) return '';
                  let c = el.getAttribute('content');
                  if(n.includes('image') && c && !c.startsWith('http')) { try{ c = new URL(c, window.location.href).href; }catch(e){} }
                  return c;
                };
                return { desc: getM('description') || getM('og:description') || '', img: getM('og:image') || getM('twitter:image') || '' };
              }
            }).catch(()=>null);
            
            // Ждем максимум 500мс (ускорили с 800мс)
            const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 500));
            const res = await Promise.race([scriptPromise, timeoutPromise]);
            if(res && res[0] && res[0].result) meta = res[0].result;
          } catch(e) {} 
        }
        
        cardsData.push({
          id: 'card_' + Math.random().toString(36).substr(2, 9), url: safeUrl, domain: getSafeDomain(safeUrl), 
          title: t.title || safeUrl, note: (meta.desc || '').substring(0, 150), cover: meta.img || '', 
          shelf: 'core', tabId: null, closedAt: Date.now(), isProcessing: false
        });
      };

      // Ждем завершения сбора данных по всем вкладкам
      await Promise.all(request.tabs.map(t => processTab(t)));

      // Восстанавливаем архив
      const archiveCards = existingCards.filter(c => c.shelf === 'archive');
      for (const arcCard of archiveCards) {
          if (!cardsData.find(c => c.id === arcCard.id)) cardsData.push(arcCard);
      }

      // Обновляем БД
      if (existingIndex !== -1) {
        let proj = projects[existingIndex];
        proj.isActive = false; proj.groupId = null; proj.cards = cardsData;
        proj.urls = cardsData.map(c => c.url); proj.date = Date.now();
        proj.longTitle = request.longTitle || proj.longTitle;
        projects.splice(existingIndex, 1); projects.unshift(proj);
      } else {
        const newProj = { 
          title: request.group.title || 'Untitled', color: request.group.color, urls: cardsData.map(c => c.url), 
          date: Date.now(), longTitle: request.longTitle, isActive: false, groupId: null, cards: cardsData
        };
        projects.unshift(newProj);
      }
      
      await chrome.storage.local.set({ frozenProjects: projects });

      // Закрываем вкладки ПОСЛЕ сохранения в базу (надежность!)
      if (tabIdsToRemove.length > 0) {
        // Получаем все вкладки в текущем окне
        const windowTabs = await chrome.tabs.query({ currentWindow: true });
        const activeTabId = windowTabs.find(t => t.active)?.id;

        // Проверяем, закрываем ли мы ВООБЩЕ ВСЕ вкладки в окне
        const closingAll = windowTabs.every(t => tabIdsToRemove.includes(t.id));

        if (closingAll) {
            // Если мы убиваем всё окно, создаем пустую вкладку-спасатель
            await chrome.tabs.create({ active: true });
        } else if (activeTabId && tabIdsToRemove.includes(activeTabId)) {
            // Если мы закрываем активную вкладку, но есть другие — просто переключаемся на первую "выжившую"
            const survivorTab = windowTabs.find(t => !tabIdsToRemove.includes(t.id));
            if (survivorTab) {
                await chrome.tabs.update(survivorTab.id, { active: true }).catch(()=>{});
            }
        }

        await chrome.tabs.remove(tabIdsToRemove).catch(e => console.warn("Tabs remove error:", e));
      }
      return { status: 'frozen' };
    });
    return true;
  }

  // 🔥 НОВАЯ ЛОГИКА РАЗМОРОЗКИ В ФОНЕ
  if (request.action === 'PROCESS_RESTORE') {
    executeTask(async () => {
      const data = await chrome.storage.local.get(['frozenProjects']);
      let projects = data.frozenProjects || [];
      const project = projects[request.index];
      
      if (!project) throw new Error("Project not found");

      const tabIds = []; 
      let newCards = project.cards || [];
      
      // Создаем вкладки (Background Worker не умрет в процессе)
      for (let card of newCards) {
        if (card.shelf !== 'archive') {
          const safeUrl = getSafeUrl(card.url);
          try {
            const tab = await chrome.tabs.create({ url: safeUrl, active: false });
            card.tabId = tab.id; tabIds.push(tab.id);
          } catch (e) {
             const tab = await chrome.tabs.create({ active: false });
             card.tabId = tab.id; tabIds.push(tab.id);
          }
        }
      }

      if (tabIds.length === 0) { const tab = await chrome.tabs.create({ active: false }); tabIds.push(tab.id); }

      const groupId = await chrome.tabs.group({ tabIds: tabIds });
      await chrome.tabGroups.update(groupId, { title: project.title, color: project.color }).catch(()=>{});
      
      project.isActive = true;
      project.groupId = groupId;
      project.cards = newCards;
      
      await chrome.storage.local.set({ frozenProjects: projects });

      // Создаем ИЛИ находим Workspace-вкладку (Безрисковый Анти-дубликатор)
      const workspaceUrl = chrome.runtime.getURL(`workspace.html?index=${request.index}`);
      const existingWsTabs = await chrome.tabs.query({ url: workspaceUrl });
      
      let wsTabId;
      if (existingWsTabs.length > 0) {
        wsTabId = existingWsTabs[0].id;
        // Фокусируем пользователя на уже открытой вкладке
        await chrome.tabs.update(wsTabId, { active: true }).catch(()=>{});
      } else {
        const newWsTab = await chrome.tabs.create({ url: workspaceUrl, active: true });
        wsTabId = newWsTab.id;
      }

      // Добавляем вкладку в группу
      await chrome.tabs.group({ tabIds: wsTabId, groupId: groupId }).catch(()=>{});
      
      // Ставим воркспейс на самое первое место
      const groupTabsAfter = await chrome.tabs.query({ groupId: groupId });
      const targetMinIndex = groupTabsAfter.length > 0 ? Math.min(...groupTabsAfter.map(t => t.index)) : 0;
      await chrome.tabs.move(wsTabId, { index: targetMinIndex }).catch(()=>{});

      return { status: 'restored' };
    });
    return true;
  }

  if (request.action === 'DELETE_GROUP') {
    executeTask(async () => {
      const data = await chrome.storage.local.get(['frozenProjects']);
      let projects = data.frozenProjects || [];
      projects.splice(request.index, 1);
      await chrome.storage.local.set({ frozenProjects: projects });
    });
    return true;
  }

  if (request.action === 'MOVE_FROZEN_GROUP') {
    executeTask(async () => {
      const data = await chrome.storage.local.get(['frozenProjects']);
      let projects = data.frozenProjects || [];
      const itemToMove = projects.splice(request.sourceIndex, 1)[0];
      if (itemToMove) {
        projects.splice(request.targetIndex, 0, itemToMove);
        await chrome.storage.local.set({ frozenProjects: projects });
      }
    });
    return true;
  }

  if (request.action === 'OVERWRITE_ALL_PROJECTS') {
    executeTask(async () => {
      await chrome.storage.local.set({ frozenProjects: request.projects });
    });
    return true;
  }
});
