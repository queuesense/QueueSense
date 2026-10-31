
from pathlib import Path
from threading import Lock

import cv2
from ultralytics import YOLO

MODEL_PATH = Path(__file__).parent / "yolov8n.pt"

_model = None
_model_lock = Lock()


def get_model():
    global _model

    with _model_lock:
        if _model is None:
            _model = YOLO("yolov8n.pt")

        return _model


def detect_people(frame):
    """
    Detect people in an OpenCV BGR frame.
    Returns the annotated frame and the detected person count.
    """
    if frame is None or frame.size == 0:
        raise ValueError("Received an empty camera frame")

    model = get_model()

    with _model_lock:
        results = model.predict(
            source=frame,
            classes=[0],       # COCO class 0 = person
            conf=0.35,
            verbose=False,
        )

    result = results[0]
    person_count = (
        0 if result.boxes is None else len(result.boxes)
    )
    annotated_frame = result.plot()

    return annotated_frame, person_count
