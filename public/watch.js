const viewerState = {
  lastEventId: 0,
  peer: null,
  pollTimer: null,
  roomId: "",
  roomInfo: null,
  roomsPollTimer: null,
  viewerId: ""
};

const rtcConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
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
  viewerState.roomId = room.roomId;
  viewerElements.joinedRoomValue.textContent = room.roomId;
  viewerElements.currentStreamTitle.textContent = room.title || "Подключение к эфиру";
  viewerElements.currentStreamSubtitle.textContent = room.hostOnline
    ? `LIVE сейчас, ${room.viewerCount} зрителей`
    : "Комната найдена, но эфир сейчас может быть офлайн";
  viewerElements.streamHeadline.textContent = room.title || "Стрим";
  viewerElements.streamMetaLine.textContent =
    `${room.hostOnline ? "Эфир активен" : "Эфир не запущен"} • ${formatLiveAge(room.startedAt)}`;
  syncRoomInputs();
}

async function fetchRoomInfo(roomId) {
  const room = await requestJson(`/api/rooms/${encodeURIComponent(roomId)}`);
  applyRoomInfo(room);
  return room;
}

async function sendViewerEvent(type, payload) {
  if (!viewerState.roomId || !viewerState.viewerId) {
    return;
  }

  await requestJson(`/api/rooms/${encodeURIComponent(viewerState.roomId)}/events`, {
    method: "POST",
    body: JSON.stringify({
      from: viewerState.viewerId,
      to: "host",
      type,
      payload
    })
  });
}

function closePeer() {
  if (!viewerState.peer) {
    return;
  }

  viewerState.peer.close();
  viewerState.peer = null;
}

function ensurePeer() {
  if (viewerState.peer) {
    return viewerState.peer;
  }

  const peer = new RTCPeerConnection(rtcConfiguration);

  peer.addEventListener("icecandidate", async (event) => {
    if (!event.candidate) {
      return;
    }

    try {
      await sendViewerEvent("viewer-ice", event.candidate.toJSON());
    } catch (error) {
      console.error("Failed to send viewer ICE candidate:", error);
    }
  });

  peer.addEventListener("track", (event) => {
    const [stream] = event.streams;
    viewerElements.remoteVideo.srcObject = stream;
    viewerElements.remoteOverlay.hidden = true;
    setViewerStatus("В эфире");
    setViewerMessage("Поток получен. Просмотр идёт в реальном времени.", "ok");
  });

  peer.addEventListener("connectionstatechange", () => {
    if (peer.connectionState === "connected") {
      setViewerStatus("Подключено");
      return;
    }

    if (["disconnected", "failed"].includes(peer.connectionState)) {
      setViewerStatus("Соединение потеряно");
      viewerElements.remoteOverlay.hidden = false;
      setOverlayBadge("Соединение потеряно");
      setViewerMessage("Связь прервалась. Можно подождать авто-возврата эфира или переподключиться.", "warn");
    }
  });

  viewerState.peer = peer;
  return peer;
}

async function handleViewerEvent(event) {
  viewerState.lastEventId = Math.max(viewerState.lastEventId, event.id);

  if (event.type === "host-offline") {
    closePeer();
    viewerElements.remoteVideo.srcObject = null;
    viewerElements.remoteOverlay.hidden = false;
    setOverlayBadge("Стример офлайн");
    setViewerStatus("Ожидание");
    setViewerMessage("Стример остановил эфир. Если он вернётся, страница сможет принять новый поток.", "warn");

    if (viewerState.roomId) {
      try {
        await fetchRoomInfo(viewerState.roomId);
      } catch (error) {
        console.error("Failed to refresh room info after host-offline:", error);
      }
    }
    return;
  }

  if (event.type === "host-offer") {
    const peer = ensurePeer();
    await peer.setRemoteDescription(event.payload);

    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await sendViewerEvent("viewer-answer", peer.localDescription.toJSON());

    setViewerStatus("Подключение");
    setViewerMessage("Согласовываем соединение со стримером...", "ok");
    return;
  }

  if (event.type === "host-ice" && event.payload) {
    const peer = ensurePeer();
    await peer.addIceCandidate(event.payload);
  }
}

async function pollViewerEvents() {
  if (!viewerState.roomId || !viewerState.viewerId) {
    return;
  }

  try {
    const data = await requestJson(
      `/api/rooms/${encodeURIComponent(viewerState.roomId)}/events` +
      `?clientId=${encodeURIComponent(viewerState.viewerId)}&after=${viewerState.lastEventId}`
    );

    for (const event of data.events || []) {
      await handleViewerEvent(event);
    }
  } catch (error) {
    console.error("Viewer polling error:", error);
    setViewerMessage(error.message || "Не удалось получить события комнаты.", "error");
  } finally {
    window.clearTimeout(viewerState.pollTimer);
    viewerState.pollTimer = window.setTimeout(pollViewerEvents, 1000);
  }
}

function startViewerPolling() {
  window.clearTimeout(viewerState.pollTimer);
  viewerState.pollTimer = window.setTimeout(pollViewerEvents, 200);
}

async function connectViewer() {
  try {
    const roomId = viewerElements.roomInput.value.trim() || viewerElements.watchSearchInput.value.trim();
    if (!roomId) {
      throw new Error("Укажи room ID.");
    }

    if (viewerState.viewerId) {
      disconnectViewer();
    }

    viewerElements.connectButton.disabled = true;
    setViewerMessage("Проверяем комнату и создаём viewer session...", "ok");

    const room = await fetchRoomInfo(roomId);
    const data = await requestJson(`/api/rooms/${encodeURIComponent(roomId)}/viewers`, {
      method: "POST"
    });

    viewerState.roomId = roomId;
    viewerState.viewerId = data.viewerId;
    viewerState.lastEventId = 0;
    viewerElements.disconnectButton.disabled = false;
    setViewerStatus(room.hostOnline ? "Ожидание offer" : "Комната офлайн");
    setOverlayBadge(room.hostOnline ? "Ждём поток от стримера" : "Стример пока не в эфире");
    viewerElements.remoteOverlay.hidden = false;
    syncRoomInputs();
    startViewerPolling();
    setViewerMessage("Подключение создано. Видео появится автоматически, как только придёт offer.", "ok");
  } catch (error) {
    console.error("Viewer connect error:", error);
    setViewerMessage(error.message || "Не удалось подключиться к комнате.", "error");
  } finally {
    viewerElements.connectButton.disabled = false;
  }
}

function disconnectViewer(announce = true) {
  window.clearTimeout(viewerState.pollTimer);

  if (announce && viewerState.roomId && viewerState.viewerId) {
    const url =
      `/api/rooms/${encodeURIComponent(viewerState.roomId)}` +
      `/viewers/${encodeURIComponent(viewerState.viewerId)}/disconnect`;
    navigator.sendBeacon(url, "");
  }

  closePeer();
  viewerElements.remoteVideo.srcObject = null;
  viewerElements.remoteOverlay.hidden = false;
  viewerElements.disconnectButton.disabled = true;
  viewerState.lastEventId = 0;
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
          <p class="message">Когда появятся новые live-комнаты, они будут показаны здесь.</p>
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
  const roomId = params.get("room") || "";

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

bindQuickSearch();
restoreRoomFromQuery();
loadLiveRooms();

if (viewerState.roomId) {
  fetchRoomInfo(viewerState.roomId)
    .then(() => connectViewer())
    .catch((error) => {
      console.error("Failed to auto-connect by query:", error);
      setViewerMessage("Не удалось автоматически подключиться по ссылке.", "warn");
    });
}
