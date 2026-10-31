# QueueSense deployment

## Run with Docker

1. Create a Google Cloud OAuth **Web application** Client ID. Add the local and production web origins under **Authorized JavaScript origins**.
2. Copy `.env.example` to `.env`; set your Gmail in `APP_OWNER_EMAIL`, place the Client ID in both Google Client ID fields, and generate a random `APP_AUTH_SECRET` (32+ characters).
2. For real deployment, set `VITE_PUBLIC_BASE_URL` to the public **HTTPS** origin (for example, `https://queues.example.com`). Put a TLS reverse proxy in front of port 8080.
3. Run `docker compose up --build -d` and open `http://localhost:8080` for a local deployment.
4. Verify `docker compose ps`; both containers report health. The API check is available at `/api/health`.

The first Google account matching `APP_OWNER_EMAIL` becomes owner/admin. Other first-time Google sign-ins become viewers. The owner can promote them from Settings after their first sign-in; QueueSense never collects or stores users' Google passwords.

For a separate frontend/backend deployment, set `VITE_API_BASE_URL` at frontend build time and set `CORS_ORIGINS` on the backend to the exact frontend origin(s), comma-separated.

## Deploy on Render

This repository includes `render.yaml` and `Dockerfile.render` for a single public service. In Render, select **New → Blueprint**, connect `queuesense/QueueSense`, and provide `APP_OWNER_EMAIL` and `GOOGLE_CLIENT_ID`. Render generates `APP_AUTH_SECRET`.

After Render gives you its HTTPS URL, add that exact URL to the Google OAuth Client's **Authorized JavaScript origins**. The production build reads the Google Client ID from the backend at runtime, so no client ID is committed to Git.
