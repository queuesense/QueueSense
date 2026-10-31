
from ultralytics import YOLO

def main():
    print("Loading YOLO model...")

    # Downloads the pretrained model on its first run if needed.
    model = YOLO("yolo11n.pt")

    print("Model loaded successfully.")
    print("Running person detection on a test image...")

    # Uses a sample image from Ultralytics.
    results = model.predict(
        source="https://ultralytics.com/images/bus.jpg",
        classes=[0],  # COCO class 0 = person
        conf=0.35,
        save=True,
        verbose=False,
    )

    for result in results:
        count = len(result.boxes)
        print(f"People detected: {count}")
        print("Annotated result saved under the runs/detect folder.")

if __name__ == "__main__":
    main()
