const homeElements = {
  heroLiveCount: document.getElementById("heroLiveCount"),
  homeMessage: document.getElementById("homeMessage"),
  liveCountBadge: document.getElementById("liveCountBadge"),
  liveGrid: document.getElementById("liveGrid"),
  searchInput: document.getElementById("searchInput")
};

const homeState = {
  pollTimer: null,
  query: "",
  rooms: []
};

function setHomeMessage(text, tone = "") {
  homeElements.homeMessage.textContent = text;
  homeElements.homeMessage.className = tone ? `message ${tone}` : "message";
}

async function requestJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Request failed with status ${response.status}.`);
  }

  return data;
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

function formatViewerCount(value) {
  return `${value} зр${value === 1 ? "итель" : value < 5 ? "ителя" : "ителей"}`;
}

function formatLiveAge(startedAt) {
  if (!startedAt) {
    return "Только что";
  }

  const diffMinutes = Math.max(1, Math.floor((Date.now() - startedAt) / 60000));
  if (diffMinutes < 60) {
    return `${diffMinutes} мин в эфире`;
  }

  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  return `${hours} ч ${minutes} мин в эфире`;
}

function buildThumbStyle(roomId) {
  const baseHue = hashHue(roomId);
  const secondHue = (baseHue + 62) % 360;

  return `background:
    radial-gradient(circle at 20% 20%, hsla(${baseHue}, 82%, 64%, 0.35), transparent 28%),
    radial-gradient(circle at 82% 18%, hsla(${secondHue}, 75%, 58%, 0.25), transparent 30%),
    linear-gradient(135deg, hsl(${baseHue}, 72%, 22%), hsl(${secondHue}, 48%, 12%));`;
}

function renderRoomCard(room) {
  const shortId = room.roomId.toUpperCase();
  const safeTitle = escapeHtml(room.title);

  return `
    <a class="stream-card" href="/watch.html?room=${encodeURIComponent(room.roomId)}" aria-label="${safeTitle}">
      <div class="stream-thumb" style="${buildThumbStyle(room.roomId)}">
        <div class="stream-badges">
          <span class="badge live">LIVE</span>
          <span class="badge">${room.viewerCount}</span>
        </div>
        <div class="thumb-title">${shortId}</div>
      </div>

      <div class="stream-card-info">
        <div class="stream-title-row">
          <h3 class="stream-title">${safeTitle}</h3>
          <span class="chip">${room.viewerCount} online</span>
        </div>
        <div class="stream-meta">${formatLiveAge(room.startedAt)}</div>
        <div class="stream-actions">
          <span class="stream-meta">${formatViewerCount(room.viewerCount)}</span>
          <span class="text-link">Смотреть</span>
        </div>
      </div>
    </a>
  `;
}

function renderRooms() {
  const normalizedQuery = homeState.query.trim().toLowerCase();
  const filteredRooms = homeState.rooms.filter((room) => {
    if (!normalizedQuery) {
      return true;
    }

    return (
      room.title.toLowerCase().includes(normalizedQuery) ||
      room.roomId.toLowerCase().includes(normalizedQuery)
    );
  });

  homeElements.heroLiveCount.textContent = String(homeState.rooms.length);
  homeElements.liveCountBadge.textContent = `${filteredRooms.length} стримов`;

  if (filteredRooms.length === 0) {
    const isSearch = Boolean(normalizedQuery);
    homeElements.liveGrid.innerHTML = `
      <div class="empty-state">
        <h3>${isSearch ? "Ничего не найдено" : "Пока никто не в эфире"}</h3>
        <p class="message">
          ${isSearch
            ? "Попробуй другой запрос или очисти поиск."
            : "Можешь стать первым: открой студию и запусти тестовый стрим."}
        </p>
        <div class="button-row">
          <a class="primary-link" href="/studio.html">Открыть студию</a>
          <a class="ghost-button" href="/watch.html">Подключиться вручную</a>
        </div>
      </div>
    `;
    setHomeMessage(
      isSearch ? "По текущему запросу живых эфиров нет." : "Каталог живой, просто сейчас в нём пусто.",
      isSearch ? "warn" : ""
    );
    return;
  }

  homeElements.liveGrid.innerHTML = filteredRooms.map(renderRoomCard).join("");
  setHomeMessage("Список активных эфиров обновляется автоматически каждые несколько секунд.", "ok");
}

async function loadRooms() {
  try {
    const data = await requestJson("/api/rooms");
    homeState.rooms = data.rooms || [];
    renderRooms();
  } catch (error) {
    console.error("Failed to load live rooms:", error);
    setHomeMessage(error.message || "Не удалось загрузить активные стримы.", "error");
  } finally {
    window.clearTimeout(homeState.pollTimer);
    homeState.pollTimer = window.setTimeout(loadRooms, 5000);
  }
}

homeElements.searchInput.addEventListener("input", (event) => {
  homeState.query = event.target.value || "";
  renderRooms();
});

loadRooms();
