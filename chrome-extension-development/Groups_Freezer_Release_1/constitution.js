window.ConstitutionManager = {
  project: null, saveCallback: null, historyCallback: null, timeout: null,

  init(project, saveCallback, historyCallback) {
    this.project = project; this.saveCallback = saveCallback; this.historyCallback = historyCallback;
    if (typeof this.project.constitution !== 'string') this.project.constitution = '';

    const textarea = document.getElementById('constitution-text');
    if (!textarea) return;
    textarea.value = this.project.constitution;
    let originalText = textarea.value;

    textarea.addEventListener('focus', () => { originalText = this.project.constitution; });

    textarea.addEventListener('blur', (e) => {
      if (originalText !== e.target.value) {
        if (this.historyCallback) this.historyCallback();
        if (window.HistoryManager) window.HistoryManager.addLog(window.I18nManager.getMessage('logConstUpdated'));
      }
    });

    textarea.addEventListener('input', (e) => {
      this.project.constitution = e.target.value;
      if (this.timeout) clearTimeout(this.timeout);
      this.timeout = setTimeout(() => { this.saveCallback(); }, 500);
    });
  }
};