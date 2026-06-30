window.AppUtils = {
  // Тайм-аут для запросов
  withTimeout: (promise, ms) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
    ]);
  },

  // Умный генератор градиентов на основе домена
  getSmartGradient: (url, domain) => {
    const urlStr = url.toLowerCase();
    if (urlStr.includes('docs.google.com/spreadsheets')) return 'linear-gradient(135deg, #0f9d58 0%, #b7e1cd 100%)';
    if (urlStr.includes('docs.google.com/document')) return 'linear-gradient(135deg, #4285f4 0%, #aecbfa 100%)';
    if (urlStr.includes('docs.google.com/presentation')) return 'linear-gradient(135deg, #f4b400 0%, #fce8b2 100%)';
    if (domain.includes('github.com')) return 'linear-gradient(135deg, #24292e 0%, #959da5 100%)';
    if (domain.includes('figma.com')) return 'linear-gradient(135deg, #f24e1e 0%, #ff7262 50%, #1abc9c 100%)';

    let hash = 0;
    for (let i = 0; i < domain.length; i++) hash = domain.charCodeAt(i) + ((hash << 5) - hash);
    const colors = [
      'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)', 'linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)',
      'linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)', 'linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)',
      'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)', 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)'
    ];
    return colors[Math.abs(hash) % colors.length];
  },

  // Очистка длинных заголовков
  getCleanTitle: (title, url) => {
    let t = title || url;
    t = t.replace(/ - Google (Docs|Sheets|Slides|Forms)/i, '');
    if (t.startsWith('http')) {
      try {
        const u = new URL(url);
        const pathParts = u.pathname.split('/').filter(p => p && p.length > 1 && p !== 'edit' && p !== 'view');
        if (pathParts.length > 0) return decodeURIComponent(pathParts.pop()).replace(/[-_]/g, ' ');
        return u.hostname;
      } catch(e) { return t; }
    }
    return t;
  },

  // Безопасное получение домена
  getSafeDomain: (url) => {
    if (!url || typeof url !== 'string') return 'Link';
    try { return new URL(url).hostname || 'Link'; } catch(e) { return 'Link'; }
  },

  // Нормализация URL для дедупликации (оставляем хэши для SPA, чистим UTM)
  getNormalizedUrl: (urlStr) => {
    if (!urlStr) return '';
    try {
      const u = new URL(urlStr);
      // Удаляем только маркетинговые метрики, оставляем якоря (#node-id)
      const params = new URLSearchParams(u.search);
      Array.from(params.keys()).forEach(key => {
          if (key.startsWith('utm_') || key === 'fbclid' || key === 'gclid') params.delete(key);
      });
      u.search = params.toString();
      return u.toString().replace(/\/$/, ""); 
    } catch(e) { return urlStr; }
  },

  // Задержка для поиска (чтобы не тормозил интерфейс при вводе)
  debounce: (func, wait) => {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  },

  // Авто-ресайз текстовых полей
  autoResize: (textarea) => {
    textarea.style.height = 'auto'; 
    textarea.style.height = textarea.scrollHeight + 'px';
  }
};