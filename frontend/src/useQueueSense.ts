
import { useCallback, useEffect, useState } from "react";
import {
  getHealth,
  getSummary,
  getCameras,
  getAlerts,
  getActivity,
  type QueueSenseCamera,
  type QueueSenseSummary,
  type QueueSenseAlert,
  type QueueSenseActivity,
} from "./lib/api";

type ApiStatus = "connecting" | "connected" | "disconnected";

export function useQueueSense() {
  const [apiState, setApiState] = useState<ApiStatus>("connecting");
  const [apiError, setApiError] = useState("");
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const [summary, setSummary] =
    useState<QueueSenseSummary | null>(null);
  const [cameras, setCameras] = useState<QueueSenseCamera[]>([]);
  const [alerts, setAlerts] = useState<QueueSenseAlert[]>([]);
  const [activity, setActivity] = useState<QueueSenseActivity[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [healthData, summaryData, cameraData, alertData, activityData] =
        await Promise.all([
          getHealth(),
          getSummary(),
          getCameras(),
          getAlerts(),
          getActivity(),
        ]);

      if (healthData.status !== "ok") {
        throw new Error("Backend health check did not return OK.");
      }

      setSummary(summaryData);
      setCameras(cameraData);
      setAlerts(alertData);
      setActivity(activityData);
      setApiState("connected");
      setApiError("");
      setLastRefresh(new Date());
    } catch (error) {
      setApiState("disconnected");
      setApiError(
        error instanceof Error
          ? error.message
          : "Unable to connect to QueueSense backend.",
      );
    }
  }, []);

  useEffect(() => {
    void refresh();

    const intervalId = window.setInterval(() => {
      void refresh();
    }, 10_000);

    return () => window.clearInterval(intervalId);
  }, [refresh]);

  return {
    apiState,
    apiError,
    lastRefresh,
    summary,
    cameras,
    alerts,
    activity,
    refresh,
  };
}
