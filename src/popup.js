(() => {
  const configApi = globalThis.VideoArrowRebindConfig;
  const status = document.querySelector('#status');
  const siteSummary = document.querySelector('#site-summary');
  const resetButton = document.querySelector('#reset-button');
  const finishButton = document.querySelector('#finish-button');
  const openOptionsLink = document.querySelector('#open-options-link');

  const fields = {
    enabled: document.querySelector('#enabled'),
    showOverlay: document.querySelector('#showOverlay'),
    shortSeekSeconds: document.querySelector('#shortSeekSeconds'),
    longPressMs: document.querySelector('#longPressMs'),
    fastForwardRate: document.querySelector('#fastForwardRate'),
    fastRewindRate: document.querySelector('#fastRewindRate')
  };

  let statusTimer = null;

  function setStatus(message) {
    status.textContent = message;

    if (statusTimer) {
      window.clearTimeout(statusTimer);
    }

    if (!message) {
      return;
    }

    statusTimer = window.setTimeout(() => {
      status.textContent = '';
    }, 1800);
  }

  function describeSiteMode(settings) {
    if (settings.siteMode === 'all') {
      return '当前为全部网站生效模式。';
    }

    const rules = configApi.getRuleList(settings.siteRules);
    const summary = rules.slice(0, 2).join('、');
    const suffix = rules.length > 2 ? ` 等 ${rules.length} 个站点` : summary || '未填写站点';

    if (settings.siteMode === 'whitelist') {
      return `当前为白名单模式：${suffix}`;
    }

    return `当前为黑名单模式：${suffix}`;
  }

  function fillForm(settings) {
    fields.enabled.checked = settings.enabled;
    fields.showOverlay.checked = settings.showOverlay;
    fields.shortSeekSeconds.value = String(settings.shortSeekSeconds);
    fields.longPressMs.value = String(settings.longPressMs);
    fields.fastForwardRate.value = String(settings.fastForwardRate);
    fields.fastRewindRate.value = String(settings.fastRewindRate);
    siteSummary.textContent = describeSiteMode(settings);
  }

  function readForm(existingSettings) {
    return configApi.normalizeSettings({
      ...existingSettings,
      enabled: fields.enabled.checked,
      showOverlay: fields.showOverlay.checked,
      shortSeekSeconds: fields.shortSeekSeconds.value,
      longPressMs: fields.longPressMs.value,
      fastForwardRate: fields.fastForwardRate.value,
      fastRewindRate: fields.fastRewindRate.value
    });
  }

  async function saveCurrentValues() {
    const currentSettings = await configApi.loadSettings();
    const nextSettings = readForm(currentSettings);
    const savedSettings = await configApi.saveSettings(nextSettings);
    fillForm(savedSettings);
    setStatus('快捷设置已保存');
  }

  async function initialize() {
    const settings = await configApi.loadSettings();
    fillForm(settings);
  }

  Object.values(fields).forEach((field) => {
    field.addEventListener('change', () => {
      saveCurrentValues().catch(() => {
        setStatus('保存失败，请重试');
      });
    });

    if (field.type === 'number') {
      field.addEventListener('blur', () => {
        saveCurrentValues().catch(() => {
          setStatus('保存失败，请重试');
        });
      });
    }
  });

  resetButton.addEventListener('click', async () => {
    const savedSettings = await configApi.saveSettings(configApi.DEFAULT_SETTINGS);
    fillForm(savedSettings);
    setStatus('已恢复默认设置');
  });

  finishButton.addEventListener('click', () => {
    window.close();
  });

  openOptionsLink.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  initialize().catch(() => {
    setStatus('快捷设置加载失败');
  });
})();