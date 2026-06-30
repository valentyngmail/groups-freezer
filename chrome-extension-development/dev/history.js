window.HistoryManager = {
  project: null,
  saveCallback: null,

  init(project, saveCallback) {
    this.project = project;
    this.saveCallback = saveCallback;
    
    // FIX: Only create a new array if one doesn't exist. Never wipe existing logs!
    this.project.activityLog = this.project.activityLog || []; 
    
    // We also removed the redundant this.saveCallback() here so it doesn't spam the database on load
    this.render();
  },

  addLog(message, type = 'info') {
    // ИСПРАВЛЕНИЕ: Убрал 'ru-RU', чтобы время форматировалось под язык системы
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.project.activityLog.unshift({ time, message, type });

    if (this.project.activityLog.length > 10) {
      this.project.activityLog.pop();
    }
    this.saveCallback();
    this.render();
  },

  async render() {
    // Убеждаемся, что словари загружены перед отрисовкой
    if (window.I18nManager) await window.I18nManager.init();
    
    const container = document.getElementById('activity-log-container');
    if (!container) return;
    
    container.innerHTML = '';

    if (this.project.activityLog.length === 0) {
      const emptyText = window.I18nManager ? window.I18nManager.getMessage('logEmpty') : 'Log is empty.';
      container.innerHTML = `<div style="color: #9ca3af; font-size: 12px; padding: 10px 0;">${emptyText}</div>`;
      return;
    }

    this.project.activityLog.forEach(log => {
      const div = document.createElement('div');
      div.className = 'history-item';
      const textColor = log.type === 'error' ? 'color: #ef4444; font-weight: 500;' : '';
      
      div.innerHTML = `
        <div class="history-time">${log.time}</div>
        <div style="font-size: 13px; line-height: 1.4; ${textColor}">${log.message}</div>
      `;
      container.appendChild(div);
    });
  }
};
