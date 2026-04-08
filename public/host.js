const hostState = {
  hostConnected: false,
  hostToken: "",
  lastEventId: 0,
  mediaConfig: null,
  mediaConfigPromise: null,
  roomId: "",
  roomInfo: null,
  roomPollTimer: 0
};

const hostElements = {
  copyLinkButton: document.getElementById("copyLinkButton"),
  createRoomButton: document.getElementById("createRoomButton"),
  hostMessage: document.getElementById("hostMessage"),
  outputStateDisplay: document.getElementById("outputStateDisplay"),
  publishUrlValue: document.getElementById("publishUrlValue"),
  roomIdValue: document.getElementById("roomIdValue"),
  roomTitle: document.getElementById("roomTitle"),
  shareUrl: document.getElementById("shareUrl"),
  startButton: document.getElementById("startButton"),
  stopButton: document.getElementById("stopButton"),
  streamKeyDisplay: document.getElementById("streamKeyDisplay"),
  streamKeyValue: document.getElementById("streamKeyValue"),
  studioModeChip: document.getElementById("studioModeChip"),
  viewerCountValue: document.getElementById("viewerCountValue"),
  watchUrlValue: document.getElementById("watchUrlValue")
};

function setHostMessage(text, tone = "") {
  hostElements.hostMessage.textContent = text;
  hostElements.hostMessage.className = tone ? `message ${tone}` : "message";
}

function getOutputLabel() {
  return hostState.hostConnected ? "Live" : "Ready";
}

function applyOutputState() {
  const label = getOutputLabel();
  hostElements.outputStateDisplay.textContent = label;
  hostElements.studioModeChip.textContent = label;
}

function refreshControlStates() {
  const hasRoom = Boolean(hostState.roomId);
  hostElements.copyLinkButton.disabled = !hasRoom;
  hostElements.startButton.disabled = !hasRoom || hostState.hostConnected;
  hostElements.stopButton.disabled = !hostState.hostConnected;
}

function updateViewerLink() {
  if (!hostState.roomId) {
    hostElements.shareUrl.value = "";
    hostElements.watchUrlValue.value = "";
    return;
  }

  const watchUrl = `${window.location.origin}/watch.html?room=${encodeURIComponent(hostState.roomId)}`;
  hostElements.shareUrl.value = watchUrl;
  hostElements.watchUrlValue.value = watchUrl;
}

function updatePublishInfo() {
  if (!hostState.mediaConfig || !hostState.roomId) {
    hostElements.publishUrlValue.value = hostState.mediaConfig?.publishBaseUrl || "";
    hostElements.streamKeyValue.value = hostState.roomId || "";
    hostElements.streamKeyDisplay.textContent = hostState.roomId || "—";
    return;
  }

  hostElements.publishUrlValue.value = hostState.mediaConfig.publishBaseUrl || "";
  hostElements.streamKeyValue.value = hostState.roomId;
  hostElements.streamKeyDisplay.textContent = hostState.roomId;
}

function updateRoomInfo() {
  hostElements.roomIdValue.textContent = hostState.roomId || "Не создана";
  hostElements.viewerCountValue.textContent = String(hostState.roomInfo?.viewerCount || 0);
  applyOutputState();
  updateViewerLink();
  updatePublishInfo();
  refreshControlStates();
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
  if (hostState.mediaConfigPromise && !force) {
    return hostState.mediaConfigPromise;
  }

  hostState.mediaConfigPromise = requestJson("/api/media-config")
    .then((data) => {
      hostState.mediaConfig = data;
      updatePublishInfo();
      return data;
    })
    .catch((error) => {
      hostState.mediaConfig = null;
      throw error;
    });

  return hostState.mediaConfigPromise;
}

async function fetchRoomInfo() {
  if (!hostState.roomId) {
    return null;
  }

  const room = await requestJson(`/api/rooms/${encodeURIComponent(hostState.roomId)}`);
  hostState.roomInfo = room;
  updateRoomInfo();
  return room;
}

async function createRoom() {
  if (hostState.roomId) {
    return hostState.roomId;
  }

  await loadMediaConfig();

  const data = await requestJson("/api/rooms", {
    method: "POST",
    body: JSON.stringify({
      title: hostElements.roomTitle.value.trim()
    })
  });

  hostState.roomId = data.roomId;
  hostState.hostToken = data.hostToken;
  hostState.roomInfo = data;
  updateRoomInfo();
  setHostMessage("Комната создана. Теперь вставь RTMP URL и stream key в OBS.", "ok");
  return hostState.roomId;
}

