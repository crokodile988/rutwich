const viewerState = {
  flvPlayer: null,
  heartbeatTimer: 0,
  mediaConfig: null,
  mediaConfigPromise: null,
  roomId: "",
  roomInfo: null,
  roomsPollTimer: 0,
  viewerId: ""
};

const viewerElements = {
  connectButton: document.getElementById("connectButton"),
  currentStreamSubtitle: document.getElementById("currentStreamSubtitle"),
  currentStreamTitle: document.getElementById("currentStreamTitle"),
  disconnectButton: document.getElementById("disconnectButton"),
  joinedRoomValue: document.getElementById("joinedRoomValue"),
  remoteOverlay: document.getElementById("remoteOverlay"),
  remoteVideo: document.getElementById("remoteVideo"),
  roomInput: document.getElementById("roomInput"),
  streamHeadline: document.getElementById("streamHeadline"),
  streamMetaLine: document.getElementById("streamMetaLine"),
  streamStatusValue: document.getElementById("streamStatusValue"),
  upNextCount: document.getElementById("upNextCount"),
  upNextList: document.getElementById("upNextList"),
  viewerMessage: document.getElementById("viewerMessage"),
  watchHomeMessage: document.getElementById("watchHomeMessage"),
  watchSearchInput: document.getElementById("watchSearchInput")
};

function normalizeRoomId(value) {
  return String(value || "").trim().toLowerCase();
}

function setViewerMessage(text, tone = "") {
  viewerElements.viewerMessage.textContent = text;
  viewerElements.viewerMessage.className = tone ? `message ${tone}` : "message";
}

function setViewerStatus(text) {
  viewerElements.streamStatusValue.textContent = text;
}

function setOverlayBadge(text) {
  viewerElements.remoteOverlay.innerHTML = `<div class="video-chip">${text}</div>`;
}

function setWatchHomeMessage(text, tone = "") {
  viewerElements.watchHomeMessage.textContent = text;
  viewerElements.watchHomeMessage.className = tone ? `message ${tone}` : "message";
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed with status ${response.status}.`);
  }

  return data;
}

async function loadMediaConfig(force = false) {
  if (viewerState.mediaConfigPromise && !force) {
    return viewerState.mediaConfigPromise;
  }

  viewerState.mediaConfigPromise = requestJson("/api/media-config")
    .then((data) => {
      viewerState.mediaConfig = data;
      return data;
    })
    .catch((error) => {
      viewerState.mediaConfig = null;
      throw error;
    });

  return viewerState.mediaConfigPromise;
}

function formatLiveAge(startedAt) {
  if (!startedAt) {
    return "ещё не вышел в live";
  }

  const minutes = Math.max(1, Math.floor((Date.now() - startedAt) / 60000));
  if (minutes < 60) {
    return `${minutes} мин в эфире`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours} ч ${restMinutes} мин в эфире`;
}

function hashHue(value) {
  let hash = 0;

  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }

  return hash;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildThumbStyle(roomId) {
  const firstHue = hashHue(roomId);
  const secondHue = (firstHue + 70) % 360;

  return `background:
    radial-gradient(circle at 22% 18%, hsla(${firstHue}, 82%, 64%, 0.34), transparent 28%),
    radial-gradient(circle at 84% 20%, hsla(${secondHue}, 72%, 62%, 0.24), transparent 28%),
    linear-gradient(135deg, hsl(${firstHue}, 68%, 22%), hsl(${secondHue}, 52%, 12%));`;
}

function syncRoomInputs() {
  viewerElements.roomInput.value = viewerState.roomId || viewerElements.roomInput.value;
  viewerElements.watchSearchInput.value = viewerState.roomId || viewerElements.watchSearchInput.value;
}

function applyRoomInfo(room) {
  viewerState.roomInfo = room;
  viewerState.roomId = normalizeRoomId(room.roomId);
  viewerElements.joinedRoomValue.textContent = room.roomId;
  viewerElements.currentStreamTitle.textContent = room.title || "Подключение к эфиру";
  viewerElements.currentStreamSubtitle.textContent = room.hostOnline
    ? "RTMP live активен на сервере"
    : "Комната найдена, но эфир ещё не отмечен как live";
  viewerElements.streamHeadline.textContent = room.title || "Стрим";
  viewerElements.streamMetaLine.textContent =
    `${room.hostOnline ? "Серверный поток активен" : "Ожидаем публикацию"} • ${formatLiveAge(room.startedAt)}`;
  syncRoomInputs();
}

async function fetchRoomInfo(roomId) {
  const room = await requestJson(`/api/rooms/${encodeURIComponent(normalizeRoomId(roomId))}`);
  applyRoomInfo(room);
  return room;
}

