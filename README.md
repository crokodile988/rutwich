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
