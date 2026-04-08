const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const CAPTURE_FRAME_RATE = 30;

const SCENE_LABELS = {
  camera: "Только вебка",
  overlay: "Экран + вебка",
  screen: "Только экран",
  split: "Сплит"
};

function createEmptySourceBundle() {
  return {
    camera: null,
    mic: null,
    screen: null
  };
}

function createEmptyVideoBundle() {
  return {
    camera: null,
    screen: null
  };
}

const hostState = {
  activeScene: "overlay",
  audioEngine: null,
  audioMeterFrame: 0,
  canvas: null,
  ctx: null,
  hostConnected: false,
  hostToken: "",
  isPreparing: false,
  lastEventId: 0,
  pendingViewerIce: new Map(),
  peers: new Map(),
  pollTimer: 0,
  renderFrame: 0,
  roomId: "",
  sourceStreams: createEmptySourceBundle(),
  sourceVideos: createEmptyVideoBundle(),
  stream: null,
  waitingViewers: new Set()
};

const hostElements = {
  cameraSourceToggle: document.getElementById("cameraSourceToggle"),
  copyLinkButton: document.getElementById("copyLinkButton"),
  createRoomButton: document.getElementById("createRoomButton"),
  hostMessage: document.getElementById("hostMessage"),
  micMeterFill: document.getElementById("micMeterFill"),
  micVolumeInput: document.getElementById("micVolumeInput"),
  microphoneToggle: document.getElementById("microphoneToggle"),
  outputStateValue: document.getElementById("outputStateValue"),
  prepareButton: document.getElementById("prepareButton"),
  previewOverlay: document.getElementById("previewOverlay"),
  previewStateBadge: document.getElementById("previewStateBadge"),
  previewVideo: document.getElementById("previewVideo"),
  roomIdValue: document.getElementById("roomIdValue"),
  roomTitle: document.getElementById("roomTitle"),
  sceneButtons: [...document.querySelectorAll("[data-scene]")],
  sceneNameValue: document.getElementById("sceneNameValue"),
  sceneValue: document.getElementById("sceneValue"),
  screenSourceToggle: document.getElementById("screenSourceToggle"),
  shareUrl: document.getElementById("shareUrl"),
  startButton: document.getElementById("startButton"),
  stopButton: document.getElementById("stopButton"),
  studioModeChip: document.getElementById("studioModeChip"),
  systemAudioToggle: document.getElementById("systemAudioToggle"),
  systemMeterFill: document.getElementById("systemMeterFill"),
  systemVolumeInput: document.getElementById("systemVolumeInput"),
  viewerCountValue: document.getElementById("viewerCountValue"),
  webcamPositionSelect: document.getElementById("webcamPositionSelect"),
  webcamSizeSelect: document.getElementById("webcamSizeSelect")
};

function setHostMessage(text, tone = "") {
  hostElements.hostMessage.textContent = text;
  hostElements.hostMessage.className = tone ? `message ${tone}` : "message";
}

function showPreviewOverlay(text) {
  hostElements.previewOverlay.hidden = false;
  hostElements.previewOverlay.innerHTML = `<div class="video-chip">${text}</div>`;
}

function hidePreviewOverlay() {
  hostElements.previewOverlay.hidden = true;
}

function getOutputMode() {
  if (hostState.hostConnected) {
    return "live";
  }

  if (hostState.stream) {
    return "preview";
  }

  return "offline";
}

function applyOutputMode() {
  const mode = getOutputMode();
  const labels = {
    live: "Live",
    offline: "Offline",
    preview: "Preview"
  };

  hostElements.outputStateValue.textContent = labels[mode];
  hostElements.studioModeChip.textContent = labels[mode];
  hostElements.previewStateBadge.textContent = mode.toUpperCase();
  hostElements.previewStateBadge.className =
    `preview-floating-badge${mode === "live" ? " live" : mode === "preview" ? " preview" : ""}`;
}

function updateShareUrl() {
  if (!hostState.roomId) {
    hostElements.shareUrl.value = "";
    hostElements.copyLinkButton.disabled = true;
    return;
  }

  hostElements.shareUrl.value = `${window.location.origin}/watch.html?room=${encodeURIComponent(hostState.roomId)}`;
  hostElements.copyLinkButton.disabled = false;
}