function buildPlaybackUrl(roomId) {
  return `${viewerState.mediaConfig.flvBaseUrl}/${encodeURIComponent(roomId)}.flv`;
}

function destroyPlayer() {
  if (!viewerState.flvPlayer) {
    viewerElements.remoteVideo.removeAttribute("src");
    viewerElements.remoteVideo.load();
    return;
  }

  try {
    viewerState.flvPlayer.pause();
  } catch {}

  try {
    viewerState.flvPlayer.unload();
  } catch {}

  try {
    viewerState.flvPlayer.detachMediaElement();
  } catch {}

  try {
    viewerState.flvPlayer.destroy();
  } catch {}

  viewerState.flvPlayer = null;
  viewerElements.remoteVideo.removeAttribute("src");
  viewerElements.remoteVideo.load();
}

function stopViewerHeartbeat() {
  window.clearTimeout(viewerState.heartbeatTimer);
  viewerState.heartbeatTimer = 0;
}

async function heartbeatViewer() {
  if (!viewerState.roomId || !viewerState.viewerId) {
    return;
  }

  try {
    await requestJson(
      `/api/rooms/${encodeURIComponent(viewerState.roomId)}/events` +
      `?clientId=${encodeURIComponent(viewerState.viewerId)}&after=0`
    );
    await fetchRoomInfo(viewerState.roomId);
  } catch (error) {
    console.error("Viewer heartbeat error:", error);
  } finally {
    stopViewerHeartbeat();
    viewerState.heartbeatTimer = window.setTimeout(heartbeatViewer, 10000);
  }
}

function startViewerHeartbeat() {
  stopViewerHeartbeat();
  viewerState.heartbeatTimer = window.setTimeout(heartbeatViewer, 1000);
}

function connectFlvPlayer(roomId) {
  if (!window.flvjs) {
    throw new Error("flv.js не загружен. Установи зависимости и перезапусти сервер.");
  }

  if (!window.flvjs.isSupported()) {
    throw new Error("Этот браузер не поддерживает HTTP-FLV через MediaSource.");
  }

  destroyPlayer();

  const player = window.flvjs.createPlayer(
    {
      isLive: true,
      type: "flv",
      url: buildPlaybackUrl(roomId)
    },
    {
      enableWorker: false,
      lazyLoad: false,
      stashInitialSize: 128
    }
  );

  player.attachMediaElement(viewerElements.remoteVideo);
  player.on(window.flvjs.Events.MEDIA_INFO, () => {
    viewerElements.remoteOverlay.hidden = true;
    setViewerStatus("В эфире");
    setViewerMessage("Серверный поток подключён. Видео идёт через RTMP relay.", "ok");
  });
  player.on(window.flvjs.Events.ERROR, (errorType, errorDetail) => {
    console.error("FLV player error:", errorType, errorDetail);
    viewerElements.remoteOverlay.hidden = false;
    setOverlayBadge("Поток недоступен");
    setViewerStatus("Ошибка потока");
    setViewerMessage("Плеер не получил RTMP/FLV поток. Проверь, что OBS уже публикует в эту комнату.", "warn");
  });

  player.load();
  player.play().catch(() => {});
  viewerState.flvPlayer = player;
}

async function connectViewer() {
  try {
    await loadMediaConfig();

    if (!viewerState.mediaConfig?.enabled) {
      throw new Error("RTMP медиасервер не включён на сервере.");
    }

    const roomId = normalizeRoomId(
      viewerElements.roomInput.value.trim() || viewerElements.watchSearchInput.value.trim()
    );
    if (!roomId) {
      throw new Error("Укажи room ID.");
    }

    if (viewerState.viewerId) {
      disconnectViewer();
    }

    viewerElements.connectButton.disabled = true;
    setViewerStatus("Подключение");
    setOverlayBadge("Подключаем RTMP relay");
    viewerElements.remoteOverlay.hidden = false;
    setViewerMessage("Проверяем комнату и подключаем серверный поток...", "ok");

    const room = await fetchRoomInfo(roomId);
    const viewerSession = await requestJson(`/api/rooms/${encodeURIComponent(roomId)}/viewers`, {
      method: "POST"
    });

    viewerState.roomId = roomId;
    viewerState.viewerId = viewerSession.viewerId;
    viewerElements.disconnectButton.disabled = false;
    syncRoomInputs();
    startViewerHeartbeat();
    connectFlvPlayer(roomId);

    if (!room.hostOnline) {
      setViewerMessage("Комната найдена, но стример ещё не отметил эфир как live или не запустил OBS.", "warn");
      setOverlayBadge("Ждём RTMP поток");
      setViewerStatus("Ожидание");
    }
  } catch (error) {
    console.error("Viewer connect error:", error);
    viewerElements.remoteOverlay.hidden = false;
    setOverlayBadge("Подключение не удалось");

    if (typeof error?.message === "string" && error.message.includes("Room not found.")) {
      setViewerStatus("Комната не найдена");
      viewerElements.joinedRoomValue.textContent = "Не найдена";
      setViewerMessage("Комната не найдена. Попроси стримера создать новую и прислать свежую ссылку.", "error");
    } else {
      setViewerStatus("Ошибка");
      setViewerMessage(error.message || "Не удалось подключиться к потоку.", "error");
    }
  } finally {
    viewerElements.connectButton.disabled = false;
  }
}

