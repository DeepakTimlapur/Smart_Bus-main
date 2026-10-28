import base64
import getpass
import sys
import time

import cv2
import requests

BASE_URL = "http://localhost:3000/api/v1"
STUDENT_ID = ""
STUDENT_NAME = ""
SAMPLE_COUNT = 10
JPEG_QUALITY = 88


def api_error(response):
    try:
        data = response.json()
        return data.get("detail") or data.get("error") or str(data)
    except ValueError:
        return response.text[:500]


def capture_samples():
    camera = cv2.VideoCapture(0, cv2.CAP_DSHOW)
    if not camera.isOpened():
        camera.release()
        camera = cv2.VideoCapture(0, cv2.CAP_MSMF)

    if not camera.isOpened():
        raise RuntimeError(
            "Could not open camera 0. Close other camera applications and retry."
        )

    samples = []
    print("\nWebcam enrollment")
    print("Position one person's face clearly in the frame.")
    print("Press SPACE to capture a sample.")
    print("Press Q or ESC to cancel before submission.")
    print("Capture different natural angles and expressions.")

    try:
        while len(samples) < SAMPLE_COUNT:
            ok, frame = camera.read()
            if not ok:
                raise RuntimeError("Failed to read a webcam frame.")

            display = frame.copy()
            cv2.putText(
                display,
                f"Student: {STUDENT_ID}",
                (12, 28),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.65,
                (0, 255, 255),
                2,
            )
            cv2.putText(
                display,
                f"Samples: {len(samples)}/{SAMPLE_COUNT}",
                (12, 58),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.65,
                (0, 255, 0),
                2,
            )
            cv2.putText(
                display,
                "SPACE capture | Q/ESC cancel",
                (12, display.shape[0] - 15),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                (255, 255, 255),
                2,
            )
            cv2.imshow("CLI Face Enrollment", display)

            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), ord("Q"), 27):
                raise RuntimeError("Capture cancelled. No images submitted.")

            if key == 32:
                ok, encoded = cv2.imencode(
                    ".jpg",
                    frame,
                    [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY],
                )
                if not ok:
                    print("Could not encode frame; try again.")
                    continue

                image_data = base64.b64encode(encoded.tobytes()).decode("ascii")
                samples.append("data:image/jpeg;base64," + image_data)
                print(f"Captured sample {len(samples)}/{SAMPLE_COUNT}")
                time.sleep(0.2)
    finally:
        camera.release()
        cv2.destroyAllWindows()

    return samples


def main():
    global STUDENT_ID, STUDENT_NAME
    print("Smart Bus CLI Face Enrollment")
    STUDENT_ID = input("Enter student USN: ").strip().upper()
    if not STUDENT_ID:
        raise RuntimeError("Student USN is required.")
    print(f"Selected USN: {STUDENT_ID}")
    print("Images are held in memory and are not saved to disk.")

    username = input("Administrator username: ").strip()
    password = getpass.getpass("Administrator password: ")

    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})

    try:
        login_response = session.post(
            f"{BASE_URL}/auth/login",
            json={"username": username, "password": password},
            timeout=15,
        )
        if not login_response.ok:
            raise RuntimeError(
                f"Login failed (HTTP {login_response.status_code}): "
                f"{api_error(login_response)}"
            )

        login = login_response.json()
        if login.get("role") != "ADMIN":
            raise RuntimeError(
                "This operation requires an ADMIN account. No images captured."
            )

        token = login.get("access_token")
        if not token:
            raise RuntimeError("Login response did not contain an access token.")

        session.headers["Authorization"] = f"Bearer {token}"
        password = None

        status_response = session.get(
            f"{BASE_URL}/smart-bus/face/status",
            params={"student_id": STUDENT_ID},
            timeout=15,
        )
        if not status_response.ok:
            raise RuntimeError(
                f"Student status check failed (HTTP {status_response.status_code}): "
                f"{api_error(status_response)}"
            )

        status = status_response.json()
        if str(status.get("student_id", "")).strip().upper() != STUDENT_ID:
            raise RuntimeError(
                "The server did not confirm the requested student ID. Stopping."
            )
        if status.get("face_registered"):
            raise RuntimeError(
                "This student is already registered. No replacement was attempted."
            )

        print(
            f"Verified: {status.get('name', STUDENT_NAME)}; "
            f"status={status.get('face_enrollment_status', 'unknown')}"
        )
        STUDENT_NAME = str(status.get("name") or "").strip()
        if not STUDENT_NAME:
            raise RuntimeError("Server did not return the student name.")
        print(f"Verified student: {STUDENT_NAME} ({STUDENT_ID})")
        print(f"Enrollment status: {status.get('face_enrollment_status', 'unknown')}")
        print(f"Ensure the person in front of the camera is {STUDENT_NAME}.")
        confirmation = input("Type ENROLL to continue: ").strip()
        if confirmation != "ENROLL":
            raise RuntimeError("Cancelled by operator. No images submitted.")

        images = capture_samples()

        print("\nSubmitting images to the server for face detection and embedding...")
        print("Keep this terminal open while the server processes the samples.")

        response = session.post(
            f"{BASE_URL}/smart-bus/faces/enroll-samples",
            json={"student_id": STUDENT_ID, "images": images},
            timeout=240,
        )

        if not response.ok:
            raise RuntimeError(
                f"Enrollment rejected (HTTP {response.status_code}): "
                f"{api_error(response)}"
            )

        print("\nEnrollment endpoint response:")
        print(response.text[:3000])

        verify = session.get(
            f"{BASE_URL}/smart-bus/face/status",
            params={"student_id": STUDENT_ID},
            timeout=20,
        )
        if not verify.ok:
            raise RuntimeError(
                "Enrollment endpoint responded successfully, but final status "
                f"could not be verified (HTTP {verify.status_code}). Check the "
                "server and student record before retrying."
            )

        final_status = verify.json()
        print("\nFinal status:")
        print(f"Student: {final_status.get('name', STUDENT_NAME)}")
        print(f"ID: {final_status.get('student_id')}")
        print(f"Registered: {final_status.get('face_registered')}")
        print(f"Samples: {final_status.get('face_sample_count')}")
        print(f"Enrollment status: {final_status.get('face_enrollment_status')}")
        print(f"Model version: {final_status.get('face_model_version')}")

        if not final_status.get("face_registered"):
            raise RuntimeError(
                "The final status does not confirm registration. "
                "Do not retry blindly; inspect the server response."
            )

        print("\nVerified: the student is registered.")

    finally:
        session.headers.pop("Authorization", None)
        session.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(130)
    except Exception as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        sys.exit(1)



