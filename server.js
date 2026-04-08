const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
let NodeMediaServer;

try {
  NodeMediaServer = require("node-media-server");
} catch {
  NodeMediaServer = null;
}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_SIZE = 512 * 1024;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const VIEWER_TTL_MS = 90 * 1000;
const EVENT_HISTORY_LIMIT = 1000;
const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302"];
const TURN_TTL_SECONDS = Math.max(60, Number(process.env.TURN_TTL_SECONDS || 3600));
const MEDIA_APP_NAME = String(process.env.MEDIA_APP_NAME || "live").trim() || "live";
const MEDIA_HTTP_PORT = Number(process.env.MEDIA_HTTP_PORT || 8000);
const RTMP_PORT = Number(process.env.RTMP_PORT || 1935);
const MEDIA_PROXY_PREFIX = "/media";
const FLV_VENDOR_PATH = path.join(__dirname, "node_modules", "flv.js", "dist", "flv.min.js");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

const rooms = new Map();

function createId(size = 10) {
  return crypto.randomBytes(size).toString("hex").slice(0, size);
}

function parseUrls(value, fallback = []) {
  if (typeof value !== "string" || !value.trim()) {
    return [...fallback];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRoomId(value) {
  return String(value || "").trim().toLowerCase();
}

function buildRtcConfiguration() {
  const iceServers = [];
  const stunUrls = parseUrls(process.env.STUN_URLS, DEFAULT_STUN_URLS);
  const turnUrls = parseUrls(process.env.TURN_URLS);

  if (stunUrls.length > 0) {
    iceServers.push({ urls: stunUrls });
  }

  if (turnUrls.length === 0) {
    return {
      iceServers,
      turnEnabled: false
    };
  }

  let username = String(process.env.TURN_USERNAME || "").trim();
  let credential = String(process.env.TURN_PASSWORD || "").trim();
  const turnSecret = String(process.env.TURN_SECRET || "").trim();

  if ((!username || !credential) && turnSecret) {
    const expiresAt = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS;
    const turnUserId = String(process.env.TURN_USER_ID || "streamhub").trim() || "streamhub";
    username = `${expiresAt}:${turnUserId}`;
    credential = crypto
      .createHmac("sha1", turnSecret)
      .update(username)
      .digest("base64");
  }

  if (!username || !credential) {
    return {
      iceServers,
      turnEnabled: false
    };
  }

  iceServers.push({
    credential,
    urls: turnUrls,
    username
  });

  return {
    iceServers,
    turnEnabled: true
  };
}

function isMediaServerEnabled() {
  return Boolean(NodeMediaServer);
}

function getMediaOrigin(requestUrl) {
  const mediaHost = String(process.env.MEDIA_PUBLIC_HOST || requestUrl.hostname || "localhost").trim();
  const mediaHttpPort = Number(process.env.MEDIA_PUBLIC_HTTP_PORT || PORT);
  const mediaRtmpPort = Number(process.env.MEDIA_PUBLIC_RTMP_PORT || RTMP_PORT);
  const httpPortPart = mediaHttpPort === 80 || mediaHttpPort === 443 ? "" : `:${mediaHttpPort}`;
  const rtmpPortPart = mediaRtmpPort === 1935 ? "" : `:${mediaRtmpPort}`;

  return {
    flvBaseUrl: `${requestUrl.protocol}//${mediaHost}${httpPortPart}${MEDIA_PROXY_PREFIX}/${MEDIA_APP_NAME}`,
    publishBaseUrl: `rtmp://${mediaHost}${rtmpPortPart}/${MEDIA_APP_NAME}`
  };
}

function buildMediaConfiguration(requestUrl) {
  const origin = getMediaOrigin(requestUrl);

  return {
    enabled: isMediaServerEnabled(),
    flvBaseUrl: origin.flvBaseUrl,
    playbackTemplate: `${origin.flvBaseUrl}/{streamKey}.flv`,
    publishBaseUrl: origin.publishBaseUrl,
    publishTemplate: `${origin.publishBaseUrl}/{streamKey}`,
    streamKeyStrategy: "roomId"
  };
}

function createMediaServer() {
  if (!isMediaServerEnabled()) {
    return null;
  }

  const mediaServer = new NodeMediaServer({
    http: {
      allow_origin: "*",
      mediaroot: "./media",
      port: MEDIA_HTTP_PORT
    },
    rtmp: {
      chunk_size: 60000,
      gop_cache: true,
      ping: 30,
      ping_timeout: 60,
      port: RTMP_PORT
    }
  });

  mediaServer.run();
  return mediaServer;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(message);
}

function publicRoom(room) {
  return {
    createdAt: room.createdAt,
    hostOnline: room.hostOnline,
    startedAt: room.startedAt,
    roomId: room.id,
    streamKey: room.id,
    title: room.title,
    viewerCount: room.viewers.size
  };
}

function enqueueEvent(room, to, type, payload = {}, from = "system") {
  room.events.push({
    createdAt: Date.now(),
    from,
    id: room.nextEventId++,
    payload,
    to,
    type
  });

  if (room.events.length > EVENT_HISTORY_LIMIT) {
    room.events.splice(0, room.events.length - EVENT_HISTORY_LIMIT);
  }

  room.updatedAt = Date.now();
}

function createRoom(title) {
  const room = {
    createdAt: Date.now(),
    events: [],
    hostLastSeenAt: 0,
    hostOnline: false,
    hostToken: createId(24),
    id: createId(8),
    nextEventId: 1,
    startedAt: null,
    title: typeof title === "string" && title.trim() ? title.trim().slice(0, 80) : "My Stream",
    updatedAt: Date.now(),
    viewers: new Map()
  };

  rooms.set(room.id, room);
  return room;
}

function getHostToken(requestUrl, request) {
  return request.headers["x-host-token"] || requestUrl.searchParams.get("token") || "";
}

function isValidHost(room, requestUrl, request) {
  return room.hostToken === getHostToken(requestUrl, request);
}

function dropViewer(room, viewerId, reason) {
  if (!room.viewers.has(viewerId)) {
    return false;
  }

  room.viewers.delete(viewerId);
  room.updatedAt = Date.now();
  enqueueEvent(room, "host", "viewer-left", { reason, viewerId });
  room.events = room.events.filter((event) => event.to !== viewerId && event.from !== viewerId);
  return true;
}

function cleanupRooms() {
  const now = Date.now();

  for (const [roomId, room] of rooms.entries()) {
    if (room.hostOnline && now - room.hostLastSeenAt > VIEWER_TTL_MS) {
      room.hostOnline = false;
      room.startedAt = null;
      room.updatedAt = now;

      for (const viewerId of room.viewers.keys()) {
        enqueueEvent(room, viewerId, "host-offline", {});
      }
    }

    for (const [viewerId, viewer] of room.viewers.entries()) {
      if (now - viewer.lastSeenAt > VIEWER_TTL_MS) {
        dropViewer(room, viewerId, "timeout");
      }
    }

    const isExpired = now - room.updatedAt > ROOM_TTL_MS;
    if (isExpired && !room.hostOnline && room.viewers.size === 0) {
      rooms.delete(roomId);
    }
  }
}

setInterval(cleanupRooms, 30 * 1000).unref();

async function readJsonBody(request) {
  let body = "";

  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_BODY_SIZE) {
      throw new Error("Request body is too large.");
    }
  }

  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function proxyMediaRequest(request, response, requestUrl) {
  if (!isMediaServerEnabled()) {
    sendJson(response, 503, { error: "RTMP media server is not installed." });
    return;
  }

  const upstreamPath = requestUrl.pathname.slice(MEDIA_PROXY_PREFIX.length) || "/";
  const upstreamRequest = http.request(
    {
      headers: {
        ...request.headers,
        host: `127.0.0.1:${MEDIA_HTTP_PORT}`
      },
      hostname: "127.0.0.1",
      method: request.method,
      path: `${upstreamPath}${requestUrl.search}`,
      port: MEDIA_HTTP_PORT
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    }
  );

  upstreamRequest.on("error", (error) => {
    console.error("Media proxy error:", error);

    if (!response.headersSent) {
      sendJson(response, 502, { error: "Media upstream is unavailable." });
    } else {
      response.destroy(error);
    }
  });

  request.pipe(upstreamRequest);
}

async function serveStatic(requestUrl, response) {
  if (requestUrl.pathname === "/vendor/flv.min.js") {
    try {
      const fileContent = await fs.readFile(FLV_VENDOR_PATH);
      response.writeHead(200, {
        "Cache-Control": "public, max-age=3600",
        "Content-Type": MIME_TYPES[".js"]
      });
      response.end(fileContent);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        sendText(response, 404, "flv.js is not installed");
        return;
      }

      console.error("Vendor file error:", error);
      sendText(response, 500, "Internal server error");
    }
    return;
  }

  const requestedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const normalizedPath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!normalizedPath.startsWith(PUBLIC_DIR)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const fileContent = await fs.readFile(normalizedPath);
    const extension = path.extname(normalizedPath).toLowerCase();
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream"
    });
    response.end(fileContent);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      sendText(response, 404, "Not found");
      return;
    }

    console.error("Static file error:", error);
    sendText(response, 500, "Internal server error");
  }
}

