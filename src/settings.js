(() => {
  const STORAGE_KEY = 'videoArrowRebindSettings';
  const DEFAULT_SETTINGS = {
    enabled: true,
    showOverlay: true,
    shortSeekSeconds: 5,
    longPressMs: 280,
    fastForwardRate: 3,
    playbackLockSeekMultiplier: null,
    fastRewindRate: 3,
    siteMode: 'all',
    siteRules: ''
  };

  function getStorageArea() {
    return globalThis.chrome?.storage?.sync ?? null;
  }

  function clampNumber(value, fallback, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return fallback;
    }

    return Math.min(Math.max(numeric, min), max);
  }

  function clampOptionalNumber(value, fallback, min, max) {
    if (value === '' || value === null || typeof value === 'undefined') {
      return fallback;
    }

    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return fallback;
    }

    return Math.min(Math.max(numeric, min), max);
  }

  function normalizeSiteRules(siteRules) {
    return String(siteRules ?? '')
      .split(/[,\n]/)
      .map((entry) => normalizeRule(entry))
      .filter(Boolean)
      .filter((entry, index, list) => list.indexOf(entry) === index)
      .join('\n');
  }

  function normalizeRule(rule) {
    const trimmed = String(rule ?? '').trim().toLowerCase();
    if (!trimmed) {
      return '';
    }

    if (trimmed === '*') {
      return '*';
    }

    try {
      const url = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed.replace(/^\*\./, '')}`);
      return url.hostname.replace(/^www\./, '').replace(/\.$/, '');
    } catch {
      return trimmed
        .replace(/^\*\./, '')
        .replace(/^www\./, '')
        .replace(/\/$/, '')
        .replace(/\.$/, '');
    }
  }

  function normalizeSettings(rawSettings = {}) {
    return {
      enabled: rawSettings.enabled !== false,
      showOverlay: rawSettings.showOverlay !== false,
      shortSeekSeconds: clampNumber(rawSettings.shortSeekSeconds, DEFAULT_SETTINGS.shortSeekSeconds, 1, 60),
      longPressMs: clampNumber(rawSettings.longPressMs, DEFAULT_SETTINGS.longPressMs, 120, 1200),
      fastForwardRate: clampNumber(rawSettings.fastForwardRate, DEFAULT_SETTINGS.fastForwardRate, 1.25, 16),
      playbackLockSeekMultiplier: clampOptionalNumber(rawSettings.playbackLockSeekMultiplier, null, 1, 16),
      fastRewindRate: clampNumber(rawSettings.fastRewindRate, DEFAULT_SETTINGS.fastRewindRate, 1.25, 16),
      siteMode: ['all', 'whitelist', 'blacklist'].includes(rawSettings.siteMode) ? rawSettings.siteMode : DEFAULT_SETTINGS.siteMode,
      siteRules: normalizeSiteRules(rawSettings.siteRules)
    };
  }

  function loadSettings() {
    const storage = getStorageArea();
    if (!storage) {
      return Promise.resolve({ ...DEFAULT_SETTINGS });
    }

    return new Promise((resolve) => {
      storage.get(STORAGE_KEY, (result) => {
        resolve(normalizeSettings(result?.[STORAGE_KEY]));
      });
    });
  }

  function saveSettings(nextSettings) {
    const storage = getStorageArea();
    const normalized = normalizeSettings(nextSettings);
    if (!storage) {
      return Promise.resolve(normalized);
    }

    return new Promise((resolve) => {
      storage.set({ [STORAGE_KEY]: normalized }, () => {
        resolve(normalized);
      });
    });
  }

  function getRuleList(siteRules) {
    return normalizeSiteRules(siteRules)
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  function doesHostMatchRule(hostname, rule) {
    const normalizedHost = normalizeRule(hostname);
    if (!normalizedHost || !rule) {
      return false;
    }

    if (rule === '*') {
      return true;
    }

    return normalizedHost === rule || normalizedHost.endsWith(`.${rule}`);
  }

  function isCurrentSiteAllowed(settings, hostname = globalThis.location?.hostname ?? '') {
    const normalized = normalizeSettings(settings);
    if (normalized.siteMode === 'all') {
      return true;
    }

    const rules = getRuleList(normalized.siteRules);
    const matched = rules.some((rule) => doesHostMatchRule(hostname, rule));

    if (normalized.siteMode === 'whitelist') {
      return matched;
    }

    return !matched;
  }

  globalThis.VideoArrowRebindConfig = {
    STORAGE_KEY,
    DEFAULT_SETTINGS,
    normalizeSettings,
    loadSettings,
    saveSettings,
    getRuleList,
    isCurrentSiteAllowed
  };
})();