function updateRoomInfo() {
  const uniqueViewers = new Set([
    ...hostState.waitingViewers,
    ...hostState.peers.keys()
  ]);

  hostElements.roomIdValue.textContent = hostState.roomId || "Не создана";
  hostElements.viewerCountValue.textContent = String(uniqueViewers.size);
  hostElements.sceneValue.textContent = SCENE_LABELS[hostState.activeScene];
  hostElements.sceneNameValue.textContent = SCENE_LABELS[hostState.activeScene];
  applyOutputMode();
  updateShareUrl();
}

function refreshControlStates() {
  hostElements.prepareButton.disabled = hostState.isPreparing;
  hostElements.startButton.disabled = hostState.isPreparing || hostState.hostConnected;
  hostElements.stopButton.disabled = !hostState.hostConnected;
  hostElements.copyLinkButton.disabled = !hostState.roomId;
  hostElements.systemAudioToggle.disabled = !hostElements.screenSourceToggle.checked || hostState.isPreparing;
}

function isRoomNotFoundError(error) {
  return typeof error?.message === "string" && error.message.includes("Room not found.");
}

function resetRoomIdentity(clearUrl = false) {
  hostState.roomId = "";
  hostState.hostToken = "";
  hostState.waitingViewers = new Set();

  if (clearUrl) {
    window.history.replaceState({}, "", window.location.pathname);
  }

  updateRoomInfo();
  refreshControlStates();
}

