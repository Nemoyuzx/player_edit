(() => {
  const HOLD_REWIND_INTERVAL_MS = 100;
  const MIN_VIDEO_WIDTH = 160;
  const MIN_VIDEO_HEIGHT = 90;
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
    fastRewindRate: 3,
    siteMode: 'all',
    siteRules: ''
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
      playbackLockState.video.playbackRate = settings.fastForwardRate;
    }

    refreshOverlayForCurrentState();
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
    if (lockedVideo?.isConnected) {
      lockedVideo.playbackRate = playbackLockState.originalPlaybackRate ?? 1;
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
      originalPlaybackRate: video.playbackRate
    };
    video.playbackRate = settings.fastForwardRate;

    const overlayCopy = getPlaybackLockOverlayCopy();
    showOverlay(overlayCopy.title, overlayCopy.detail, true, 0, false, video);
    return true;
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
