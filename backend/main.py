from contextlib import asynccontextmanager
from datetime import datetime, timezone
from threading import Lock
import time
from pathlib import Path
import json
import uuid

import os

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from database import (
    get_connection,
    initialize_database,
    list_cameras,
    get_camera,
    save_camera,
    delete_camera,
    get_detection_history,
)
from phone_camera import router as phone_camera_router
from auth import (
    authenticate_google, create_access_token, initialize_admin, require_admin,
    require_operator, require_user,
)
from database import list_users, update_user_role

APP_NAME = "QueueSense API"
APP_VERSION = "2.0.0"

OLD_DEMO_IDS = ("CAM-001", "CAM-002", "CAM-003", "CAM-004", "CAM-005", "CAM-006")

# Dashboard viewers request the same SQLite-backed data. A tiny in-process cache
# prevents a busy audience from issuing identical database reads simultaneously.
_dashboard_cache: dict[str, tuple[float, object]] = {}
_dashboard_cache_lock = Lock()


def cached(key: str, ttl_seconds: float, loader):
    now = time.monotonic()
    with _dashboard_cache_lock:
        entry = _dashboard_cache.get(key)
        if entry and now - entry[0] < ttl_seconds:
            return entry[1]
        # Keep the load inside the lock to avoid a thundering herd of identical
        # SQLite reads when many browsers refresh at the same instant.
        value = loader()
        _dashboard_cache[key] = (now, value)
        return value


def invalidate_dashboard_cache() -> None:
    with _dashboard_cache_lock:
        _dashboard_cache.clear()


@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize_database()
    initialize_admin()
    # Remove old pre-seeded simulated demo cameras from SQLite
    with get_connection() as conn:
        conn.execute(
            "DELETE FROM cameras WHERE id IN (?, ?, ?, ?, ?, ?) AND data_source = 'simulated'",
            OLD_DEMO_IDS,
        )
        conn.commit()
    yield


app = FastAPI(
    title=APP_NAME,
    description="Real-time AI crowd monitoring and gate recommendation API.",
    version=APP_VERSION,
    lifespan=lifespan,
)


allowed_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


app.include_router(phone_camera_router)


@app.get("/runtime-config.js", include_in_schema=False)
def runtime_config():
    """Browser-safe runtime values for the single-container deployment."""
    client_id = os.getenv("GOOGLE_CLIENT_ID", "")
    return Response(
        content=f"window.__QUEUE_SENSE_CONFIG__={{googleClientId:{json.dumps(client_id)}}};",
        media_type="application/javascript",
        headers={"Cache-Control": "no-store"},
    )


class CameraCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    location: str = Field(min_length=1, max_length=200)
    capacity: int = Field(default=50, ge=1, le=100000)


class GoogleLoginRequest(BaseModel):
    credential: str = Field(min_length=20, max_length=10_000)


class UserRoleUpdate(BaseModel):
    role: str = Field(pattern="^(viewer|operator|admin)$")


@app.post("/api/auth/google")
def google_login(payload: GoogleLoginRequest):
    user = authenticate_google(payload.credential)
    return {"access_token": create_access_token(user), "token_type": "bearer", "user": {"email": user["email"], "role": user["role"]}}


@app.get("/api/auth/me")
def auth_me(claims: dict = Depends(require_user)):
    return {"authenticated": True, "email": claims["email"], "role": claims["role"]}


@app.get("/api/users", dependencies=[Depends(require_admin)])
def get_users():
    return {"items": list_users()}


@app.patch("/api/users/{user_id}/role", dependencies=[Depends(require_admin)])
def update_user_role_endpoint(user_id: int, payload: UserRoleUpdate):
    user = next((item for item in list_users() if item["id"] == user_id), None)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")
    update_user_role(user_id, payload.role)
    return {"message": "User role updated."}


def build_live_alerts(cameras: list[dict]) -> list[dict]:
    alerts = []
    now_iso = datetime.now(timezone.utc).isoformat()
    for cam in cameras:
        if cam["status"] == "online" and cam["congestion"] in ("High", "Critical"):
            alerts.append({
                "id": f"ALT-{cam['id']}",
                "camera_id": cam["id"],
                "camera_name": cam["name"],
                "location": cam["location"],
                "severity": cam["congestion"].lower(),
                "title": f"{cam['congestion']} crowd at {cam['name']} ({cam['people_count']} people)",
                "message": "Recommend routing visitors to a less crowded gate.",
                "timestamp": now_iso,
                "status": "active",
                "data_source": cam["data_source"],
            })
    return alerts