async function doesRoomStillExist(roomId) {
  try {
    await requestJson(`/api/rooms/${encodeURIComponent(roomId)}`);
    return true;
  } catch (error) {
    if (isRoomNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

function syncUrl() {
  if (!hostState.roomId || !hostState.hostToken) {
    return;
  }

  const nextUrl =
    `${window.location.pathname}?room=${encodeURIComponent(hostState.roomId)}` +
    `#token=${encodeURIComponent(hostState.hostToken)}`;
  window.history.replaceState({}, "", nextUrl);
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

async function createRoom() {
  if (hostState.roomId) {
    const stillExists = await doesRoomStillExist(hostState.roomId);
    if (stillExists) {
      return hostState.roomId;
    }

    resetRoomIdentity(true);
    setHostMessage("Старая комната пропала после перезапуска сервера. Создаю новую.", "warn");
  }

  const data = await requestJson("/api/rooms", {
    method: "POST",
    body: JSON.stringify({
      title: hostElements.roomTitle.value.trim()
    })
  });

  hostState.roomId = data.roomId;
  hostState.hostToken = data.hostToken;
  syncUrl();
  updateRoomInfo();
  refreshControlStates();
  setHostMessage("Комната создана. Теперь можно готовить сцену.", "ok");
  return hostState.roomId;
}

async function connectHost() {
  let data;

  try {
    data = await requestJson(`/api/rooms/${encodeURIComponent(hostState.roomId)}/host/connect`, {
      method: "POST",
      headers: {
        "X-Host-Token": hostState.hostToken
      }
    });
  } catch (error) {
    if (isRoomNotFoundError(error)) {
      resetRoomIdentity(true);
      throw new Error("Комната исчезла после перезапуска сервиса. Создай её заново и попробуй ещё раз.");
    }

    throw error;
  }

  hostState.hostConnected = true;
  hostState.waitingViewers = new Set((data.viewerIds || []).filter((viewerId) => !hostState.peers.has(viewerId)));
  updateRoomInfo();
  refreshControlStates();
  startHostPolling();
}

function stopTracks(stream) {
  if (!stream) {
    return;
  }

  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function stopSourceBundle(bundle) {
  if (!bundle) {
    return;
  }

  for (const stream of Object.values(bundle)) {
    stopTracks(stream);
  }
}

function createHiddenVideo() {
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  return video;
}

async function createVideoNodeFromStream(stream) {
  if (!stream) {
    return null;
  }

  const video = createHiddenVideo();
  video.srcObject = stream;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    video.addEventListener("loadedmetadata", finish, { once: true });
    window.setTimeout(finish, 250);
  });

  await video.play().catch(() => {});
  return video;
}

function isVideoReady(video) {
  return Boolean(video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0);
}

function ensureCanvas() {
  if (hostState.canvas && hostState.ctx) {
    return;
  }

  hostState.canvas = document.createElement("canvas");
  hostState.canvas.width = CANVAS_WIDTH;
  hostState.canvas.height = CANVAS_HEIGHT;
  hostState.ctx = hostState.canvas.getContext("2d", { alpha: false });
}

function getStudioConfig() {
  return {
    enableCamera: hostElements.cameraSourceToggle.checked,
    enableMic: hostElements.microphoneToggle.checked,
    enableScreen: hostElements.screenSourceToggle.checked,
    enableSystemAudio: hostElements.systemAudioToggle.checked && hostElements.screenSourceToggle.checked,
    micVolume: Number(hostElements.micVolumeInput.value || 0) / 100,
    scene: hostState.activeScene,
    systemVolume: Number(hostElements.systemVolumeInput.value || 0) / 100,
    webcamPosition: hostElements.webcamPositionSelect.value,
    webcamSize: hostElements.webcamSizeSelect.value
  };
}

function roundRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawBackdrop(ctx) {
  const gradient = ctx.createLinearGradient(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  gradient.addColorStop(0, "#101118");
  gradient.addColorStop(1, "#06070b");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  const accent = ctx.createRadialGradient(CANVAS_WIDTH * 0.86, 0, 60, CANVAS_WIDTH * 0.86, 0, 420);
  accent.addColorStop(0, "rgba(139, 92, 246, 0.25)");
  accent.addColorStop(1, "rgba(139, 92, 246, 0)");
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
}

function drawLabelChip(ctx, text, x, y) {
  ctx.save();
  ctx.font = "700 18px Bahnschrift, sans-serif";
  const textWidth = ctx.measureText(text).width;
  const paddingX = 14;
  const height = 34;

  ctx.fillStyle = "rgba(10, 10, 14, 0.86)";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  roundRectPath(ctx, x, y, textWidth + paddingX * 2, height, 17);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#f7f7fb";
  ctx.fillText(text, x + paddingX, y + 23);
  ctx.restore();
}

function drawMediaIntoRect(ctx, video, x, y, width, height, fit = "cover") {
  const scale = fit === "contain"
    ? Math.min(width / video.videoWidth, height / video.videoHeight)
    : Math.max(width / video.videoWidth, height / video.videoHeight);

  const drawWidth = video.videoWidth * scale;
  const drawHeight = video.videoHeight * scale;
  const drawX = x + (width - drawWidth) / 2;
  const drawY = y + (height - drawHeight) / 2;

  ctx.drawImage(video, drawX, drawY, drawWidth, drawHeight);
}

function drawPlaceholderTile(ctx, x, y, width, height, title, subtitle = "") {
  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
  roundRectPath(ctx, x, y, width, height, 28);
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 2;
  roundRectPath(ctx, x, y, width, height, 28);
  ctx.stroke();

  ctx.fillStyle = "#f7f7fb";
  ctx.font = "700 30px Bahnschrift, sans-serif";
  ctx.fillText(title, x + 28, y + 54);

  if (subtitle) {
    ctx.fillStyle = "rgba(247, 247, 251, 0.72)";
    ctx.font = "500 20px Bahnschrift, sans-serif";
    ctx.fillText(subtitle, x + 28, y + 90);
  }
  ctx.restore();
}

function drawVideoTile(ctx, video, x, y, width, height, options = {}) {
  const {
    fit = "cover",
    label = "",
    radius = 28
  } = options;

  ctx.save();
  roundRectPath(ctx, x, y, width, height, radius);
  ctx.clip();

  ctx.fillStyle = "#09090d";
  ctx.fillRect(x, y, width, height);

  if (isVideoReady(video)) {
    drawMediaIntoRect(ctx, video, x, y, width, height, fit);
  } else {
    drawPlaceholderTile(ctx, x, y, width, height, label || "Источник", "Источник недоступен");
  }

  ctx.restore();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = 2;
  roundRectPath(ctx, x, y, width, height, radius);
  ctx.stroke();

  if (label) {
    drawLabelChip(ctx, label, x + 18, y + 18);
  }
}

function getWebcamRect(config) {
  const widthBySize = {
    large: 0.34,
    medium: 0.28,
    small: 0.22
  };

  const width = CANVAS_WIDTH * (widthBySize[config.webcamSize] || widthBySize.medium);
  const height = width * (9 / 16);
  const margin = 28;

  let x = CANVAS_WIDTH - width - margin;
  let y = CANVAS_HEIGHT - height - margin;

  if (config.webcamPosition.includes("left")) {
    x = margin;
  }

  if (config.webcamPosition.includes("top")) {
    y = margin;
  }

  return { height, width, x, y };
}

function drawCompositeFrame() {
  ensureCanvas();
  const ctx = hostState.ctx;
  const config = getStudioConfig();
  const screenVideo = config.enableScreen ? hostState.sourceVideos.screen : null;
  const cameraVideo = config.enableCamera ? hostState.sourceVideos.camera : null;
  const hasScreen = isVideoReady(screenVideo);
  const hasCamera = isVideoReady(cameraVideo);

  drawBackdrop(ctx);

  if (!hasScreen && !hasCamera) {
    drawPlaceholderTile(ctx, 36, 36, CANVAS_WIDTH - 72, CANVAS_HEIGHT - 72, "Нет видеосигнала", "Включи экран, окно или вебку и подготовь сцену снова");
    return;
  }

  if (config.scene === "screen") {
    if (hasScreen) {
      drawVideoTile(ctx, screenVideo, 24, 24, CANVAS_WIDTH - 48, CANVAS_HEIGHT - 48, {
        fit: "contain",
        label: "Window Capture"
      });
    } else {
      drawPlaceholderTile(ctx, 24, 24, CANVAS_WIDTH - 48, CANVAS_HEIGHT - 48, "Экран недоступен", "Выбери окно или включи screen source");
    }
    return;
  }

  if (config.scene === "camera") {
    if (hasCamera) {
      drawVideoTile(ctx, cameraVideo, 24, 24, CANVAS_WIDTH - 48, CANVAS_HEIGHT - 48, {
        fit: "cover",
        label: "Webcam"
      });
    } else {
      drawPlaceholderTile(ctx, 24, 24, CANVAS_WIDTH - 48, CANVAS_HEIGHT - 48, "Вебка недоступна", "Включи camera source и подготовь сцену");
    }
    return;
  }

  if (config.scene === "split") {
    const gap = 24;
    const tileWidth = (CANVAS_WIDTH - gap * 3) / 2;
    const tileHeight = CANVAS_HEIGHT - 48;

    drawVideoTile(ctx, hasScreen ? screenVideo : null, gap, 24, tileWidth, tileHeight, {
      fit: "contain",
      label: "Window Capture"
    });

    drawVideoTile(ctx, hasCamera ? cameraVideo : null, gap * 2 + tileWidth, 24, tileWidth, tileHeight, {
      fit: "cover",
      label: "Webcam"
    });
    return;
  }

  if (hasScreen) {
    drawVideoTile(ctx, screenVideo, 24, 24, CANVAS_WIDTH - 48, CANVAS_HEIGHT - 48, {
      fit: "contain",
      label: "Window Capture"
    });
  } else if (hasCamera) {
    drawVideoTile(ctx, cameraVideo, 24, 24, CANVAS_WIDTH - 48, CANVAS_HEIGHT - 48, {
      fit: "cover",
      label: "Webcam"
    });
  }

  if (hasCamera && hasScreen) {
    const rect = getWebcamRect(config);
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.34)";
    ctx.shadowBlur = 28;
    ctx.shadowOffsetY = 12;
    drawVideoTile(ctx, cameraVideo, rect.x, rect.y, rect.width, rect.height, {
      fit: "cover",
      label: "Cam",
      radius: 24
    });
    ctx.restore();
  }
}

function renderLoop() {
  drawCompositeFrame();
  hostState.renderFrame = window.requestAnimationFrame(renderLoop);
}

function startRenderLoop() {
  window.cancelAnimationFrame(hostState.renderFrame);
  hostState.renderFrame = window.requestAnimationFrame(renderLoop);
}

function setMeterFill(element, level) {
  element.style.width = `${Math.max(0, Math.min(100, level * 100))}%`;
}

function destroyAudioEngine(engine) {
  if (!engine) {
    return;
  }

  if (engine.context && engine.context.state !== "closed") {
    engine.context.close().catch(() => {});
  }
}

function resetMeters() {
  setMeterFill(hostElements.micMeterFill, 0);
  setMeterFill(hostElements.systemMeterFill, 0);
}

function startAudioMeterLoop() {
  window.cancelAnimationFrame(hostState.audioMeterFrame);

  const tick = () => {
    const engine = hostState.audioEngine;
    const channels = ["mic", "system"];

    for (const channel of channels) {
      const analyser = engine?.analysers[channel];
      const data = engine?.data[channel];
      const element = channel === "mic" ? hostElements.micMeterFill : hostElements.systemMeterFill;

      if (!analyser || !data) {
        setMeterFill(element, 0);
        continue;
      }

      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (const value of data) {
        sum += value;
      }
      setMeterFill(element, (sum / data.length) / 255);
    }

    hostState.audioMeterFrame = window.requestAnimationFrame(tick);
  };

  hostState.audioMeterFrame = window.requestAnimationFrame(tick);
}

function applyAudioGains() {
  if (!hostState.audioEngine) {
    return;
  }

  if (hostState.audioEngine.gains.mic) {
    hostState.audioEngine.gains.mic.gain.value = Number(hostElements.micVolumeInput.value || 0) / 100;
  }

  if (hostState.audioEngine.gains.system) {
    hostState.audioEngine.gains.system.gain.value = Number(hostElements.systemVolumeInput.value || 0) / 100;
  }
}

async function createAudioEngine(sources) {
  const hasMic = Boolean(sources.mic?.getAudioTracks().length);
  const hasSystem = Boolean(sources.screen?.getAudioTracks().length) && hostElements.systemAudioToggle.checked;

  if (!hasMic && !hasSystem) {
    return null;
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }

  const context = new AudioContextCtor();
  const destination = context.createMediaStreamDestination();
  const engine = {
    analysers: {
      mic: null,
      system: null
    },
    context,
    data: {
      mic: null,
      system: null
    },
    destination,
    gains: {
      mic: null,
      system: null
    },
    track: null
  };

  const connectAudioInput = (channel, stream, volume) => {
    const source = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    gain.gain.value = volume;

    source.connect(gain);
    gain.connect(destination);
    gain.connect(analyser);

    engine.gains[channel] = gain;
    engine.analysers[channel] = analyser;
    engine.data[channel] = new Uint8Array(analyser.frequencyBinCount);
  };

  if (hasMic) {
    connectAudioInput("mic", new MediaStream([sources.mic.getAudioTracks()[0]]), Number(hostElements.micVolumeInput.value || 0) / 100);
  }

  if (hasSystem) {
    connectAudioInput("system", new MediaStream([sources.screen.getAudioTracks()[0]]), Number(hostElements.systemVolumeInput.value || 0) / 100);
  }

  await context.resume().catch(() => {});
  engine.track = destination.stream.getAudioTracks()[0] || null;
  return engine;
}

function applyAudioEngine(engine) {
  destroyAudioEngine(hostState.audioEngine);
  hostState.audioEngine = engine;

  if (engine) {
    startAudioMeterLoop();
    applyAudioGains();
    return;
  }

  window.cancelAnimationFrame(hostState.audioMeterFrame);
  resetMeters();
}

function buildOutputStream(audioTrack) {
  ensureCanvas();
  const canvasStream = hostState.canvas.captureStream(CAPTURE_FRAME_RATE);
  const tracks = [...canvasStream.getVideoTracks()];

  if (audioTrack) {
    tracks.push(audioTrack);
  }

  return new MediaStream(tracks);
}

function bindSourceEndedHandlers(bundle) {
  const attachHandler = (streamKey, label) => {
    const stream = bundle[streamKey];
    const videoTrack = stream?.getVideoTracks()?.[0];
    if (!videoTrack) {
      return;
    }

    videoTrack.addEventListener("ended", () => {
      if (hostState.sourceStreams[streamKey] !== stream) {
        return;
      }

      hostState.sourceStreams[streamKey] = null;
      hostState.sourceVideos[streamKey] = null;
      setHostMessage(`${label} завершён. Можешь переподготовить сцену с новым источником.`, "warn");
    });
  };

  attachHandler("screen", "Захват окна");
  attachHandler("camera", "Сигнал с вебки");
}

async function captureSelectedSources() {
  const config = getStudioConfig();

  if (!config.enableScreen && !config.enableCamera) {
    throw new Error("Включи хотя бы один видеоисточник: экран или вебку.");
  }

  const nextSources = createEmptySourceBundle();

  try {
    if (config.enableScreen) {
      nextSources.screen = await navigator.mediaDevices.getDisplayMedia({
        audio: config.enableSystemAudio,
        video: {
          frameRate: {
            ideal: CAPTURE_FRAME_RATE,
            max: CAPTURE_FRAME_RATE
          }
        }
      });
    }

    if (config.enableCamera) {
      nextSources.camera = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          frameRate: {
            ideal: 30,
            max: 30
          },
          height: {
            ideal: 720
          },
          width: {
            ideal: 1280
          }
        }
      });
    }

    if (config.enableMic) {
      nextSources.mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        },
        video: false
      });
    }
  } catch (error) {
    stopSourceBundle(nextSources);
    throw error;
  }

  return nextSources;
}

