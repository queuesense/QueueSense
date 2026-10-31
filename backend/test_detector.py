
import cv2
from detector import detect_people

# A blank image checks that the detector runs,
# but it does not verify real-world detection accuracy.
frame = cv2.imread("test_crowd.jpg")

if frame is None:
    raise FileNotFoundError(
        "Put a test image named test_crowd.jpg in the backend folder."
    )

annotated_frame, count = detect_people(frame)

print("Detected people:", count)

cv2.imwrite("detected_output.jpg", annotated_frame)
print("Saved annotated image: detected_output.jpg")
