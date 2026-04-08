# StreamHub RTMP MVP

Minimal streaming service with:

- Node.js app for rooms, pages, and catalog
- RTMP ingest through `node-media-server`
- HTTP-FLV playback in the browser through `flv.js`

## What it does

- Creates a room for a host
- Gives the host an RTMP URL and `stream key`
- Lets the host publish from OBS or another RTMP encoder
- Lets viewers watch the server-relayed stream in the browser
- Keeps room state in memory

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Default ports:

- App UI and API: `http://localhost:3000`
- RTMP ingest: `rtmp://localhost:1935/live`
- Internal media HTTP server: `8000`

Open:

- Home feed: `http://localhost:3000/`
- Studio page: `http://localhost:3000/studio.html`
- Viewer page: `http://localhost:3000/watch.html`
- Health check: `http://localhost:3000/healthz`

## How to test

1. Open `http://localhost:3000/studio.html`
2. Create a room
3. Copy the RTMP URL and stream key into OBS
4. Start streaming in OBS
5. Back in the studio, click `Показать в каталоге`
6. Open the viewer link in another browser tab or device

## Environment variables

### RTMP / media server

```bash
RTMP_PORT=1935
MEDIA_HTTP_PORT=8000
MEDIA_APP_NAME=live
MEDIA_PUBLIC_HOST=localhost
MEDIA_PUBLIC_HTTP_PORT=3000
MEDIA_PUBLIC_RTMP_PORT=1935
```

Notes:

- `MEDIA_HTTP_PORT` is the internal HTTP port used by `node-media-server`
- Viewers do not access it directly; the Node app proxies media through `/media/...`
- `MEDIA_PUBLIC_*` only affects URLs shown in the studio and API

### Optional TURN config

TURN is no longer the main delivery path, but the app still exposes `/api/rtc-config` if you want to keep experimental WebRTC features around.

```bash
STUN_URLS=stun:stun.l.google.com:19302
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_USERNAME=streamhub
TURN_PASSWORD=your-turn-password
```

Or with temporary coturn credentials:

```bash
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_SECRET=your-coturn-static-auth-secret
TURN_TTL_SECONDS=3600
TURN_USER_ID=streamhub
```

## Current limitations

- Rooms and live state are stored in memory only
- A restart clears rooms and live sessions
- Viewers are counted through lightweight room heartbeats, not a full analytics pipeline
- Browser playback depends on `MediaSource` support and `flv.js`
- This setup is good for MVPs and small demos, not for a large production streaming platform

## Render note

The web UI can run on Render, but public RTMP ingest usually needs a VPS or hosting that exposes TCP port `1935`.

Render web services are fine for:

- app pages
- API
- proxying HTTP-FLV playback

Render web services are usually not fine for:

- direct public RTMP ingest from OBS on `1935`

For a real public RTMP setup, run the app on a VPS or split the RTMP ingest onto another server.