async function reconnectLiveViewers() {
  if (!hostState.hostConnected || !hostState.stream) {
    return;
  }

  const viewerIds = [...new Set([
    ...hostState.waitingViewers,
    ...hostState.peers.keys()
  ])];

  for (const viewerId of [...hostState.peers.keys()]) {
    closePeer(viewerId);
  }

  hostState.waitingViewers = new Set(viewerIds);
  updateRoomInfo();

  for (const viewerId of viewerIds) {
    await connectViewer(viewerId);
  }
}

async function prepareStudio() {
  if (hostState.isPreparing) {
    return;
  }

  let nextSources = null;
  let nextAudioEngine = null;
  let nextStream = null;

  hostState.isPreparing = true;
  refreshControlStates();
  setHostMessage("Запрашиваем доступ к выбранным источникам и собираем сцену...", "ok");

  try {
    nextSources = await captureSelectedSources();
    const nextVideos = {
      camera: await createVideoNodeFromStream(nextSources.camera),
      screen: await createVideoNodeFromStream(nextSources.screen)
    };

    nextAudioEngine = await createAudioEngine(nextSources);
    nextStream = buildOutputStream(nextAudioEngine?.track || null);

    const previousSources = hostState.sourceStreams;
    const previousStream = hostState.stream;

    hostState.sourceStreams = nextSources;
    hostState.sourceVideos = nextVideos;
    hostState.stream = nextStream;
    bindSourceEndedHandlers(nextSources);
    applyAudioEngine(nextAudioEngine);
    nextAudioEngine = null;

    hostElements.previewVideo.srcObject = nextStream;
    hidePreviewOverlay();
    startRenderLoop();
    updateRoomInfo();
    refreshControlStates();

    stopSourceBundle(previousSources);
    stopTracks(previousStream);

    if (hostState.hostConnected) {
      await reconnectLiveViewers();
      setHostMessage("Сцена обновлена и уже применяется в live.", "ok");
    } else {
      setHostMessage("Превью готово. Можно выходить в эфир.", "ok");
    }
  } catch (error) {
    console.error("Failed to prepare studio:", error);
    stopSourceBundle(nextSources);
    stopTracks(nextStream);
    destroyAudioEngine(nextAudioEngine);
    setHostMessage(error.message || "Не удалось подготовить сцену.", "error");

    if (!hostState.stream) {
      showPreviewOverlay("Превью ещё не подготовлено");
    }
  } finally {
    hostState.isPreparing = false;
    refreshControlStates();
    updateRoomInfo();
  }
}

