window.TaskManager = {
  project: null, saveCallback: null, historyCallback: null, draggedTaskIndex: null,

  init(project, saveCallback, historyCallback) {
    this.project = project; this.saveCallback = saveCallback; this.historyCallback = historyCallback;
    if (!Array.isArray(this.project.tasks)) this.project.tasks = [];
    this.setupUI(); this.render();
  },

  setupUI() {
    const addBtn = document.getElementById('add-task-btn');
    const input = document.getElementById('new-task-input');
    if (addBtn && input) {
      addBtn.onclick = () => { this.addTask(input.value); input.value = ''; };
      input.onkeypress = (e) => { if (e.key === 'Enter') addBtn.click(); };
    }
  },

  addTask(text) {
    const val = text.trim();
    if (!val) return;
    if (this.historyCallback) this.historyCallback();
    this.project.tasks.push({ id: 'task_' + Math.random().toString(36).substr(2, 9), text: val, completed: false });
    if (window.HistoryManager) window.HistoryManager.addLog(`${window.I18nManager.getMessage('logTaskAdded')}${val}`);
    this.saveCallback(); this.render();
  },

  deleteTask(index) {
    if (this.historyCallback) this.historyCallback();
    this.project.tasks.splice(index, 1);
    if (window.HistoryManager) window.HistoryManager.addLog(window.I18nManager.getMessage('logTaskDeleted'));
    this.saveCallback(); this.render();
  },

  toggleTask(index, isCompleted) {
    if (this.historyCallback) this.historyCallback();
    this.project.tasks[index].completed = isCompleted;
    const msgKey = isCompleted ? 'logTaskDone' : 'logTaskUndone';
    if (window.HistoryManager) window.HistoryManager.addLog(window.I18nManager.getMessage(msgKey));
    this.saveCallback(); this.render();
  },

  updateTaskText(index, newText) {
    if (this.project.tasks[index].text !== newText) {
      if (this.historyCallback) this.historyCallback();
      this.project.tasks[index].text = newText;
      if (window.HistoryManager) window.HistoryManager.addLog(window.I18nManager.getMessage('logTaskEdited'));
      this.saveCallback();
    }
  },

  render() {
    const container = document.getElementById('task-list-container');
    if (!container) return;
    container.innerHTML = '';

    // Получаем переведенный текст для тултипа удаления
    const deleteText = window.I18nManager ? window.I18nManager.getMessage('tooltipDelete') : 'Delete';

    this.project.tasks.forEach((task, index) => {
      const li = document.createElement('li');
      li.className = `task-item ${task.completed ? 'completed' : ''}`;
      li.draggable = true; li.dataset.index = index;
      li.innerHTML = `
        <input type="checkbox" class="task-checkbox" ${task.completed ? 'checked' : ''}>
        <span class="task-text" contenteditable="true" spellcheck="false">${task.text}</span>
        <button class="task-delete-btn" title="${deleteText}">✕</button>
      `;

      li.querySelector('.task-checkbox').addEventListener('change', (e) => { this.toggleTask(index, e.target.checked); });
      
      const textSpan = li.querySelector('.task-text');
      textSpan.addEventListener('blur', (e) => { this.updateTaskText(index, e.target.innerText.trim()); });
      textSpan.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); textSpan.blur(); }
      });

      li.querySelector('.task-delete-btn').addEventListener('click', () => { this.deleteTask(index); });
      this.setupDragAndDrop(li, index);
      container.appendChild(li);
    });
  },

  setupDragAndDrop(el, originalIndex) {
    el.addEventListener('dragstart', (e) => {
      this.draggedTaskIndex = originalIndex;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', originalIndex);
      el.classList.add('dragging');
    });
    el.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.add('drag-over-top'); });
    el.addEventListener('dragleave', (e) => { e.stopPropagation(); el.classList.remove('drag-over-top'); });
    el.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation(); el.classList.remove('drag-over-top');
      const fromIndex = this.draggedTaskIndex; const toIndex = originalIndex;
      if (fromIndex !== null && fromIndex !== toIndex) {
        if (this.historyCallback) this.historyCallback();
        const [moved] = this.project.tasks.splice(fromIndex, 1);
        this.project.tasks.splice(toIndex, 0, moved);
        if (window.HistoryManager) window.HistoryManager.addLog(window.I18nManager.getMessage('logTaskReordered'));
        this.saveCallback(); this.render();
      }
      this.draggedTaskIndex = null;
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      document.querySelectorAll('.task-item').forEach(i => i.classList.remove('drag-over-top'));
      this.draggedTaskIndex = null;
    });
  }
};