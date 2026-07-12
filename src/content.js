(() => {
  const HOLD_REWIND_INTERVAL_MS = 100;
  const MIN_VIDEO_WIDTH = 160;
  const MIN_VIDEO_HEIGHT = 90;
  const BILIBILI_SUBTITLE_BUTTON_SELECTOR = '.bpx-player-ctrl-btn.bpx-player-ctrl-subtitle, .bpx-player-ctrl-subtitle';
  const BILIBILI_SUBTITLE_ICON_SELECTOR = '.bpx-player-ctrl-btn-icon > span, .bpx-player-ctrl-btn-icon';
  const BILIBILI_SUBTITLE_MENU_ITEM_SELECTOR =
    '.bpx-player-ctrl-subtitle-language-item, .bpx-player-ctrl-subtitle-language-item-text, [class*="subtitle-language-item"]';
  const BILIBILI_SUBTITLE_TEXT_SELECTOR = '.bpx-player-subtitle-panel-text, [class*="subtitle-panel-text"]';
  const BILIBILI_VIDEO_SELECTOR = 'div.bpx-player-video-perch video, .bpx-player-video-wrap video, video';
  const AUTO_SUBTITLE_RETRY_INTERVAL_MS = 350;
  const AUTO_SUBTITLE_RETRY_LIMIT = 60;
  const AUTO_SUBTITLE_CLICK_COOLDOWN_MS = 1200;
  const configApi = globalThis.VideoArrowRebindConfig;

  let activeHold = null;
  let overlayState = null;
  let playbackLockState = null;
  const pressedArrowKeys = new Set();
  let arrowSpeedLockLatched = false;
  let settings = configApi?.DEFAULT_SETTINGS ?? {
    enabled: true,
    showOverlay: true,
    shortSeekSeconds: 5,
    longPressMs: 280,
    fastForwardRate: 3,
    playbackLockSeekMultiplier: null,
    autoBilibiliSubtitle: false,
    fastRewindRate: 3,
    siteMode: 'all',
    siteRules: ''
  };
  const autoSubtitleState = {
    observer: null,
    retryTimer: null,
    retryDueAt: 0,
    retryCount: 0,
    video: null,
    metadataHandler: null,
    urlTimer: null,
    lastHref: window.location.href,
    lastActivationKey: '',
    lastActivationAt: 0,
    lastFallbackActivationKey: '',
    lastNotifiedKey: '',
    needsMediaReactivation: false
  };

  function getHoldOverlayCopy(key) {
    if (key === 'ArrowRight') {
      return {
        title: `${settings.fastForwardRate}x 倍速快进中`,
        detail: '松开右方向键恢复原速'
      };
    }

    return {
      title: `${settings.fastRewindRate}x 快退中`,
      detail: '松开左方向键停止快退'
    };
  }

  function getPlaybackLockOverlayCopy() {
    const seekMultiplier = getEffectivePlaybackLockSeekMultiplier();

    return {
      title: `已锁定 ${settings.fastForwardRate}x 倍速播放`,
      detail: `短按左右方向键按 ${formatSeconds(settings.shortSeekSeconds * seekMultiplier)} 秒跳转，同时按下上下方向键可解除`
    };
  }

  function getEffectivePlaybackLockSeekMultiplier() {
    return settings.playbackLockSeekMultiplier ?? settings.fastForwardRate;
  }

  function formatSeconds(value) {
    if (!Number.isFinite(value)) {
      return '0';
    }

    const rounded = Math.round(value * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '');
  }

  function refreshOverlayForCurrentState() {
    if (!overlayState?.root?.classList.contains('is-visible')) {
      return;
    }

    if (!settings.showOverlay) {
      hideOverlay();
      return;
    }

    if (activeHold?.longPressActive) {
      const overlayCopy = getHoldOverlayCopy(activeHold.key);
      showOverlay(overlayCopy.title, overlayCopy.detail, true, 0, false, activeHold.video);
      return;
    }

    if (playbackLockState?.video?.isConnected) {
      const overlayCopy = getPlaybackLockOverlayCopy();
      showOverlay(overlayCopy.title, overlayCopy.detail, true, 0, false, playbackLockState.video);
      return;
    }

    hideOverlay();
  }

  function applySettings(nextSettings) {
    settings = configApi?.normalizeSettings ? configApi.normalizeSettings(nextSettings) : nextSettings;

    if (
      playbackLockState &&
      (!settings.enabled ||
        (configApi?.isCurrentSiteAllowed &&
          !configApi.isCurrentSiteAllowed(settings, window.location.hostname)))
    ) {
      clearPlaybackLock(false);
    }

    if (
      playbackLockState?.video?.isConnected &&
      Number.isFinite(settings.fastForwardRate) &&
      settings.fastForwardRate > 0
    ) {
      enforcePlaybackLock(playbackLockState.video);
    }

    refreshOverlayForCurrentState();
    syncAutoSubtitleAutomation();
  }

  if (configApi?.loadSettings) {
    configApi.loadSettings().then(applySettings).catch(() => {});
  }

  if (globalThis.chrome?.storage?.onChanged) {
    globalThis.chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync' || !changes.videoArrowRebindSettings) {
        return;
      }

      applySettings(changes.videoArrowRebindSettings.newValue);
    });
  }

  function isEditableTarget(target) {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    if (target.isContentEditable) {
      return true;
    }

    const editableAncestor = target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
    );

    return Boolean(editableAncestor);
  }

  function isVideoUsable(video) {
    if (!(video instanceof HTMLVideoElement)) {
      return false;
    }

    if (!video.isConnected || video.readyState === 0) {
      return false;
    }

    const rect = video.getBoundingClientRect();
    if (rect.width < MIN_VIDEO_WIDTH || rect.height < MIN_VIDEO_HEIGHT) {
      return false;
    }

    const style = window.getComputedStyle(video);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }

    return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function getPreferredVideo() {
    const videos = Array.from(document.querySelectorAll('video')).filter(isVideoUsable);

    if (videos.length === 0) {
      return null;
    }

    const playingVideo = videos.find((video) => !video.paused && !video.ended);
    if (playingVideo) {
      return playingVideo;
    }

    return videos.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
    })[0];
  }

  function isBilibiliVideoPage() {
    const hostname = window.location.hostname.replace(/^www\./, '');
    const isBilibiliHost = hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com');
    const isKnownPlayerPath = window.location.pathname.startsWith('/video/') || window.location.pathname.startsWith('/bangumi/play/');
    return isBilibiliHost && (isKnownPlayerPath || Boolean(document.querySelector('.bpx-player-container')));
  }

  function shouldAutoEnableBilibiliSubtitle() {
    if (!settings.enabled || !settings.autoBilibiliSubtitle || !isBilibiliVideoPage()) {
      return false;
    }

    return !(configApi?.isCurrentSiteAllowed && !configApi.isCurrentSiteAllowed(settings, window.location.hostname));
  }

  function getBilibiliVideo() {
    return getPreferredVideo() || document.querySelector(BILIBILI_VIDEO_SELECTOR);
  }

  function findBilibiliSubtitleButton() {
    return Array.from(document.querySelectorAll(BILIBILI_SUBTITLE_BUTTON_SELECTOR)).find((button) => button.isConnected) ?? null;
  }

  function hasShowingTextTrack(video) {
    try {
      return Array.from(video?.textTracks ?? []).some((track) => track.mode === 'showing');
    } catch {
      return false;
    }
  }

  function hasVisibleBilibiliSubtitleText() {
    return Array.from(document.querySelectorAll(BILIBILI_SUBTITLE_TEXT_SELECTOR)).some((element) => {
      if (!element.isConnected) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
  }

  function dispatchMouseEvent(element, type, relatedTarget = null) {
    if (!(element instanceof Element)) {
      return;
    }

    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        relatedTarget
      })
    );
  }

  function pulseBilibiliPlayer() {
    const player = document.querySelector('.bpx-player-container, .bpx-player-video-wrap, video');
    ['mouseenter', 'mouseover', 'mousemove'].forEach((eventName) => dispatchMouseEvent(player, eventName));
  }

  function openBilibiliSubtitleMenu(button) {
    pulseBilibiliPlayer();
    ['mouseenter', 'mouseover', 'mousemove'].forEach((eventName) => dispatchMouseEvent(button, eventName));
  }

  function closeBilibiliSubtitleMenu(button) {
    window.setTimeout(() => {
      if (!button?.isConnected) {
        return;
      }

      const player = document.querySelector('.bpx-player-container, .bpx-player-video-wrap, video');
      const menu = button.querySelector('.bpx-player-ctrl-subtitle-menu, .bpx-player-ctrl-subtitle-box');
      ['mouseout', 'mouseleave', 'pointerout', 'pointerleave'].forEach((eventName) => {
        dispatchMouseEvent(menu, eventName, player);
        dispatchMouseEvent(button, eventName, player);
      });

      // 把播放器的悬停状态落回视频区域，只显示控制栏，不点击视频以免暂停。
      ['mouseover', 'mousemove'].forEach((eventName) => dispatchMouseEvent(player, eventName, button));
    }, 100);
  }

  function getPreferredBilibiliSubtitleMenuItem() {
    const menuItems = Array.from(document.querySelectorAll(BILIBILI_SUBTITLE_MENU_ITEM_SELECTOR))
      .map((item) => item.closest('.bpx-player-ctrl-subtitle-language-item') || item)
      .filter((item, index, list) => item.isConnected && list.indexOf(item) === index)
      .map((item) => ({ item, text: String(item.textContent || '').trim() }))
      .filter(({ text }) => text && !/关闭|off|none|无字幕|不显示/i.test(text));

    return (
      menuItems.find(({ text }) => /^中文$|简体|繁体|中[国文]|Chinese/i.test(text))?.item ||
      menuItems.find(({ text }) => /中文|字幕|AI|自动/i.test(text))?.item ||
      menuItems[0]?.item ||
      null
    );
  }

  function getBilibiliSubtitleStatus(button, video) {
    if (!button) {
      return 'unknown';
    }

    if (
      button.matches('.bpx-state-disabled, .disabled, .is-disabled, [aria-disabled="true"]') ||
      button.closest('[aria-disabled="true"]')
    ) {
      return 'unavailable';
    }

    // B 站会给当前选中的“关闭”项加 bpx-state-active。不能再用按钮内
    // 任意 active 子节点判断字幕已开启，否则关闭状态会被稳定地误判为开启。
    if (
      button.querySelector(
        '.bpx-player-ctrl-subtitle-close-switch.bpx-state-active, .bpx-player-ctrl-subtitle-close-switch.active'
      )
    ) {
      return 'off';
    }

    if (hasVisibleBilibiliSubtitleText() || hasShowingTextTrack(video)) {
      return 'on';
    }

    if (
      button.matches('.bpx-state-active, .active, .is-active, [aria-pressed="true"], [data-state="active"]') ||
      button.querySelector(
        '.bpx-player-ctrl-subtitle-language-item.bpx-state-active, .bpx-player-ctrl-subtitle-language-item.active'
      )
    ) {
      return 'on';
    }

    const statusText = [
      button.getAttribute('aria-label'),
      button.getAttribute('aria-checked'),
      button.getAttribute('aria-pressed'),
      button.getAttribute('title'),
      button.getAttribute('data-title'),
      button.getAttribute('data-state'),
      button.textContent
    ]
      .filter(Boolean)
      .join(' ');

    if (/关闭字幕|字幕已开|已开启字幕|隐藏字幕|subtitles?\s*on|captions?\s*on/i.test(statusText)) {
      return 'on';
    }

    if (/开启字幕|打开字幕|显示字幕|字幕已关|未开启字幕|subtitles?\s*off|captions?\s*off/i.test(statusText)) {
      return 'off';
    }

    return 'unknown';
  }

  function getBilibiliSubtitleActivationKey(video) {
    const source = video?.currentSrc || video?.src || '';
    const duration = Number.isFinite(video?.duration) ? video.duration : '';
    return `${window.location.href}|${source}|${duration}`;
  }

  function showAutoSubtitleOverlay(video, activationKey) {
    if (autoSubtitleState.lastNotifiedKey === activationKey) {
      return;
    }

    autoSubtitleState.lastNotifiedKey = activationKey;
    showOverlay('已自动打开字幕', 'B 站自动播放或切换视频后已尝试开启字幕', true, 1400, false, video);
  }

  function tryEnableBilibiliSubtitle() {
    if (!shouldAutoEnableBilibiliSubtitle()) {
      return true;
    }

    const video = getBilibiliVideo();
    const button = findBilibiliSubtitleButton();
    if (!button) {
      return false;
    }

    const status = getBilibiliSubtitleStatus(button, video);
    if (status === 'unavailable' || (status === 'on' && !autoSubtitleState.needsMediaReactivation)) {
      return true;
    }

    const activationKey = getBilibiliSubtitleActivationKey(video);
    if (
      autoSubtitleState.lastActivationKey === activationKey &&
      Date.now() - autoSubtitleState.lastActivationAt < AUTO_SUBTITLE_CLICK_COOLDOWN_MS
    ) {
      return false;
    }

    openBilibiliSubtitleMenu(button);

    const menuItem = getPreferredBilibiliSubtitleMenuItem();
    if (menuItem) {
      autoSubtitleState.lastActivationKey = activationKey;
      autoSubtitleState.lastActivationAt = Date.now();
      autoSubtitleState.needsMediaReactivation = false;
      menuItem.click();
      closeBilibiliSubtitleMenu(button);
      showAutoSubtitleOverlay(video, activationKey);
      return false;
    }

    // B 站切集时旧字幕文本和按钮激活态可能会短暂残留。此时直接点击
    // 字幕按钮反而可能把字幕关闭，因此等语言菜单渲染后再明确选择一项。
    if (autoSubtitleState.needsMediaReactivation && status === 'on') {
      return false;
    }

    const clickTarget = button.querySelector(BILIBILI_SUBTITLE_ICON_SELECTOR) || button;
    if (autoSubtitleState.lastFallbackActivationKey === activationKey) {
      return false;
    }

    autoSubtitleState.lastActivationKey = activationKey;
    autoSubtitleState.lastActivationAt = Date.now();
    autoSubtitleState.lastFallbackActivationKey = activationKey;
    autoSubtitleState.needsMediaReactivation = false;
    clickTarget.click();
    showAutoSubtitleOverlay(video, activationKey);
    scheduleAutoSubtitleCheck(1000);
    return true;
  }

  function scheduleAutoSubtitleCheck(delay = AUTO_SUBTITLE_RETRY_INTERVAL_MS) {
    if (!shouldAutoEnableBilibiliSubtitle()) {
      return;
    }

    const dueAt = Date.now() + delay;
    if (autoSubtitleState.retryTimer) {
      // B 站的弹幕和播放器 DOM 会持续变化。保留已经安排且更早的检查，
      // 避免 MutationObserver 不断重置定时器导致字幕逻辑永远得不到执行。
      if (autoSubtitleState.retryDueAt <= dueAt) {
        return;
      }

      window.clearTimeout(autoSubtitleState.retryTimer);
    }

    autoSubtitleState.retryDueAt = dueAt;

    autoSubtitleState.retryTimer = window.setTimeout(() => {
      autoSubtitleState.retryTimer = null;
      autoSubtitleState.retryDueAt = 0;
      syncAutoSubtitleVideoListener();

      if (tryEnableBilibiliSubtitle()) {
        autoSubtitleState.retryCount = 0;
        return;
      }

      if (autoSubtitleState.retryCount < AUTO_SUBTITLE_RETRY_LIMIT) {
        autoSubtitleState.retryCount += 1;
        scheduleAutoSubtitleCheck();
      }
    }, delay);
  }

  function syncAutoSubtitleVideoListener() {
    const video = shouldAutoEnableBilibiliSubtitle() ? getBilibiliVideo() : null;
    if (autoSubtitleState.video === video) {
      return;
    }

    if (autoSubtitleState.video && autoSubtitleState.metadataHandler) {
      autoSubtitleState.video.removeEventListener('loadstart', autoSubtitleState.metadataHandler);
      autoSubtitleState.video.removeEventListener('loadedmetadata', autoSubtitleState.metadataHandler);
    }

    autoSubtitleState.video = video;
    autoSubtitleState.metadataHandler = null;

    if (!video) {
      return;
    }

    autoSubtitleState.metadataHandler = () => {
      autoSubtitleState.retryCount = 0;
      autoSubtitleState.lastActivationKey = '';
      autoSubtitleState.lastFallbackActivationKey = '';
      autoSubtitleState.lastNotifiedKey = '';
      autoSubtitleState.needsMediaReactivation = true;
      scheduleAutoSubtitleCheck(1000);
    };
    video.addEventListener('loadstart', autoSubtitleState.metadataHandler);
    video.addEventListener('loadedmetadata', autoSubtitleState.metadataHandler);
  }

  function syncAutoSubtitleUrlWatcher() {
    if (!shouldAutoEnableBilibiliSubtitle()) {
      if (autoSubtitleState.urlTimer) {
        window.clearInterval(autoSubtitleState.urlTimer);
        autoSubtitleState.urlTimer = null;
      }

      return;
    }

    if (autoSubtitleState.urlTimer) {
      return;
    }

    autoSubtitleState.urlTimer = window.setInterval(() => {
      if (autoSubtitleState.lastHref === window.location.href) {
        return;
      }

      autoSubtitleState.lastHref = window.location.href;
      autoSubtitleState.retryCount = 0;
      autoSubtitleState.lastActivationKey = '';
      autoSubtitleState.lastFallbackActivationKey = '';
      autoSubtitleState.lastNotifiedKey = '';
      autoSubtitleState.needsMediaReactivation = true;
      syncAutoSubtitleVideoListener();
      scheduleAutoSubtitleCheck(1000);
    }, 1000);
  }

  function syncAutoSubtitleAutomation() {
    if (!shouldAutoEnableBilibiliSubtitle()) {
      if (autoSubtitleState.retryTimer) {
        window.clearTimeout(autoSubtitleState.retryTimer);
        autoSubtitleState.retryTimer = null;
        autoSubtitleState.retryDueAt = 0;
      }

      if (autoSubtitleState.observer) {
        autoSubtitleState.observer.disconnect();
        autoSubtitleState.observer = null;
      }

      syncAutoSubtitleUrlWatcher();
      syncAutoSubtitleVideoListener();
      return;
    }

    if (!autoSubtitleState.observer && document.documentElement) {
      autoSubtitleState.observer = new MutationObserver(() => {
        syncAutoSubtitleVideoListener();
        scheduleAutoSubtitleCheck(120);
      });
      autoSubtitleState.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-label', 'aria-pressed', 'class', 'data-state', 'title']
      });
    }

    syncAutoSubtitleUrlWatcher();
    syncAutoSubtitleVideoListener();
    autoSubtitleState.retryCount = 0;
    scheduleAutoSubtitleCheck(1000);
  }

  function clampTime(video, nextTime) {
    const duration = Number.isFinite(video.duration) ? video.duration : Number.MAX_SAFE_INTEGER;
    return Math.min(Math.max(nextTime, 0), duration);
  }

  function resolveOverlayMount(video = null) {
    if (document.fullscreenElement instanceof Element) {
      return document.fullscreenElement;
    }

    const rootNode = video?.getRootNode?.();
    if (rootNode instanceof ShadowRoot && rootNode.host instanceof Element) {
      return rootNode.host;
    }

    if (video?.parentElement instanceof Element) {
      return video.parentElement;
    }

    return document.body || document.documentElement;
  }

  function ensureOverlay(video = null) {
    const mount = resolveOverlayMount(video);
    if (!mount) {
      return null;
    }

    if (overlayState?.root) {
      if (!overlayState.root.isConnected || overlayState.mount !== mount) {
        mount.appendChild(overlayState.root);
        overlayState.mount = mount;
      }

      return overlayState;
    }

    const root = document.createElement('div');
    root.className = 'video-arrow-rebind-overlay';

    const title = document.createElement('div');
    title.className = 'video-arrow-rebind-title';

    const detail = document.createElement('div');
    detail.className = 'video-arrow-rebind-detail';

    root.append(title, detail);

    mount.appendChild(root);
    overlayState = {
      root,
      title,
      detail,
      hideTimer: null,
      mount
    };

    return overlayState;
  }

  function showOverlay(
    message,
    detailText,
    accent = false,
    duration = 750,
    restorePersistentState = false,
    anchorVideo = null
  ) {
    if (!settings.showOverlay) {
      return;
    }

    const overlay = ensureOverlay(anchorVideo);
    if (!overlay) {
      return;
    }

    overlay.title.textContent = message;
    overlay.detail.textContent = detailText || '';
    overlay.root.classList.toggle('is-accent', accent);
    overlay.root.classList.add('is-visible');

    if (overlay.hideTimer) {
      window.clearTimeout(overlay.hideTimer);
      overlay.hideTimer = null;
    }

    if (duration > 0) {
      overlay.hideTimer = window.setTimeout(() => {
        overlay.hideTimer = null;
        if (restorePersistentState) {
          refreshOverlayForCurrentState();
          return;
        }

        overlay.root.classList.remove('is-visible');
      }, duration);
    }
  }

  function hideOverlay() {
    if (!overlayState) {
      return;
    }

    if (overlayState.hideTimer) {
      window.clearTimeout(overlayState.hideTimer);
      overlayState.hideTimer = null;
    }

    overlayState.root.classList.remove('is-visible');
  }

  function clearPlaybackLock(showMessage = false) {
    if (!playbackLockState) {
      return;
    }

    const lockedVideo = playbackLockState.video;
    if (playbackLockState.enforcementTimer) {
      window.clearInterval(playbackLockState.enforcementTimer);
    }

    if (lockedVideo?.isConnected) {
      lockedVideo.playbackRate = playbackLockState.originalPlaybackRate ?? 1;
      lockedVideo.defaultPlaybackRate = playbackLockState.originalDefaultPlaybackRate ?? 1;
    }

    playbackLockState = null;

    if (showMessage) {
      showOverlay('已解除倍速锁定', '同时按下上下方向键可再次开启', false, 900, false, lockedVideo);
    }
  }

  function togglePlaybackLock(video) {
    if (!video) {
      return false;
    }

    if (playbackLockState?.video === video) {
      clearPlaybackLock(true);
      return true;
    }

    clearPlaybackLock(false);
    playbackLockState = {
      video,
      originalPlaybackRate: video.playbackRate,
      originalDefaultPlaybackRate: video.defaultPlaybackRate,
      enforcementTimer: null
    };
    video.defaultPlaybackRate = settings.fastForwardRate;
    video.playbackRate = settings.fastForwardRate;
    playbackLockState.enforcementTimer = window.setInterval(() => {
      enforcePlaybackLock();
    }, 250);

    const overlayCopy = getPlaybackLockOverlayCopy();
    showOverlay(overlayCopy.title, overlayCopy.detail, true, 0, false, video);
    return true;
  }

  function enforcePlaybackLock(video = null) {
    if (!playbackLockState) {
      return;
    }

    const nextVideo = video instanceof HTMLVideoElement && video.isConnected
      ? video
      : getPreferredVideo() || playbackLockState.video;
    if (!(nextVideo instanceof HTMLVideoElement) || !nextVideo.isConnected) {
      return;
    }

    if (playbackLockState.video !== nextVideo) {
      playbackLockState.video = nextVideo;
      playbackLockState.originalPlaybackRate = nextVideo.playbackRate;
      playbackLockState.originalDefaultPlaybackRate = nextVideo.defaultPlaybackRate;
      ensureOverlay(nextVideo);
    }

    if (nextVideo.defaultPlaybackRate !== settings.fastForwardRate) {
      nextVideo.defaultPlaybackRate = settings.fastForwardRate;
    }

    if (nextVideo.playbackRate !== settings.fastForwardRate) {
      nextVideo.playbackRate = settings.fastForwardRate;
    }
  }

  function schedulePlaybackLockEnforcement(video, delays = [0]) {
    delays.forEach((delay) => {
      window.setTimeout(() => enforcePlaybackLock(video), delay);
    });
  }

  function stopEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function seekVideo(video, deltaSeconds) {
    const nextTime = clampTime(video, video.currentTime + deltaSeconds);
    const actualDelta = nextTime - video.currentTime;
    video.currentTime = nextTime;

    if (actualDelta === 0) {
      return;
    }

    const directionText = actualDelta > 0 ? '快进' : '快退';
    const isPlaybackLockSeeking = playbackLockState?.video === video;
    const detailText = isPlaybackLockSeeking
      ? `当前仍保持 ${settings.fastForwardRate}x 倍速锁定`
      : `短按方向键：固定跳转 ${formatSeconds(settings.shortSeekSeconds)} 秒`;

    showOverlay(
      `${directionText} ${formatSeconds(Math.abs(actualDelta))}s`,
      detailText,
      isPlaybackLockSeeking,
      isPlaybackLockSeeking ? 900 : 750,
      isPlaybackLockSeeking,
      video
    );
  }

  function getSeekDeltaSeconds(key, video) {
    const multiplier = playbackLockState?.video === video ? getEffectivePlaybackLockSeekMultiplier() : 1;
    const direction = key === 'ArrowRight' ? 1 : -1;
    return direction * settings.shortSeekSeconds * multiplier;
  }

  function beginLongPress(holdState) {
    const { key, video } = holdState;
    holdState.longPressActive = true;

    if (key === 'ArrowRight') {
      holdState.originalPlaybackRate = video.playbackRate;
      holdState.wasPausedBeforeFastForward = video.paused;
      video.playbackRate = settings.fastForwardRate;

      if (video.paused) {
        const playPromise = video.play();
        if (playPromise?.catch) {
          playPromise.catch(() => {});
        }
      }

      const overlayCopy = getHoldOverlayCopy(key);
      showOverlay(overlayCopy.title, overlayCopy.detail, true, 0, false, holdState.video);
      return;
    }

    holdState.wasPausedBeforeRewind = video.paused;
    if (!video.paused) {
      video.pause();
    }

    holdState.rewindTimer = window.setInterval(() => {
      const stepSeconds = settings.fastRewindRate * (HOLD_REWIND_INTERVAL_MS / 1000);
      video.currentTime = clampTime(video, video.currentTime - stepSeconds);
    }, HOLD_REWIND_INTERVAL_MS);

    const overlayCopy = getHoldOverlayCopy(key);
    showOverlay(overlayCopy.title, overlayCopy.detail, true, 0, false, holdState.video);
  }

  function clearHoldState(applyShortPress) {
    if (!activeHold) {
      return;
    }

    const holdState = activeHold;
    activeHold = null;

    if (holdState.longPressTimer) {
      window.clearTimeout(holdState.longPressTimer);
    }

    if (holdState.rewindTimer) {
      window.clearInterval(holdState.rewindTimer);
    }

    if (holdState.longPressActive) {
      if (holdState.key === 'ArrowRight') {
        holdState.video.playbackRate = holdState.originalPlaybackRate ?? 1;
        if (holdState.wasPausedBeforeFastForward && !holdState.video.paused) {
          holdState.video.pause();
        }
      } else if (!holdState.wasPausedBeforeRewind) {
        const playPromise = holdState.video.play();
        if (playPromise?.catch) {
          playPromise.catch(() => {});
        }
      }

      if (playbackLockState?.video === holdState.video) {
        const overlayCopy = getPlaybackLockOverlayCopy();
        showOverlay(overlayCopy.title, overlayCopy.detail, true, 0, false, holdState.video);
        return;
      }

      showOverlay(
        '已恢复正常播放',
        `短按左右方向键可跳转 ${settings.shortSeekSeconds} 秒`,
        false,
        550,
        false,
        holdState.video
      );
      return;
    }

    if (applyShortPress) {
      const deltaSeconds = getSeekDeltaSeconds(holdState.key, holdState.video);
      seekVideo(holdState.video, deltaSeconds);
      return;
    }

    hideOverlay();
  }

  function shouldHandleKey(event) {
    if (!settings.enabled) {
      return false;
    }

    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return false;
    }

    if (event.altKey || event.ctrlKey || event.metaKey) {
      return false;
    }

    if (isEditableTarget(event.target)) {
      return false;
    }

    if (configApi?.isCurrentSiteAllowed && !configApi.isCurrentSiteAllowed(settings, window.location.hostname)) {
      return false;
    }

    return Boolean(getPreferredVideo());
  }

  function shouldHandlePlaybackLockKey(event) {
    if (!settings.enabled) {
      return false;
    }

    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      return false;
    }

    if (event.altKey || event.ctrlKey || event.metaKey) {
      return false;
    }

    if (isEditableTarget(event.target)) {
      return false;
    }

    if (configApi?.isCurrentSiteAllowed && !configApi.isCurrentSiteAllowed(settings, window.location.hostname)) {
      return false;
    }

    return Boolean(getPreferredVideo());
  }

  ['loadstart', 'loadedmetadata', 'play', 'playing', 'ratechange'].forEach((eventName) => {
    window.addEventListener(
      eventName,
      (event) => {
        if (!playbackLockState || !(event.target instanceof HTMLVideoElement)) {
          return;
        }

        if (event.target !== playbackLockState.video && !isVideoUsable(event.target)) {
          return;
        }

        if (eventName === 'ratechange') {
          if (event.target.playbackRate !== settings.fastForwardRate) {
            schedulePlaybackLockEnforcement(event.target);
          }
          return;
        }

        // B 站会在换源后的多个阶段再次写回默认倍速，因此在媒体事件发生时
        // 立即恢复，并在播放器初始化完成后的两个时间点再次确认。
        schedulePlaybackLockEnforcement(event.target, [0, 250, 1000]);
      },
      true
    );
  });

  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const canHandlePlaybackLockKey = shouldHandlePlaybackLockKey(event);
        const otherArrowKey = event.key === 'ArrowUp' ? 'ArrowDown' : 'ArrowUp';
        const wasOtherArrowPressed = pressedArrowKeys.has(otherArrowKey);
        pressedArrowKeys.add(event.key);

        if (!canHandlePlaybackLockKey) {
          return;
        }

        stopEvent(event);

        if (arrowSpeedLockLatched) {
          return;
        }

        if (!event.repeat && wasOtherArrowPressed) {
          if (activeHold) {
            clearHoldState(false);
          }

          togglePlaybackLock(getPreferredVideo());
          arrowSpeedLockLatched = true;
          return;
        }
      }

      if (!shouldHandleKey(event)) {
        return;
      }

      if (activeHold?.key === event.key) {
        stopEvent(event);
        return;
      }

      if (event.repeat) {
        stopEvent(event);
        return;
      }

      const video = getPreferredVideo();
      if (!video) {
        return;
      }

      stopEvent(event);

      if (activeHold) {
        clearHoldState(false);
      }

      activeHold = {
        key: event.key,
        video,
        longPressActive: false,
        longPressTimer: window.setTimeout(() => {
          if (!activeHold || activeHold.key !== event.key || activeHold.video !== video) {
            return;
          }

          beginLongPress(activeHold);
        }, settings.longPressMs),
        rewindTimer: null,
        originalPlaybackRate: null,
        wasPausedBeforeRewind: false,
        wasPausedBeforeFastForward: false
      };
    },
    true
  );

  window.addEventListener(
    'keyup',
    (event) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        pressedArrowKeys.delete(event.key);

        if (!shouldHandlePlaybackLockKey(event)) {
          return;
        }

        stopEvent(event);

        if (arrowSpeedLockLatched) {
          if (!pressedArrowKeys.has('ArrowUp') && !pressedArrowKeys.has('ArrowDown')) {
            arrowSpeedLockLatched = false;
          }
        }

        return;
      }

      if (!activeHold || activeHold.key !== event.key) {
        return;
      }

      stopEvent(event);
      clearHoldState(true);
    },
    true
  );

  window.addEventListener(
    'fullscreenchange',
    () => {
      if (!overlayState?.root) {
        return;
      }

      ensureOverlay(activeHold?.video || playbackLockState?.video || getPreferredVideo());
      refreshOverlayForCurrentState();
    },
    true
  );

  window.addEventListener(
    'blur',
    () => {
      pressedArrowKeys.clear();
      arrowSpeedLockLatched = false;
      clearHoldState(false);
    },
    true
  );
})();