async function sendHostEvent(to, type, payload) {
  await requestJson(`/api/rooms/${encodeURIComponent(hostState.roomId)}/events`, {
    method: "POST",
    headers: {
      "X-Host-Token": hostState.hostToken
    },
    body: JSON.stringify({
      from: "host",
      payload,
      to,
      type
    })
  });
}

function closePeer(viewerId) {
  const peer = hostState.peers.get(viewerId);
  if (!peer) {
    hostState.pendingViewerIce.delete(viewerId);
    return;
  }

  peer.close();
  hostState.peers.delete(viewerId);
  hostState.pendingViewerIce.delete(viewerId);
  updateRoomInfo();
}

function hasRemoteDescription(peer) {
  return Boolean(
    peer?.remoteDescription ||
    peer?.currentRemoteDescription ||
    peer?.pendingRemoteDescription
  );
}

function queueViewerIceCandidate(viewerId, candidate) {
  const queue = hostState.pendingViewerIce.get(viewerId) || [];
  queue.push(candidate);
  hostState.pendingViewerIce.set(viewerId, queue);
}

async function flushPendingViewerIce(viewerId, peer) {
  const queue = hostState.pendingViewerIce.get(viewerId) || [];
  if (!hasRemoteDescription(peer) || queue.length === 0) {
    return;
  }

  hostState.pendingViewerIce.delete(viewerId);

  for (const candidate of queue) {
    await peer.addIceCandidate(candidate);
  }
}

