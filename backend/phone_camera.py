from __future__ import annotations

import asyncio
import base64
import re
import socket
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from ultralytics import YOLO

from database import set_camera_offline, update_live_camera_detection
from auth import require_admin

cv2.setNumThreads(1)

router = APIRouter(tags=["Phone Camera"])

BASE_DIR = Path(__file__).resolve().parent
PHONE_PAGE = BASE_DIR / "phone_camera.html"
MODEL_PATH = BASE_DIR / "yolo11n.pt"

DEFAULT_CAPACITY = 50
CONFIDENCE_THRESHOLD = 0.20
IOU_THRESHOLD = 0.45
INFERENCE_SIZE = 480
DB_WRITE_INTERVAL_SEC = 2.0

_model: YOLO | None = None
_model_lock = threading.Lock()
_model_ready = False

sessions: dict[str, dict[str, Any]] = {}
sessions_lock = asyncio.Lock()

# Stores normalized ROI boxes per camera_id: {"x1": 0.1, "y1": 0.1, "x2": 0.9, "y2": 0.9}
camera_rois: dict[str, dict[str, float]] = {}


def get_local_wifi_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except Exception:
        return "127.0.0.1"


def get_model() -> YOLO:
    global _model, _model_ready

    with _model_lock:
        if _model is None:
            if not MODEL_PATH.is_file():
                raise FileNotFoundError(f"YOLO model not found: {MODEL_PATH}")
            _model = YOLO(str(MODEL_PATH))

        if not _model_ready:
            dummy = np.zeros((INFERENCE_SIZE, INFERENCE_SIZE, 3), dtype=np.uint8)
            _model.predict(
                source=dummy,
                classes=[0],
                conf=CONFIDENCE_THRESHOLD,
                iou=IOU_THRESHOLD,
                imgsz=INFERENCE_SIZE,
                device="cpu",
                verbose=False,
            )
            _model_ready = True

        return _model


threading.Thread(target=get_model, daemon=True).start()


def run_yolo_boxes(
    image: np.ndarray,
    roi: dict[str, float] | None = None,
) -> dict[str, Any]:
    try:
        model = get_model()
        h, w = image.shape[:2]

        with _model_lock:
            predictions = model.predict(
                source=image,
                classes=[0],
                conf=CONFIDENCE_THRESHOLD,
                iou=IOU_THRESHOLD,
                imgsz=INFERENCE_SIZE,
                max_det=150,
                device="cpu",
                verbose=False,
            )

        result = predictions[0]
        boxes = result.boxes

        # tuple: (x1, y1, x2, y2, conf, inside_roi)
        parsed_boxes: list[tuple[int, int, int, int, float, bool]] = []
        confidences: list[float] = []
        valid_count = 0

        rx1 = int(roi["x1"] * w) if roi else 0
        ry1 = int(roi["y1"] * h) if roi else 0
        rx2 = int(roi["x2"] * w) if roi else w
        ry2 = int(roi["y2"] * h) if roi else h

        if boxes is not None and len(boxes) > 0:
            xyxy_list = boxes.xyxy.tolist()
            conf_list = boxes.conf.tolist()
            for coords, conf in zip(xyxy_list, conf_list):
                c_val = float(conf)
                x1, y1, x2, y2 = map(int, coords)
                # Check bottom-center anchor point (feet/standing position)
                cx = (x1 + x2) // 2
                cy = int(y1 + (y2 - y1) * 0.85)
                inside = (rx1 <= cx <= rx2) and (ry1 <= cy <= ry2)

                if inside:
                    valid_count += 1
                    confidences.append(c_val)

                parsed_boxes.append((x1, y1, x2, y2, c_val, inside))

        return {
            "ok": True,
            "people_count": valid_count,
            "confidences": confidences,
            "boxes": parsed_boxes,
            "error": None,
        }

    except Exception as exc:
        return {
            "ok": False,
            "people_count": None,
            "confidences": [],
            "boxes": [],
            "error": str(exc)[:300],
        }