function disconnectViewer(announce = true) {
  stopViewerHeartbeat();

  if (announce && viewerState.roomId && viewerState.viewerId) {
    const url =
      `/api/rooms/${encodeURIComponent(viewerState.roomId)}` +
      `/viewers/${encodeURIComponent(viewerState.viewerId)}/disconnect`;
    navigator.sendBeacon(url, "");
  }

  destroyPlayer();
  viewerElements.remoteOverlay.hidden = false;
  viewerElements.disconnectButton.disabled = true;
  viewerState.viewerId = "";
  setOverlayBadge("Отключено");
  setViewerStatus("Отключено");
  setViewerMessage("Просмотр остановлен.", "warn");
}

function renderUpNextItem(room) {
  const safeTitle = escapeHtml(room.title);

  return `
    <a class="recommend-item" href="/watch.html?room=${encodeURIComponent(room.roomId)}">
      <div class="recommend-thumb" style="${buildThumbStyle(room.roomId)}">
        <div class="stream-badges">
          <span class="badge live">LIVE</span>
        </div>
      </div>
      <div>
        <h3 class="recommend-title">${safeTitle}</h3>
        <div class="recommend-meta">${room.viewerCount} зрителей</div>
        <div class="recommend-meta">${formatLiveAge(room.startedAt)}</div>
      </div>
    </a>
  `;
}

async function loadLiveRooms() {
  try {
    const data = await requestJson("/api/rooms");
    const rooms = (data.rooms || []).filter((room) => room.roomId !== viewerState.roomId);

    viewerElements.upNextCount.textContent = `${data.totalLive || 0} live`;

    if (rooms.length === 0) {
      viewerElements.upNextList.innerHTML = `
        <div class="empty-state">
          <h3>Других эфиров пока нет</h3>
          <p class="message">Когда появятся новые RTMP live-комнаты, они будут показаны здесь.</p>
        </div>
      `;
      setWatchHomeMessage("Каталог эфиров обновляется автоматически.", "ok");
      return;
    }

    viewerElements.upNextList.innerHTML = rooms.map(renderUpNextItem).join("");
    setWatchHomeMessage("Можешь открыть другой эфир прямо из правой колонки.", "ok");
  } catch (error) {
    console.error("Failed to load live rooms:", error);
    setWatchHomeMessage(error.message || "Не удалось загрузить список эфиров.", "error");
  } finally {
    window.clearTimeout(viewerState.roomsPollTimer);
    viewerState.roomsPollTimer = window.setTimeout(loadLiveRooms, 5000);
  }
}

function restoreRoomFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const roomId = normalizeRoomId(params.get("room") || "");

  if (!roomId) {
    setOverlayBadge("Ожидаем поток");
    return;
  }

  viewerState.roomId = roomId;
  syncRoomInputs();
  setOverlayBadge("Можно подключаться");
}

function bindQuickSearch() {
  const syncInputs = (source, target) => {
    target.value = source.value;
  };

  viewerElements.watchSearchInput.addEventListener("input", () => {
    syncInputs(viewerElements.watchSearchInput, viewerElements.roomInput);
  });

  viewerElements.roomInput.addEventListener("input", () => {
    syncInputs(viewerElements.roomInput, viewerElements.watchSearchInput);
  });

  viewerElements.watchSearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      connectViewer();
    }
  });

  viewerElements.roomInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      connectViewer();
    }
  });
}

window.addEventListener("beforeunload", () => {
  if (!viewerState.roomId || !viewerState.viewerId) {
    return;
  }

  const url =
    `/api/rooms/${encodeURIComponent(viewerState.roomId)}` +
    `/viewers/${encodeURIComponent(viewerState.viewerId)}/disconnect`;
  navigator.sendBeacon(url, "");
});

viewerElements.connectButton.addEventListener("click", connectViewer);
viewerElements.disconnectButton.addEventListener("click", () => disconnectViewer());

loadMediaConfig().catch((error) => {
  console.error("Media config error:", error);
  setViewerMessage("Не удалось получить конфиг медиасервера.", "error");
});

bindQuickSearch();
restoreRoomFromQuery();
loadLiveRooms();

if (viewerState.roomId) {
  connectViewer();
}