async function connectViewer(viewerId) {
  if (!hostState.stream) {
    hostState.waitingViewers.add(viewerId);
    updateRoomInfo();
    return;
  }

  closePeer(viewerId);

  const peer = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  hostState.peers.set(viewerId, peer);
  hostState.pendingViewerIce.set(viewerId, []);
  hostState.waitingViewers.delete(viewerId);
  updateRoomInfo();

  for (const track of hostState.stream.getTracks()) {
    peer.addTrack(track, hostState.stream);
  }

  peer.addEventListener("icecandidate", async (event) => {
    if (!event.candidate) {
      return;
    }

    try {
      await sendHostEvent(viewerId, "host-ice", event.candidate.toJSON());
    } catch (error) {
      console.error("Failed to send host ICE candidate:", error);
    }
  });

  peer.addEventListener("connectionstatechange", () => {
    if (["closed", "disconnected", "failed"].includes(peer.connectionState)) {
      closePeer(viewerId);
    }
  });

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await sendHostEvent(viewerId, "host-offer", peer.localDescription.toJSON());
}

async function handleHostEvent(event) {
  hostState.lastEventId = Math.max(hostState.lastEventId, event.id);

  if (event.type === "viewer-joined") {
    const viewerId = event.payload.viewerId;
    const alreadyWaiting = hostState.waitingViewers.has(viewerId);

    if (hostState.peers.has(viewerId)) {
      return;
    }

    hostState.waitingViewers.add(viewerId);
    updateRoomInfo();

    if (!alreadyWaiting && hostState.hostConnected && hostState.stream) {
      await connectViewer(viewerId);
    }
    return;
  }

  if (event.type === "viewer-left") {
    const viewerId = event.payload.viewerId;
    hostState.waitingViewers.delete(viewerId);
    closePeer(viewerId);
    updateRoomInfo();
    return;
  }

  if (event.type === "viewer-answer") {
    const peer = hostState.peers.get(event.from);
    if (peer && !peer.currentRemoteDescription) {
      await peer.setRemoteDescription(event.payload);
      await flushPendingViewerIce(event.from, peer);
    }
    return;
  }

  if (event.type === "viewer-ice") {
    const peer = hostState.peers.get(event.from);
    if (peer && event.payload) {
      if (!hasRemoteDescription(peer)) {
        queueViewerIceCandidate(event.from, event.payload);
        return;
      }

      await peer.addIceCandidate(event.payload);
    }
  }
}