function stopRoomPolling() {
  window.clearTimeout(hostState.roomPollTimer);
  hostState.roomPollTimer = 0;
}

async function pollRoomState() {
  if (!hostState.roomId || !hostState.hostConnected) {
    return;
  }

  try {
    const data = await requestJson(
      `/api/rooms/${encodeURIComponent(hostState.roomId)}/events?clientId=host&after=${hostState.lastEventId}`,
      {
        headers: {
          "X-Host-Token": hostState.hostToken
        }
      }
    );

    for (const event of data.events || []) {
      hostState.lastEventId = Math.max(hostState.lastEventId, event.id);
    }

    await fetchRoomInfo();
  } catch (error) {
    console.error("Host room polling error:", error);
    setHostMessage(error.message || "Не удалось обновить состояние комнаты.", "error");
  } finally {
    stopRoomPolling();
    hostState.roomPollTimer = window.setTimeout(pollRoomState, 5000);
  }
}

function startRoomPolling() {
  stopRoomPolling();
  hostState.roomPollTimer = window.setTimeout(pollRoomState, 500);
}

async function startBroadcast() {
  try {
    await createRoom();

    if (hostState.hostConnected) {
      setHostMessage("Комната уже помечена как live.", "warn");
      return;
    }

    await requestJson(`/api/rooms/${encodeURIComponent(hostState.roomId)}/host/connect`, {
      method: "POST",
      headers: {
        "X-Host-Token": hostState.hostToken
      }
    });

    hostState.hostConnected = true;
    hostState.lastEventId = 0;
    updateRoomInfo();
    startRoomPolling();
    setHostMessage("Комната показана в каталоге. Запусти публикацию в OBS по RTMP URL и stream key.", "ok");
  } catch (error) {
    console.error("Start broadcast error:", error);
    setHostMessage(error.message || "Не удалось включить эфир.", "error");
  } finally {
    refreshControlStates();
  }
}

async function stopBroadcast(announce = true) {
  stopRoomPolling();

  try {
    if (announce && hostState.roomId && hostState.hostConnected) {
      await requestJson(`/api/rooms/${encodeURIComponent(hostState.roomId)}/host/disconnect`, {
        method: "POST",
        headers: {
          "X-Host-Token": hostState.hostToken
        }
      });
    }
  } catch (error) {
    console.error("Stop broadcast error:", error);
    setHostMessage(error.message || "Не удалось скрыть эфир из каталога.", "error");
  }

  hostState.hostConnected = false;
  updateRoomInfo();
  refreshControlStates();
  setHostMessage("Комната снята с live. Можно остановить OBS или настроить следующий эфир.", "warn");
}

async function copyViewerLink() {
  if (!hostElements.shareUrl.value) {
    return;
  }

  try {
    await navigator.clipboard.writeText(hostElements.shareUrl.value);
    setHostMessage("Ссылка на просмотр скопирована.", "ok");
  } catch (error) {
    console.error("Clipboard error:", error);
    setHostMessage("Не удалось скопировать ссылку автоматически.", "warn");
  }
}

function renderMediaAvailability() {
  if (!hostState.mediaConfig?.enabled) {
    setHostMessage("RTMP-сервер недоступен: установи зависимости и перезапусти приложение.", "error");
    return;
  }

  setHostMessage("RTMP-сервер готов. Создай комнату и публикуй поток из OBS.", "ok");
}

window.addEventListener("beforeunload", () => {
  if (!hostState.roomId || !hostState.hostToken || !hostState.hostConnected) {
    return;
  }

  const url =
    `/api/rooms/${encodeURIComponent(hostState.roomId)}/host/disconnect` +
    `?token=${encodeURIComponent(hostState.hostToken)}`;
  navigator.sendBeacon(url, "");
});

hostElements.createRoomButton.addEventListener("click", async () => {
  try {
    hostElements.createRoomButton.disabled = true;
    await createRoom();
  } catch (error) {
    console.error("Create room error:", error);
    setHostMessage(error.message || "Не удалось создать комнату.", "error");
  } finally {
    hostElements.createRoomButton.disabled = false;
    refreshControlStates();
  }
});

hostElements.startButton.addEventListener("click", startBroadcast);
hostElements.stopButton.addEventListener("click", () => stopBroadcast());
hostElements.copyLinkButton.addEventListener("click", copyViewerLink);

loadMediaConfig()
  .then(() => {
    renderMediaAvailability();
    updateRoomInfo();
  })
  .catch((error) => {
    console.error("Media config error:", error);
    setHostMessage(error.message || "Не удалось получить конфиг медиасервера.", "error");
  });

updateRoomInfo();
