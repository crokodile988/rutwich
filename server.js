const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_SIZE = 512 * 1024;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const VIEWER_TTL_MS = 90 * 1000;
const EVENT_HISTORY_LIMIT = 1000;

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

async function serveStatic(requestUrl, response) {
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

  const roomId = parts[2];
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

    await serveStatic(requestUrl, response);
  } catch (error) {
    console.error("Request error:", error);
    sendJson(response, 500, { error: error.message || "Internal server error." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Streaming MVP is running on http://${HOST}:${PORT}`);
});
