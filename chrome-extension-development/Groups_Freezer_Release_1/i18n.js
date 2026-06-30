window.I18nManager = {
  locale: 'en',
  messages: {},
  isLoaded: null,

  async init() {
    if (this.isLoaded) return this.isLoaded;
    
    this.isLoaded = (async () => {
      const data = await chrome.storage.local.get(['userLocale']);
      let browserLang = chrome.i18n.getUILanguage().split('-')[0];
      const supported = ['en', 'ru', 'uk', 'de'];
      if (!supported.includes(browserLang)) browserLang = 'en';

      this.locale = data.userLocale || browserLang;

      try {
        const url = chrome.runtime.getURL(`_locales/${this.locale}/messages.json`);
        const response = await fetch(url);
        this.messages = await response.json();
      } catch (e) {
        const url = chrome.runtime.getURL(`_locales/en/messages.json`);
        const response = await fetch(url);
        this.messages = await response.json();
      }

      this.translatePage();
      this.setupSwitcher();
    })();

    return this.isLoaded;
  },

  getMessage(key) {
    return this.messages[key] ? this.messages[key].message : '';
  },

  translatePage() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const msg = this.getMessage(el.getAttribute('data-i18n'));
      if (msg) {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          el.placeholder = msg;
        } else {
          el.innerHTML = msg;
        }
      }
    });

    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const msg = this.getMessage(el.getAttribute('data-i18n-title'));
      if (msg) el.title = msg;
    });
  },

  setupSwitcher() {
    document.querySelectorAll('.language-switcher').forEach(select => {
      select.value = this.locale;
      select.addEventListener('change', async (e) => {
        await chrome.storage.local.set({ userLocale: e.target.value });
        window.location.reload();
      });
    });
  }
};

document.addEventListener('DOMContentLoaded', () => {
  window.I18nManager.init();
});