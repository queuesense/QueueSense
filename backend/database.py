import os
import sqlite3
from pathlib import Path

DATABASE_PATH = Path(os.getenv("DATABASE_PATH", Path(__file__).resolve().parent / "queuesense.db"))


def get_connection():
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_database():
    with get_connection() as connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS cameras (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                location TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'offline'
                    CHECK (status IN ('online', 'offline')),
                people_count INTEGER NOT NULL DEFAULT 0
                    CHECK (people_count >= 0),
                capacity INTEGER NOT NULL DEFAULT 100
                    CHECK (capacity > 0),
                congestion TEXT NOT NULL DEFAULT 'Low'
                    CHECK (
                        congestion IN (
                            'Low', 'Moderate', 'High', 'Critical'
                        )
                    ),
                queue_length INTEGER NOT NULL DEFAULT 0
                    CHECK (queue_length >= 0),
                data_source TEXT NOT NULL DEFAULT 'simulated'
                    CHECK (data_source IN ('simulated', 'camera'))
            )
        """)

        connection.execute("""
            CREATE TABLE IF NOT EXISTS detection_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                camera_id TEXT NOT NULL,
                camera_name TEXT NOT NULL,
                people_count INTEGER NOT NULL
                    CHECK (people_count >= 0),
                average_confidence REAL,
                detected_at TEXT NOT NULL
            )
        """)
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_detection_history_camera_id_id "
            "ON detection_history(camera_id, id DESC)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_detection_history_id "
            "ON detection_history(id DESC)"
        )
        connection.execute("""
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        connection.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                google_id TEXT UNIQUE,
                password_hash TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
                is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        user_columns = {row["name"] for row in connection.execute("PRAGMA table_info(users)")}
        if "google_id" not in user_columns:
            connection.execute("ALTER TABLE users ADD COLUMN google_id TEXT")

        connection.commit()


def get_admin_password_hash():
    with get_connection() as connection:
        row = connection.execute(
            "SELECT value FROM app_settings WHERE key = 'admin_password_hash'"
        ).fetchone()
        return row["value"] if row else None


def set_admin_password_hash(password_hash: str):
    with get_connection() as connection:
        connection.execute(
            "INSERT INTO app_settings (key, value) VALUES ('admin_password_hash', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (password_hash,),
        )
        connection.commit()


def count_users() -> int:
    with get_connection() as connection:
        return connection.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def get_user_by_email(email: str):
    with get_connection() as connection:
        row = connection.execute(
            "SELECT * FROM users WHERE email = ? COLLATE NOCASE", (email,)
        ).fetchone()
        return dict(row) if row else None


def get_user_by_id(user_id: int):
    with get_connection() as connection:
        row = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None


def get_user_by_google_id(google_id: str):
    with get_connection() as connection:
        row = connection.execute("SELECT * FROM users WHERE google_id = ?", (google_id,)).fetchone()
        return dict(row) if row else None


def list_users():
    with get_connection() as connection:
        rows = connection.execute(
            "SELECT id, email, role, is_active, created_at FROM users ORDER BY email COLLATE NOCASE"
        ).fetchall()
        return [dict(row) for row in rows]


def create_user(email: str, password_hash: str, role: str, google_id: str | None = None):
    with get_connection() as connection:
        cursor = connection.execute(
            "INSERT INTO users (email, password_hash, role, google_id) VALUES (?, ?, ?, ?)",
            (email, password_hash, role, google_id),
        )
        connection.commit()
        return get_user_by_id(cursor.lastrowid)


def update_user_password(user_id: int, password_hash: str):
    with get_connection() as connection:
        connection.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))
        connection.commit()


def set_user_google_id(user_id: int, google_id: str):
    with get_connection() as connection:
        connection.execute("UPDATE users SET google_id = ? WHERE id = ?", (google_id, user_id))
        connection.commit()


def update_user_role(user_id: int, role: str):
    with get_connection() as connection:
        connection.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
        connection.commit()


def list_cameras():
    with get_connection() as connection:
        rows = connection.execute(
            "SELECT * FROM cameras ORDER BY name"
        ).fetchall()
        return [dict(row) for row in rows]


