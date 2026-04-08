# Simple Streaming MVP

Minimal browser-based streaming service built with plain Node.js and WebRTC signaling.

## What it does

- Creates a room for one host.
- Lets the host stream screen or camera from the browser.
- Lets viewers join via a share link.
- Keeps all signaling and room state in memory.

## Run

```bash
npm start
```

Open:

- Home feed: `http://localhost:3000/`
- Studio page: `http://localhost:3000/studio.html`
- Viewer page: `http://localhost:3000/watch.html`
- Health check: `http://localhost:3000/healthz`

## How to test

1. Open the studio page in one browser window.
2. Create a room and start a stream.
3. Check that the stream appears on the home feed.
4. Open the generated viewer link in another browser or device.

## Current limitations

- This is peer-to-peer broadcasting, not HLS/RTMP delivery.
- Large audiences will overload the host browser.
- Without your own TURN server, some networks will fail to connect.
- Restarting the Node process clears all rooms.

## TURN support

The app now loads WebRTC `iceServers` from `GET /api/rtc-config`.

By default it still uses Google STUN only:

```bash
STUN_URLS=stun:stun.l.google.com:19302
```

To enable TURN, add your TURN URLs plus credentials as environment variables:

```bash
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_USERNAME=streamhub
TURN_PASSWORD=your-turn-password
```

You can also use coturn REST-style temporary credentials instead of static username/password:

```bash
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_SECRET=your-coturn-static-auth-secret
TURN_TTL_SECONDS=3600
TURN_USER_ID=streamhub
```

Notes:

- `TURN_URLS` is comma-separated.
- If `TURN_SECRET` is set, the server generates short-lived TURN credentials on demand.
- For a public demo, run coturn on a separate VPS or server with public UDP/TCP access.
- Render web services are fine for signaling, but TURN itself should usually run elsewhere.

## Deploy to Render

This repo now includes a `render.yaml` Blueprint for a Node web service.

1. Push this project to GitHub or GitLab.
2. In Render, choose `New +` -> `Blueprint`.
3. Connect the repository and let Render detect `render.yaml`.
4. Deploy the `streamhub` web service.

Current defaults in `render.yaml`:

- `plan: free`
- `region: frankfurt`
- `healthCheckPath: /healthz`

Notes:

- `free` is the cheapest option, but it can sleep and cold-start.
- If you want a steadier public demo, switch `plan` to a paid tier before the first deploy.
- This app stores rooms in memory, so any restart or redeploy clears active streams.