async function handleApi(request, response, requestUrl) {
  const parts = requestUrl.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && requestUrl.pathname === "/api/rooms") {
    const liveRooms = [...rooms.values()]
      .filter((room) => room.hostOnline)
      .sort((left, right) => {
        return (
          right.viewers.size - left.viewers.size ||
          (right.startedAt || 0) - (left.startedAt || 0)
        );
      })
      .map(publicRoom);

    sendJson(response, 200, {
      rooms: liveRooms,
      totalLive: liveRooms.length
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/rtc-config") {
    sendJson(response, 200, buildRtcConfiguration());
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/media-config") {
    sendJson(response, 200, buildMediaConfiguration(requestUrl));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/rooms") {
    const body = await readJsonBody(request);
    const room = createRoom(body.title);
    sendJson(response, 201, {
      ...publicRoom(room),
      hostToken: room.hostToken
    });
    return;
  }

  if (parts[0] !== "api" || parts[1] !== "rooms" || parts.length < 3) {
    sendJson(response, 404, { error: "Unknown API route." });
    return;
  }

  const roomId = normalizeRoomId(parts[2]);
  const room = rooms.get(roomId);

  if (!room) {
    sendJson(response, 404, { error: "Room not found." });
    return;
  }

  if (request.method === "GET" && parts.length === 3) {
    sendJson(response, 200, publicRoom(room));
    return;
  }

  if (request.method === "GET" && parts.length === 4 && parts[3] === "events") {
    const clientId = requestUrl.searchParams.get("clientId");
    const afterId = Number(requestUrl.searchParams.get("after") || 0);

    if (!clientId) {
      sendJson(response, 400, { error: "clientId is required." });
      return;
    }

    if (clientId === "host") {
      if (!isValidHost(room, requestUrl, request)) {
        sendJson(response, 403, { error: "Invalid host token." });
        return;
      }
      room.hostLastSeenAt = Date.now();
    } else {
      const viewer = room.viewers.get(clientId);
      if (!viewer) {
        sendJson(response, 404, { error: "Viewer not found." });
        return;
      }
      viewer.lastSeenAt = Date.now();
    }

    const events = room.events.filter((event) => event.id > afterId && event.to === clientId);
    sendJson(response, 200, { events });
    return;
  }

  if (request.method === "POST" && parts.length === 5 && parts[3] === "host" && parts[4] === "connect") {
    if (!isValidHost(room, requestUrl, request)) {
      sendJson(response, 403, { error: "Invalid host token." });
      return;
    }

    room.hostOnline = true;
    room.hostLastSeenAt = Date.now();
    room.startedAt = Date.now();
    room.updatedAt = Date.now();

    sendJson(response, 200, {
      ...publicRoom(room),
      viewerIds: Array.from(room.viewers.keys())
    });
    return;
  }

  if (request.method === "POST" && parts.length === 5 && parts[3] === "host" && parts[4] === "disconnect") {
    if (!isValidHost(room, requestUrl, request)) {
      sendJson(response, 403, { error: "Invalid host token." });
      return;
    }

    room.hostOnline = false;
    room.hostLastSeenAt = 0;
    room.startedAt = null;
    room.updatedAt = Date.now();

    for (const viewerId of room.viewers.keys()) {
      enqueueEvent(room, viewerId, "host-offline", {});
    }

    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && parts.length === 4 && parts[3] === "viewers") {
    const viewerId = createId(10);
    room.viewers.set(viewerId, {
      createdAt: Date.now(),
      id: viewerId,
      lastSeenAt: Date.now()
    });
    room.updatedAt = Date.now();
    enqueueEvent(room, "host", "viewer-joined", { viewerId });

    sendJson(response, 201, {
      ...publicRoom(room),
      viewerId
    });
    return;
  }

  if (
    request.method === "POST" &&
    parts.length === 6 &&
    parts[3] === "viewers" &&
    parts[5] === "disconnect"
  ) {
    const viewerId = parts[4];
    dropViewer(room, viewerId, "disconnect");
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && parts.length === 4 && parts[3] === "events") {
    const body = await readJsonBody(request);
    const { from, payload, to, type } = body;

    if (!from || !to || !type) {
      sendJson(response, 400, { error: "from, to and type are required." });
      return;
    }

    if (from === "host") {
      if (!isValidHost(room, requestUrl, request)) {
        sendJson(response, 403, { error: "Invalid host token." });
        return;
      }
      room.hostLastSeenAt = Date.now();
      if (to !== "all" && to !== "host" && !room.viewers.has(to)) {
        sendJson(response, 404, { error: "Viewer not found." });
        return;
      }
    } else {
      const viewer = room.viewers.get(from);
      if (!viewer) {
        sendJson(response, 404, { error: "Viewer not found." });
        return;
      }
      viewer.lastSeenAt = Date.now();

      if (to !== "host") {
        sendJson(response, 400, { error: "Viewers can only send events to host." });
        return;
      }
    }

    if (to === "all") {
      for (const viewerId of room.viewers.keys()) {
        enqueueEvent(room, viewerId, type, payload, from);
      }
    } else {
      enqueueEvent(room, to, type, payload, from);
    }

    sendJson(response, 202, { ok: true });
    return;
  }

  sendJson(response, 404, { error: "Unknown API route." });
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (requestUrl.pathname === "/healthz") {
      sendJson(response, 200, {
        mediaEnabled: isMediaServerEnabled(),
        ok: true,
        rooms: rooms.size,
        uptimeSeconds: Math.round(process.uptime())
      });
      return;
    }

    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApi(request, response, requestUrl);
      return;
    }

    if (requestUrl.pathname.startsWith(`${MEDIA_PROXY_PREFIX}/`)) {
      proxyMediaRequest(request, response, requestUrl);
      return;
    }

    await serveStatic(requestUrl, response);
  } catch (error) {
    console.error("Request error:", error);
    sendJson(response, 500, { error: error.message || "Internal server error." });
  }
});

const mediaServer = createMediaServer();

server.listen(PORT, HOST, () => {
  console.log(`Streaming MVP is running on http://${HOST}:${PORT}`);
  if (mediaServer) {
    console.log(`RTMP ingest is listening on rtmp://${HOST}:${RTMP_PORT}/${MEDIA_APP_NAME}`);
    console.log(`HTTP-FLV proxy is available at http://${HOST}:${PORT}${MEDIA_PROXY_PREFIX}/${MEDIA_APP_NAME}/<streamKey>.flv`);
  } else {
    console.log("RTMP media server is disabled because node-media-server is not installed.");
  }
});