async function pollHostEvents() {
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
      await handleHostEvent(event);
    }
  } catch (error) {
    console.error("Host polling error:", error);
    setHostMessage(error.message || "Не удалось обновить состояние комнаты.", "error");
  } finally {
    window.clearTimeout(hostState.pollTimer);
    hostState.pollTimer = window.setTimeout(pollHostEvents, 1000);
  }
}

function startHostPolling() {
  window.clearTimeout(hostState.pollTimer);
  hostState.pollTimer = window.setTimeout(pollHostEvents, 200);
}

async function startBroadcast() {
  try {
    await createRoom();

    if (!hostState.stream) {
      await prepareStudio();
    }

    if (!hostState.stream) {
      throw new Error("Сначала подготовь сцену.");
    }

    if (hostState.hostConnected) {
      setHostMessage("Эфир уже запущен.", "warn");
      return;
    }

    await connectHost();

    const queuedViewers = [...hostState.waitingViewers];
    for (const viewerId of queuedViewers) {
      await connectViewer(viewerId);
    }

    updateRoomInfo();
    refreshControlStates();
    setHostMessage("Live включён. Сейчас зрители получают композит из студии.", "ok");
  } catch (error) {
    console.error("Failed to start broadcast:", error);
    setHostMessage(error.message || "Не удалось выйти в эфир.", "error");
  } finally {
    refreshControlStates();
  }
}

async function stopBroadcast(announce = true) {
  window.clearTimeout(hostState.pollTimer);

  for (const viewerId of [...hostState.peers.keys()]) {
    closePeer(viewerId);
  }

  if (announce && hostState.roomId && hostState.hostConnected) {
    try {
      await requestJson(`/api/rooms/${encodeURIComponent(hostState.roomId)}/host/disconnect`, {
        method: "POST",
        headers: {
          "X-Host-Token": hostState.hostToken
        }
      });
    } catch (error) {
      console.error("Failed to announce host disconnect:", error);
    }
  }

  hostState.hostConnected = false;
  updateRoomInfo();
  refreshControlStates();

  if (hostState.stream) {
    setHostMessage("Live остановлен, но превью и сцена остались подготовленными.", "warn");
  } else {
    setHostMessage("Эфир остановлен.", "warn");
  }
}

