(() => {
  const configApi = globalThis.VideoArrowRebindConfig;
  const form = document.querySelector('#settings-form');
  const status = document.querySelector('#status');
  const resetButton = document.querySelector('#reset-button');
  const siteModeInput = document.querySelector('#siteMode');
  const siteRulesInput = document.querySelector('#siteRules');

  const fields = {
    enabled: document.querySelector('#enabled'),
    showOverlay: document.querySelector('#showOverlay'),
    shortSeekSeconds: document.querySelector('#shortSeekSeconds'),
    longPressMs: document.querySelector('#longPressMs'),
    fastForwardRate: document.querySelector('#fastForwardRate'),
    fastRewindRate: document.querySelector('#fastRewindRate'),
    siteMode: siteModeInput,
    siteRules: siteRulesInput
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
    }, 2200);
  }

  function syncRuleFieldState() {
    const disabled = siteModeInput.value === 'all';
    siteRulesInput.disabled = disabled;
    siteRulesInput.placeholder = disabled
      ? '当前模式下不需要填写站点列表'
      : '每行一个域名，例如：\nbilibili.com\nyoutube.com';
  }

  function fillForm(settings) {
    fields.enabled.checked = settings.enabled;
    fields.showOverlay.checked = settings.showOverlay;
    fields.shortSeekSeconds.value = String(settings.shortSeekSeconds);
    fields.longPressMs.value = String(settings.longPressMs);
    fields.fastForwardRate.value = String(settings.fastForwardRate);
    fields.fastRewindRate.value = String(settings.fastRewindRate);
    fields.siteMode.value = settings.siteMode;
    fields.siteRules.value = settings.siteRules;
    syncRuleFieldState();
  }

  function readForm() {
    return configApi.normalizeSettings({
      enabled: fields.enabled.checked,
      showOverlay: fields.showOverlay.checked,
      shortSeekSeconds: fields.shortSeekSeconds.value,
      longPressMs: fields.longPressMs.value,
      fastForwardRate: fields.fastForwardRate.value,
      fastRewindRate: fields.fastRewindRate.value,
      siteMode: fields.siteMode.value,
      siteRules: fields.siteRules.value
    });
  }

  async function initialize() {
    const settings = await configApi.loadSettings();
    fillForm(settings);
  }

  siteModeInput.addEventListener('change', syncRuleFieldState);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const settings = readForm();
    await configApi.saveSettings(settings);
    fillForm(settings);
    setStatus('设置已保存');
  });

  resetButton.addEventListener('click', async () => {
    await configApi.saveSettings(configApi.DEFAULT_SETTINGS);
    fillForm(configApi.DEFAULT_SETTINGS);
    setStatus('已恢复默认设置');
  });

  initialize().catch(() => {
    setStatus('设置加载失败，请刷新后重试');
  });
})();