def render_annotated_preview(
    image: np.ndarray,
    boxes: list[tuple[int, int, int, int, float, bool]],
    roi: dict[str, float] | None = None,
) -> str | None:
    annotated = image.copy()
    h, w = annotated.shape[:2]

    # Draw ROI Queue Zone Box if active
    if roi:
        rx1 = int(roi["x1"] * w)
        ry1 = int(roi["y1"] * h)
        rx2 = int(roi["x2"] * w)
        ry2 = int(roi["y2"] * h)
        cv2.rectangle(annotated, (rx1, ry1), (rx2, ry2), (235, 99, 37), 2)
        cv2.rectangle(
            annotated,
            (rx1, max(0, ry1 - 18)),
            (rx1 + 88, ry1),
            (235, 99, 37),
            -1,
        )
        cv2.putText(
            annotated,
            "QUEUE ZONE",
            (rx1 + 4, max(12, ry1 - 4)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.38,
            (255, 255, 255),
            1,
            cv2.LINE_AA,
        )

    for item in boxes:
        x1, y1, x2, y2, c_val, inside = item
        color = (22, 163, 74) if inside else (113, 113, 122)
        cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2 if inside else 1)
        label = f"{int(c_val * 100)}%" if inside else "OUT"
        cv2.rectangle(
            annotated,
            (x1, max(0, y1 - 16)),
            (x1 + 36, y1),
            color,
            -1,
        )
        cv2.putText(
            annotated,
            label,
            (x1 + 3, max(11, y1 - 3)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.38,
            (255, 255, 255),
            1,
            cv2.LINE_AA,
        )

    ok_enc, buffer = cv2.imencode(
        ".jpg",
        annotated,
        [int(cv2.IMWRITE_JPEG_QUALITY), 58],
    )
    if not ok_enc:
        return None
    return f"data:image/jpeg;base64,{base64.b64encode(buffer.tobytes()).decode('ascii')}"


def decode_base64_frame(data_url: str) -> np.ndarray:
    encoded = data_url.split(",", 1)[1] if "," in data_url else data_url
    raw_bytes = base64.b64decode(encoded)
    arr = np.frombuffer(raw_bytes, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        raise ValueError("Invalid image frame received.")
    return image


def _next_available_camera_id() -> str:
    used_ids = {item["camera_id"] for item in sessions.values()}
    index = 1
    while True:
        candidate = f"CAM-PHONE-{index:03d}"
        if candidate not in used_ids:
            return candidate
        index += 1


def _sanitize_camera_id(raw_id: str | None) -> str:
    if not raw_id or not raw_id.strip():
        return _next_available_camera_id()
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "-", raw_id.strip().upper())
    return cleaned[:32] or _next_available_camera_id()


async def yolo_worker_loop(state: dict[str, Any]) -> None:
    last_processed_seq = -1
    try:
        while True:
            try:
                seq = state["received_frames"]
                raw_frame = state.get("raw_frame")

                if raw_frame is None or seq == last_processed_seq:
                    await asyncio.sleep(0.03)
                    continue

                last_processed_seq = seq
                active_roi = camera_rois.get(state["camera_id"])
                result = await asyncio.to_thread(
                    run_yolo_boxes, raw_frame, active_roi
                )

                if not result["ok"]:
                    state["detection_status"] = "error"
                    state["detection_error"] = result["error"]
                    state["last_error"] = result["error"]
                    await asyncio.sleep(0.1)
                    continue

                confidences = result["confidences"]
                average_confidence = (
                    round(sum(confidences) / len(confidences), 3)
                    if confidences
                    else None
                )
                now = time.time()
                prev_count = state["people_count"]
                new_count = result["people_count"]

                state["latest_boxes"] = result["boxes"]
                state["people_count"] = new_count
                state["average_confidence"] = average_confidence
                state["detection_status"] = "active"
                state["detection_error"] = None
                state["last_error"] = None
                state["last_detection_at"] = now
                state["detection_runs"] += 1

                latest_img = state.get("raw_frame")
                if latest_img is not None:
                    state["preview_image"] = render_annotated_preview(
                        latest_img, state["latest_boxes"], active_roi
                    )

                should_write_db = (
                    (now - state.get("last_db_write_at", 0.0)) >= DB_WRITE_INTERVAL_SEC
                    or new_count != prev_count
                    or state["detection_runs"] == 1
                )

                if should_write_db:
                    detected_at = datetime.now(timezone.utc).isoformat()
                    try:
                        await asyncio.to_thread(
                            update_live_camera_detection,
                            camera_id=state["camera_id"],
                            camera_name=state["name"],
                            people_count=new_count,
                            confidence=average_confidence,
                            detected_at=detected_at,
                            capacity=DEFAULT_CAPACITY,
                            location=state["location"],
                        )
                        state["last_db_write_at"] = now
                    except Exception as exc:
                        state["database_error"] = str(exc)[:300]

                await asyncio.sleep(0.03)
            except asyncio.CancelledError:
                raise
            except Exception as loop_exc:
                state["last_error"] = str(loop_exc)[:250]
                await asyncio.sleep(0.1)
    except asyncio.CancelledError:
        raise


class FrameRequest(BaseModel):
    camera_id: str | None = Field(default=None, max_length=32)
    camera_name: str = Field(default="Gate Sensor", max_length=100)
    location: str = Field(default="Main Entrance", max_length=150)
    image: str = Field(min_length=20, max_length=4_000_000)


class StopRequest(BaseModel):
    session_id: str | None = None
    camera_id: str | None = None


class RoiUpdateRequest(BaseModel):
    camera_id: str = Field(min_length=1, max_length=32)
    enabled: bool = True
    x1: float = Field(default=0.1, ge=0.0, le=1.0)
    y1: float = Field(default=0.1, ge=0.0, le=1.0)
    x2: float = Field(default=0.9, ge=0.0, le=1.0)
    y2: float = Field(default=0.9, ge=0.0, le=1.0)


@router.post("/api/phone-camera/roi", dependencies=[Depends(require_admin)])
async def update_camera_roi(payload: RoiUpdateRequest):
    cid = _sanitize_camera_id(payload.camera_id)
    if not payload.enabled:
        camera_rois.pop(cid, None)
        return {"ok": True, "camera_id": cid, "roi": None}

    roi_box = {
        "x1": round(min(payload.x1, payload.x2), 3),
        "y1": round(min(payload.y1, payload.y2), 3),
        "x2": round(max(payload.x1, payload.x2), 3),
        "y2": round(max(payload.y1, payload.y2), 3),
    }
    camera_rois[cid] = roi_box
    return {"ok": True, "camera_id": cid, "roi": roi_box}


@router.get("/phone-camera")
async def phone_camera_page():
    if not PHONE_PAGE.is_file():
        raise HTTPException(status_code=500, detail="phone_camera.html is missing.")

    return FileResponse(
        str(PHONE_PAGE),
        media_type="text/html",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )


@router.post("/api/phone-camera/frame")
async def receive_frame(payload: FrameRequest):
    camera_id = _sanitize_camera_id(payload.camera_id)
    camera_name = payload.camera_name.strip() or f"Gate ({camera_id})"
    location = payload.location.strip() or "Main Entrance"

    try:
        image = decode_base64_frame(payload.image)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Frame decode error: {exc}") from exc

    height, width = image.shape[:2]
    now = time.time()

    async with sessions_lock:
        state = sessions.get(camera_id)
        if state is None:
            state = {
                "id": f"session-{camera_id.lower()}",
                "camera_id": camera_id,
                "name": camera_name,
                "location": location,
                "connected": True,
                "received_frames": 1,
                "width": width,
                "height": height,
                "last_frame_at": now,
                "last_error": None,
                "people_count": 0,
                "detection_status": "active",
                "detection_error": None,
                "last_detection_at": now,
                "last_db_write_at": 0.0,
                "average_confidence": None,
                "detection_runs": 0,
                "database_error": None,
                "raw_frame": image,
                "latest_boxes": [],
                "preview_image": None,
                "worker_task": None,
            }
            state["worker_task"] = asyncio.create_task(yolo_worker_loop(state))
            sessions[camera_id] = state
        else:
            state["name"] = camera_name
            state["location"] = location
            state["connected"] = True
            state["width"] = width
            state["height"] = height
            state["last_frame_at"] = now
            state["raw_frame"] = image
            state["received_frames"] += 1
            if state.get("worker_task") is None or state["worker_task"].done():
                state["worker_task"] = asyncio.create_task(yolo_worker_loop(state))

        boxes = state["latest_boxes"]

    active_roi = camera_rois.get(camera_id)
    state["preview_image"] = render_annotated_preview(image, boxes, active_roi)

    return {
        "ok": True,
        "session_id": state["id"],
        "camera_id": camera_id,
        "people_count": state["people_count"],
        "detection_runs": state["detection_runs"],
        "average_confidence": state["average_confidence"],
        "width": width,
        "height": height,
    }


@router.get("/api/phone-camera/status", dependencies=[Depends(require_admin)])
async def phone_camera_status():
    now = time.time()

    async with sessions_lock:
        stale_keys = [
            cid
            for cid, item in sessions.items()
            if item["last_frame_at"] is not None and (now - item["last_frame_at"]) > 30
        ]
        for cid in stale_keys:
            removed = sessions.pop(cid, None)
            if removed and removed.get("worker_task") and not removed["worker_task"].done():
                removed["worker_task"].cancel()
            await asyncio.to_thread(set_camera_offline, cid)

        current = list(sessions.values())

    results = []
    for item in current:
        last_frame = item["last_frame_at"]
        last_detection = item["last_detection_at"]
        is_fresh = last_frame is not None and (now - last_frame) < 10
        cid = item["camera_id"]

        results.append({
            "session_id": item["id"],
            "camera_id": cid,
            "camera_name": item["name"],
            "location": item["location"],
            "connection_state": "connected" if is_fresh else "disconnected",
            "connected": is_fresh,
            "receiving_frames": is_fresh,
            "received_frames": item["received_frames"],
            "width": item["width"],
            "height": item["height"],
            "seconds_since_last_frame": (
                round(now - last_frame, 2) if last_frame is not None else None
            ),
            "ai_detection": item["detection_status"],
            "people_count": item["people_count"],
            "detection_runs": item["detection_runs"],
            "average_confidence": item["average_confidence"],
            "seconds_since_last_detection": (
                round(now - last_detection, 2) if last_detection is not None else None
            ),
            "detection_error": item["detection_error"],
            "database_error": item["database_error"],
            "last_error": item["last_error"],
            "preview_image": item.get("preview_image"),
            "roi": camera_rois.get(cid),
        })

    return {
        "count": len(results),
        "sessions": results,
        "host_ip": get_local_wifi_ip(),
    }


@router.post("/api/phone-camera/stop", dependencies=[Depends(require_admin)])
async def stop_phone_camera(payload: StopRequest | None = None):
    target_session_id = payload.session_id if payload else None
    target_camera_id = payload.camera_id if payload else None

    async with sessions_lock:
        if target_session_id or target_camera_id:
            to_stop = [
                cid
                for cid, item in sessions.items()
                if cid == target_camera_id or item["id"] == target_session_id
            ]
            stopped_items = [sessions.pop(cid) for cid in to_stop]
        else:
            stopped_items = list(sessions.values())
            sessions.clear()

    for item in stopped_items:
        task = item.get("worker_task")
        if task and not task.done():
            task.cancel()
        await asyncio.to_thread(set_camera_offline, item["camera_id"])

    return {
        "message": "Stopped sensor session(s).",
        "stopped": len(stopped_items),
    }
