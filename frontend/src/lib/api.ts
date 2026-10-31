const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const TOKEN_STORAGE_KEY = "queuesense_admin_token";

export function getAdminToken(): string | null {
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function clearAdminToken(): void {
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export type CameraStatus = "online" | "offline";
export type CongestionLevel = "Low" | "Moderate" | "High" | "Critical";
export type CameraDataSource = "simulated" | "camera";

export interface PhoneCameraDetection {
  session_id: string;
  camera_id?: string;
  camera_name: string;
  connection_state: string;
  connected: boolean;
  receiving_frames: boolean;
  received_frames: number;
  width: number | null;
  height: number | null;
  ai_detection: string;
  detection_status?: string;
  people_count: number | null;
  detection_runs: number;
  average_confidence: number | null;
  detection_error: string | null;
  last_error: string | null;
  seconds_since_last_frame: number | null;
  seconds_since_last_detection: number | null;
}

export interface PhoneCameraStatusResponse {
  count: number;
  sessions: PhoneCameraDetection[];
}

export interface CameraDetectionHistoryItem {
  id: number;
  camera_id: string;
  camera_name: string;
  people_count: number;
  average_confidence: number | null;
  detected_at: string;
}

export interface CameraDetectionHistoryResponse {
  camera_id: string;
  items: CameraDetectionHistoryItem[];
}

export interface QueueSenseCamera {
  id: string;
  name: string;
  location: string;
  status: CameraStatus;
  people_count: number;
  capacity: number;
  congestion: CongestionLevel;
  queue_length: number;
  data_source: CameraDataSource;
}

export interface QueueSenseSummary {
  total_cameras: number;
  online_cameras: number;
  offline_cameras: number;
  total_people?: number;
  total_queue_length?: number;
  active_alerts?: number;
  estimated_people?: number;
  open_alerts?: number;
  data_mode: string;
  last_updated?: string;
}

export interface QueueSenseAlert {
  id: string;
  camera_id: string;
  camera_name?: string;
  location?: string;
  title: string;
  message?: string;
  severity: string;
  status: string;
  timestamp?: string;
  data_source: string;
}

export interface QueueSenseActivity {
  time: string;
  people: number;
}

export interface CreateCameraInput {
  name: string;
  location: string;
  capacity: number;
}

export type UserRole = "viewer" | "operator" | "admin";
export interface QueueSenseUser {
  id: number;
  email: string;
  role: UserRole;
  is_active: number;
  created_at: string;
}

async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(getAdminToken() ? { Authorization: `Bearer ${getAdminToken()}` } : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    let message = `Request failed: ${response.status} ${response.statusText}`;

    try {
      const errorBody: { detail?: unknown } = await response.json();
      if (typeof errorBody.detail === "string") {
        message = errorBody.detail;
      }
    } catch {
      // Keep the default HTTP error message.
    }

    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

async function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path, { method: "GET" });
}

export function getHealth() {
  return apiGet<{
    status: string;
    service: string;
    data_mode: string;
    timestamp?: string;
    database?: string;
  }>("/api/health");
}

export async function loginWithGoogle(credential: string): Promise<{ email: string; role: UserRole }> {
  const response = await apiRequest<{ access_token: string; user: { email: string; role: UserRole } }>("/api/auth/google", {
    method: "POST",
    body: JSON.stringify({ credential }),
  });
  window.localStorage.setItem(TOKEN_STORAGE_KEY, response.access_token);
  return response.user;
}

export function getAdminSession() {
  return apiGet<{ authenticated: boolean; email: string; role: UserRole }>("/api/auth/me");
}

export function getUsers() {
  return apiGet<{ items: QueueSenseUser[] }>("/api/users");
}

export function updateUserRole(userId: number, role: UserRole) {
  return apiRequest<{ message: string }>(`/api/users/${userId}/role`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export function getSummary() {
  return apiGet<QueueSenseSummary>("/api/summary");
}

export async function getCameras(): Promise<QueueSenseCamera[]> {
  const response = await apiGet<{
    items: QueueSenseCamera[];
    count: number;
    data_mode: string;
  }>("/api/cameras");

  return response.items;
}

export async function createCamera(
  camera: CreateCameraInput,
): Promise<QueueSenseCamera> {
  const response = await apiRequest<{
    message: string;
    camera: QueueSenseCamera;
  }>("/api/cameras", {
    method: "POST",
    body: JSON.stringify({
      name: camera.name.trim(),
      location: camera.location.trim(),
      capacity: camera.capacity,
    }),
  });

  return response.camera;
}

export async function deleteCamera(cameraId: string): Promise<void> {
  await apiRequest<{
    message: string;
    camera_id: string;
  }>(`/api/cameras/${encodeURIComponent(cameraId)}`, {
    method: "DELETE",
  });
}

export async function getAlerts(): Promise<QueueSenseAlert[]> {
  const response = await apiGet<{
    items: QueueSenseAlert[];
    count: number;
    data_mode: string;
  }>("/api/alerts");

  return response.items;
}

export async function getActivity(): Promise<QueueSenseActivity[]> {
  const response = await apiGet<{
    items: QueueSenseActivity[];
    count?: number;
    data_mode: string;
  }>("/api/activity");

  return response.items;
}

export async function getPhoneCameraStatus(): Promise<PhoneCameraStatusResponse> {
  return apiGet<PhoneCameraStatusResponse>("/api/phone-camera/status");
}

export async function getCameraDetectionHistory(
  cameraId: string,
  limit = 50,
): Promise<CameraDetectionHistoryResponse> {
  const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
  return apiGet<CameraDetectionHistoryResponse>(`/api/cameras/${encodeURIComponent(cameraId)}/history?limit=${safeLimit}`);
}

export function updateCameraRoi(cameraId: string, roi: { x1: number; y1: number; x2: number; y2: number } | null) {
  return apiRequest("/api/phone-camera/roi", {
    method: "POST",
    body: JSON.stringify(roi ? { camera_id: cameraId, enabled: true, ...roi } : { camera_id: cameraId, enabled: false }),
  });
}