def camera_summary(cameras: list[dict]) -> dict:
    total = len(cameras)
    online = sum(camera["status"] == "online" for camera in cameras)
    total_people = sum(
        camera["people_count"] for camera in cameras if camera["status"] == "online"
    )
    alerts = build_live_alerts(cameras)

    return {
        "total_cameras": total,
        "online_cameras": online,
        "offline_cameras": total - online,
        "total_people": total_people,
        "estimated_people": total_people,
        "total_queue_length": sum(camera["queue_length"] for camera in cameras),
        "active_alerts": len(alerts),
        "data_mode": "live_camera" if any(c["data_source"] == "camera" for c in cameras) else "database",
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/")
def root():
    return {
        "name": APP_NAME,
        "version": APP_VERSION,
        "status": "running",
        "health": "/api/health",
    }


@app.get("/api/health")
def health_check():
    return {
        "status": "healthy",
        "service": APP_NAME,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "database": "sqlite",
    }


@app.get("/api/summary")
def get_summary(_: dict = Depends(require_user)):
    return cached("summary", 1.0, lambda: camera_summary(list_cameras()))


@app.get("/api/cameras")
def get_cameras_endpoint(_: dict = Depends(require_user)):
    def load_cameras():
        cameras = list_cameras()
        return {"items": cameras, "count": len(cameras), "data_mode": "live"}
    return cached("cameras", 1.0, load_cameras)


@app.get("/api/places")
def get_places_endpoint():
    """Place Folder names for the phone-sensor pairing form."""
    def load_places():
        places = sorted({
            camera["location"].strip()
            for camera in list_cameras()
            if camera.get("location", "").strip()
        }, key=str.casefold)
        return {"items": places, "count": len(places)}
    return cached("places", 10.0, load_places)


@app.get("/api/cameras/{camera_id}")
def get_camera_endpoint(camera_id: str, _: dict = Depends(require_user)):
    camera = get_camera(camera_id)
    if camera is None:
        raise HTTPException(status_code=404, detail="Camera not found")
    return camera


@app.get("/api/cameras/{camera_id}/history")
def get_camera_detection_history(
    camera_id: str,
    limit: int = Query(default=100, ge=1, le=1000),
    _: dict = Depends(require_user),
):
    return cached(
        f"history:{camera_id}:{limit}",
        3.0,
        lambda: {"camera_id": camera_id, "items": get_detection_history(camera_id, limit)},
    )


@app.post("/api/cameras", status_code=201, dependencies=[Depends(require_operator)])
def create_camera_endpoint(camera_data: CameraCreate):
    name = camera_data.name.strip()
    location = camera_data.location.strip()

    if not name or not location:
        raise HTTPException(
            status_code=422, detail="Camera name and location cannot be blank."
        )

    camera_id = f"CAM-{uuid.uuid4().hex[:6].upper()}"
    camera = {
        "id": camera_id,
        "name": name,
        "location": location,
        "status": "offline",
        "people_count": 0,
        "capacity": camera_data.capacity,
        "congestion": "Low",
        "queue_length": 0,
        "data_source": "camera",
    }
    save_camera(camera)
    invalidate_dashboard_cache()

    return {
        "message": "Camera registered successfully",
        "camera": camera,
    }


@app.delete("/api/cameras/{camera_id}", dependencies=[Depends(require_admin)])
def delete_camera_endpoint(camera_id: str):
    if get_camera(camera_id) is None:
        raise HTTPException(status_code=404, detail="Camera not found")

    if not delete_camera(camera_id):
        raise HTTPException(status_code=500, detail="Unable to delete camera.")
    invalidate_dashboard_cache()

    return {
        "message": "Camera deleted successfully",
        "camera_id": camera_id,
    }


@app.get("/api/alerts")
def get_alerts(_: dict = Depends(require_user)):
    def load_alerts():
        alerts = build_live_alerts(list_cameras())
        return {"items": alerts, "count": len(alerts), "data_mode": "live"}
    return cached("alerts", 1.0, load_alerts)


@app.get("/api/activity")
def get_activity(_: dict = Depends(require_user)):
    def load_activity():
        with get_connection() as conn:
            rows = conn.execute(
            """
            SELECT detected_at, people_count
            FROM detection_history
            ORDER BY id DESC
            LIMIT 25
            """
            ).fetchall()
        items = [
            {
                "time": row["detected_at"][11:19] if len(row["detected_at"]) >= 19 else row["detected_at"],
                "people": row["people_count"],
            }
            for row in reversed(rows)
        ]
        return {"items": items, "count": len(items), "data_mode": "live"}
    return cached("activity", 3.0, load_activity)


# Render deployment: serve the Vite build from the same HTTPS origin as the API.
STATIC_DIR = Path(__file__).resolve().parent / "static"
if STATIC_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def single_page_app(path: str):
        requested = STATIC_DIR / path
        if path and requested.is_file():
            return FileResponse(requested)
        return FileResponse(STATIC_DIR / "index.html")