async function copyViewerLink() {
  if (!hostElements.shareUrl.value) {
    return;
  }

  try {
    await navigator.clipboard.writeText(hostElements.shareUrl.value);
    setHostMessage("Ссылка скопирована. Можно отправлять зрителям.", "ok");
  } catch (error) {
    console.error("Clipboard error:", error);
    setHostMessage("Не удалось скопировать ссылку автоматически.", "warn");
  }
}

async function restoreRoomFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get("room") || "";
  const token = window.location.hash.startsWith("#token=")
    ? decodeURIComponent(window.location.hash.slice("#token=".length))
    : "";

  if (!roomId || !token) {
    showPreviewOverlay("Превью ещё не подготовлено");
    updateRoomInfo();
    refreshControlStates();
    return;
  }

  hostState.roomId = roomId;
  hostState.hostToken = token;
  updateRoomInfo();
  refreshControlStates();

  try {
    const data = await requestJson(`/api/rooms/${encodeURIComponent(roomId)}`);
    if (data.title && !hostElements.roomTitle.value) {
      hostElements.roomTitle.value = data.title;
    }
    setHostMessage("Комната восстановлена по URL. Можно готовить сцену или сразу выходить в эфир.", "ok");
  } catch (error) {
    console.error("Failed to restore room:", error);

    if (isRoomNotFoundError(error)) {
      resetRoomIdentity(true);
      setHostMessage("Ссылка указывала на старую комнату, которой уже нет на сервере. Создай новую.", "warn");
      return;
    }

    setHostMessage("Не удалось восстановить комнату из URL.", "warn");
  }
}

function teardownLocalStudio() {
  window.clearTimeout(hostState.pollTimer);
  window.cancelAnimationFrame(hostState.renderFrame);
  window.cancelAnimationFrame(hostState.audioMeterFrame);
  stopSourceBundle(hostState.sourceStreams);
  stopTracks(hostState.stream);
  destroyAudioEngine(hostState.audioEngine);
}

function handleSceneChange(scene) {
  hostState.activeScene = scene;

  for (const button of hostElements.sceneButtons) {
    button.classList.toggle("active", button.dataset.scene === scene);
  }

  updateRoomInfo();

  if (hostState.stream) {
    drawCompositeFrame();
  }
}

hostElements.createRoomButton.addEventListener("click", async () => {
  try {
    hostElements.createRoomButton.disabled = true;
    await createRoom();
  } catch (error) {
    console.error("Room creation error:", error);
    setHostMessage(error.message || "Не удалось создать комнату.", "error");
  } finally {
    hostElements.createRoomButton.disabled = false;
    refreshControlStates();
  }
});

hostElements.prepareButton.addEventListener("click", prepareStudio);
hostElements.startButton.addEventListener("click", startBroadcast);
hostElements.stopButton.addEventListener("click", () => stopBroadcast());
hostElements.copyLinkButton.addEventListener("click", copyViewerLink);

for (const sceneButton of hostElements.sceneButtons) {
  sceneButton.addEventListener("click", () => handleSceneChange(sceneButton.dataset.scene));
}

for (const immediateRedrawControl of [
  hostElements.webcamPositionSelect,
  hostElements.webcamSizeSelect
]) {
  immediateRedrawControl.addEventListener("change", () => {
    if (hostState.stream) {
      drawCompositeFrame();
    }
  });
}

for (const audioControl of [
  hostElements.micVolumeInput,
  hostElements.systemVolumeInput
]) {
  audioControl.addEventListener("input", applyAudioGains);
}

for (const sourceControl of [
  hostElements.screenSourceToggle,
  hostElements.cameraSourceToggle,
  hostElements.systemAudioToggle,
  hostElements.microphoneToggle
]) {
  sourceControl.addEventListener("change", refreshControlStates);
}

window.addEventListener("beforeunload", () => {
  if (hostState.roomId && hostState.hostToken && hostState.hostConnected) {
    const url =
      `/api/rooms/${encodeURIComponent(hostState.roomId)}/host/disconnect` +
      `?token=${encodeURIComponent(hostState.hostToken)}`;
    navigator.sendBeacon(url, "");
  }

  teardownLocalStudio();
});

handleSceneChange(hostState.activeScene);
restoreRoomFromUrl();
refreshControlStates();