def get_camera(camera_id: str):
    with get_connection() as connection:
        row = connection.execute(
            "SELECT * FROM cameras WHERE id = ?",
            (camera_id,),
        ).fetchone()
        return dict(row) if row else None


def save_camera(camera: dict):
    with get_connection() as connection:
        connection.execute("""
            INSERT INTO cameras (
                id, name, location, status, people_count,
                capacity, congestion, queue_length, data_source
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                location = excluded.location,
                status = excluded.status,
                people_count = excluded.people_count,
                capacity = excluded.capacity,
                congestion = excluded.congestion,
                queue_length = excluded.queue_length,
                data_source = excluded.data_source
        """, (
            camera["id"],
            camera["name"],
            camera["location"],
            camera.get("status", "offline"),
            camera.get("people_count", 0),
            camera.get("capacity", 100),
            camera.get("congestion", "Low"),
            camera.get("queue_length", 0),
            camera.get("data_source", "simulated"),
        ))
        connection.commit()


def set_camera_offline(camera_id: str):
    with get_connection() as connection:
        connection.execute(
            """
            UPDATE cameras
            SET status = 'offline', people_count = 0, queue_length = 0,
                congestion = 'Low'
            WHERE id = ?
            """,
            (camera_id,),
        )
        connection.commit()


def delete_camera(camera_id: str):
    with get_connection() as connection:
        cursor = connection.execute(
            "DELETE FROM cameras WHERE id = ?",
            (camera_id,),
        )
        connection.commit()
        return cursor.rowcount > 0


def calculate_congestion(people_count: int, capacity: int) -> str:
    if capacity <= 0:
        return "Low"

    occupancy = people_count / capacity * 100

    if occupancy >= 90:
        return "Critical"
    if occupancy >= 70:
        return "High"
    if occupancy >= 40:
        return "Moderate"
    return "Low"


def update_live_camera_detection(
    camera_id: str,
    camera_name: str,
    people_count: int,
    confidence: float | None,
    detected_at: str,
    capacity: int = 50,
    location: str = "Entrance Gate · Mobile AI Feed",
):
    """Atomically update the live camera and save its detection."""
    if people_count < 0:
        raise ValueError("people_count cannot be negative")

    capacity = max(1, capacity)
    congestion = calculate_congestion(people_count, capacity)
    queue_est = max(0, people_count - 2)

    with get_connection() as connection:
        connection.execute("""
            INSERT INTO cameras (
                id, name, location, status, people_count,
                capacity, congestion, queue_length, data_source
            )
            VALUES (?, ?, ?, 'online', ?, ?, ?, ?, 'camera')
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                location = excluded.location,
                status = 'online',
                people_count = excluded.people_count,
                capacity = excluded.capacity,
                congestion = excluded.congestion,
                queue_length = excluded.queue_length,
                data_source = 'camera'
        """, (
            camera_id,
            camera_name,
            location,
            people_count,
            capacity,
            congestion,
            queue_est,
        ))

        connection.execute("""
            INSERT INTO detection_history (
                camera_id, camera_name, people_count,
                average_confidence, detected_at
            )
            VALUES (?, ?, ?, ?, ?)
        """, (
            camera_id,
            camera_name,
            people_count,
            confidence,
            detected_at,
        ))

        connection.commit()


def save_detection(
    camera_id: str,
    camera_name: str,
    people_count: int,
    confidence: float | None,
    detected_at: str,
):
    """Save a detection without changing the current camera record."""
    with get_connection() as connection:
        connection.execute("""
            INSERT INTO detection_history (
                camera_id, camera_name, people_count,
                average_confidence, detected_at
            )
            VALUES (?, ?, ?, ?, ?)
        """, (
            camera_id,
            camera_name,
            people_count,
            confidence,
            detected_at,
        ))
        connection.commit()


def get_detection_history(camera_id: str, limit: int = 100):
    limit = max(1, min(limit, 1000))

    with get_connection() as connection:
        rows = connection.execute("""
            SELECT id, camera_id, camera_name, people_count,
                   average_confidence, detected_at
            FROM detection_history
            WHERE camera_id = ?
            ORDER BY id DESC
            LIMIT ?
        """, (camera_id, limit)).fetchall()

        return [dict(row) for row in rows]
