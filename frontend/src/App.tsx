import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock,
  Copy,
  Crop,
  Download,
  Eye,
  EyeOff,
  Film,
  Folder,
  FolderOpen,
  LayoutGrid,
  LogOut,
  Menu,
  Map as MapIcon,
  Maximize2,
  Monitor,
  Plus,
  Radio,
  Settings,
  Smartphone,
  Sparkles,
  Trash2,
  UserCheck,
  Users,
  X,
  Zap,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useLocation, useNavigate } from 'react-router-dom'

import {
  getHealth,
  getSummary,
  getCameras,
  createCamera,
  deleteCamera,
  getPhoneCameraStatus,
  getCameraDetectionHistory,
  loginWithGoogle,
  getAdminSession,
  clearAdminToken,
  updateCameraRoi,
  getUsers,
  updateUserRole,
  type QueueSenseCamera,
  type QueueSenseSummary,
  type PhoneCameraDetection,
  type CameraDetectionHistoryItem,
  type QueueSenseUser,
  type UserRole,
} from './lib/api'

type RoiBox = {
  x1: number
  y1: number
  x2: number
  y2: number
}

type CameraNode = {
  id: string
  name: string
  place: string
  count: number
  capacity: number
  occupancyPct: number
  waitMinutes: number
  congestionLabel: string
  status: 'Online' | 'Offline'
  previewUrl: string | null
  runs: number
  confidencePct: number | null
  roi: RoiBox | null
}

type PlaceFolder = {
  name: string
  cameras: CameraNode[]
  onlineCount: number
  totalPeople: number
  totalCapacity: number
  occupancyPct: number
  bestCamera: CameraNode | null
}

type SectionView = 'explorer' | 'wayfinding' | 'analytics' | 'settings'

declare global {
  interface Window {
    google?: any
    __QUEUE_SENSE_CONFIG__?: { googleClientId?: string }
  }
}

function getDefaultHostIp(): string {
  if (typeof window !== 'undefined') {
    const host = window.location.hostname
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
      return host
    }
  }
  return '10.145.33.61'
}

export default function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const viewFromUrl = (): SectionView => {
    const requested = new URLSearchParams(location.search).get('view')
    return requested === 'wayfinding' || requested === 'analytics' || requested === 'settings'
      ? requested
      : 'explorer'
  }
  // Single-Window Folder -> File Explorer Navigation
  const [section, setSection] = useState<SectionView>(viewFromUrl)
  const [activePlaceName, setActivePlaceName] = useState<string | null>(null)
  const [inspectedCameraId, setInspectedCameraId] = useState<string | null>(null)
  const [placeViewMode, setPlaceViewMode] = useState<'grid' | 'floorplan'>(
    'grid',
  )

  // Local Admin Authentication State
  const [isAdmin, setIsAdmin] = useState<boolean>(false)
  const [userRole, setUserRole] = useState<UserRole>('viewer')
  const [userEmail, setUserEmail] = useState('')
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [showLoginModal, setShowLoginModal] = useState<boolean>(false)
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false)
  const [isSigningIn, setIsSigningIn] = useState<boolean>(false)
  const [showGoogleFallback, setShowGoogleFallback] = useState<boolean>(false)
  const [googleRenderAttempt, setGoogleRenderAttempt] = useState(0)
  const [isNavigating, setIsNavigating] = useState(false)
  const [loginError, setLoginError] = useState<string>('')
  const googleButtonRef = useRef<HTMLDivElement | null>(null)

  // Per-camera video hiding when Admin is logged in
  const [hiddenVideoIds, setHiddenVideoIds] = useState<Set<string>>(new Set())

  // Interactive ROI Drawing State
  const [isDrawingRoi, setIsDrawingRoi] = useState<boolean>(false)
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(
    null,
  )
  const [draftRoi, setDraftRoi] = useState<RoiBox | null>(null)
  const videoStageRef = useRef<HTMLDivElement | null>(null)

  // Strong Password Change State
  const [users, setUsers] = useState<QueueSenseUser[]>([])
  const [userMessage, setUserMessage] = useState<string>('')
  const [userSearch, setUserSearch] = useState('')

  // Instant Clip Recording State (.webm)
  const [recordingCamId, setRecordingCamId] = useState<string | null>(null)
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const recordChunksRef = useRef<Blob[]>([])

  // Network & Pairing
  const [hostIp, setHostIp] = useState<string>(getDefaultHostIp)
  const [manualIpOverride, setManualIpOverride] = useState(false)
  const [showPairModal, setShowPairModal] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  const [toast, setToast] = useState('')

  const canOperate = isAdmin || userRole === 'operator'

  // Live Telemetry State
  const [connected, setConnected] = useState(false)
  const [dbCameras, setDbCameras] = useState<QueueSenseCamera[]>([])
  const [summary, setSummary] = useState<QueueSenseSummary | null>(null)
  const [phoneSessions, setPhoneSessions] = useState<PhoneCameraDetection[]>([])
  const [selectedAnalyticsCamId, setSelectedAnalyticsCamId] =
    useState<string>('CAM-PHONE-001')
  const [historyItems, setHistoryItems] = useState<
    CameraDetectionHistoryItem[]
  >([])
  const [lastSync, setLastSync] = useState<Date | null>(null)

  // Create Gate Form
  const [newGateName, setNewGateName] = useState('')
  const [newPlaceName, setNewPlaceName] = useState('')
  const [newCapacity, setNewCapacity] = useState('50')
  const [submittingGate, setSubmittingGate] = useState(false)

  const streamLockRef = useRef(false)
  const summaryLockRef = useRef(false)

  const phoneCameraUrl = useMemo(() => {
    const phoneBackend = import.meta.env.VITE_PHONE_CAMERA_BASE_URL?.trim()
    if (phoneBackend) return `${phoneBackend.replace(/\/$/, '')}/phone-camera`
    const configuredBase = import.meta.env.VITE_PUBLIC_BASE_URL?.trim()
    if (configuredBase) return `${configuredBase.replace(/\/$/, '')}/phone-camera`
    // A phone needs HTTPS for getUserMedia. Vite's HTTP development origin is
    // therefore proxied for the dashboard only; pair phones with the backend.
    if (typeof window !== 'undefined' && window.location.port === '5173') {
      const host = hostIp.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      return `https://${host}:8443/phone-camera`
    }
    if (typeof window !== 'undefined') return `${window.location.origin}/phone-camera`
    return `https://${hostIp}/phone-camera`
  }, [hostIp])

  function showToast(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(''), 2800)
  }

  function navigateTo(nextSection: SectionView) {
    if (nextSection === section) return
    setMobileSidebarOpen(false)
    setIsNavigating(true)
    window.setTimeout(() => {
      setSection(nextSection)
      setInspectedCameraId(null)
      navigate(nextSection === 'explorer' ? '/' : `/?view=${nextSection}`)
      setIsNavigating(false)
    }, 180)
  }

  useEffect(() => {
    const nextSection = viewFromUrl()
    const placeFromUrl = new URLSearchParams(location.search).get('place')
    setSection(nextSection)
    setActivePlaceName(nextSection === 'explorer' ? placeFromUrl : null)
    if (nextSection !== 'explorer') setInspectedCameraId(null)
  }, [location.search])

  // Phones open directly to the compact queue board. The desktop workspace is
  // still available on larger screens, where its persistent sidebar is useful.
  useEffect(() => {
    if (!window.matchMedia('(max-width: 767px)').matches || section === 'wayfinding') return
    setSection('wayfinding')
    setActivePlaceName(null)
    setInspectedCameraId(null)
    navigate('/?view=wayfinding', { replace: true })
  }, [navigate, section])


async function handleGoogleLogin(credential: string) {
  setLoginError('')
  setIsSigningIn(true)

  try {
    // Step 1: Authenticate with Google
    const user = await loginWithGoogle(credential)

    // Step 2: Complete login immediately
    setIsAdmin(user.role === 'admin')
    setUserRole(user.role)
    setUserEmail(user.email)
    setIsAuthenticated(true)
    setShowLoginModal(false)

    showToast('Signed in successfully')

    // Step 3: Load admin users separately
    if (user.role === 'admin') {
      try {
        const result = await getUsers()
        setUsers(result.items)
      } catch (error) {
        console.error('Failed to load users:', error)
        setUserMessage(
          'Signed in, but could not load the user list.'
        )
      }
    }

  } catch (error) {
    console.error('Google authentication failed:', error)

    setLoginError(
      error instanceof Error
        ? error.message
        : 'Google authentication failed. Please try again.'
    )

  } finally {
    setIsSigningIn(false)
  }
}


  async function handleUserRoleChange(userId: number, role: UserRole) {
    setUserMessage('')
    try {
      await updateUserRole(userId, role)
      setUsers((await getUsers()).items)
      setUserMessage('Role updated.')
    } catch (error) {
      setUserMessage(error instanceof Error ? error.message : 'Could not update role.')
    }
  }

  async function saveRoiToBackend(cameraId: string, box: RoiBox | null) {
    try {
      await updateCameraRoi(cameraId, box)
      showToast(
        box
          ? `Active Queue Zone applied to ${cameraId}`
          : `Queue Zone cleared for ${cameraId}`,
      )
    } catch {
      showToast('Saved Queue Zone locally')
    }
  }

  useEffect(() => {
    void getAdminSession()
      .then(async (session) => {
        setIsAuthenticated(true)
        setIsAdmin(session.role === 'admin')
        setUserRole(session.role)
        setUserEmail(session.email)
        if (session.role === 'admin') setUsers((await getUsers()).items)
      })
      .catch(() => {
        clearAdminToken()
        setShowLoginModal(true)
      })
  }, [])

  const visibleUsers = useMemo(() => {
    const query = userSearch.trim().toLowerCase()
    return query ? users.filter((user) => user.email.toLowerCase().includes(query)) : users
  }, [userSearch, users])

  useEffect(() => {
    if (!showLoginModal || !googleButtonRef.current) return
    const clientId = window.__QUEUE_SENSE_CONFIG__?.googleClientId || import.meta.env.VITE_GOOGLE_CLIENT_ID
    if (!clientId) {
      setLoginError('Google Sign-In is not configured yet.')
      return
    }
    const fallbackTimer = window.setTimeout(() => setShowGoogleFallback(true), 900)
    const render = () => {
      if (!googleButtonRef.current || !window.google) return
      window.clearTimeout(fallbackTimer)
      googleButtonRef.current.replaceChildren()
      window.google?.accounts.id.initialize({ client_id: clientId, callback: (response: { credential: string }) => void handleGoogleLogin(response.credential) })
      window.google.accounts.id.renderButton(googleButtonRef.current, { theme: 'outline', size: 'large', width: 320, text: 'continue_with' })
      setShowGoogleFallback(false)
    }
    if (window.google?.accounts?.id) render()
    else {
      const existing = document.getElementById('google-gsi-client') as HTMLScriptElement | null
      const script = existing ?? document.createElement('script')
      if (!existing) {
        script.id = 'google-gsi-client'
        script.src = 'https://accounts.google.com/gsi/client'
        script.async = true
        document.head.appendChild(script)
      }
      script.addEventListener('load', render, { once: true })
      script.addEventListener('error', () => {
        setShowGoogleFallback(true)
        setLoginError('Google Sign-In could not load. Check your internet connection and try again.')
      }, { once: true })
    }
    return () => window.clearTimeout(fallbackTimer)
  }, [googleRenderAttempt, showLoginModal])

  function openGoogleSignIn() {
    if (window.google?.accounts?.id) {
      window.google.accounts.id.prompt()
      return
    }
    setGoogleRenderAttempt((attempt) => attempt + 1)
  }

  function toggleCameraVideoVisibility(cameraId: string) {
    setHiddenVideoIds((prev) => {
      const next = new Set(prev)
      if (next.has(cameraId)) {
        next.delete(cameraId)
      } else {
        next.add(cameraId)
      }
      return next
    })
  }

  // Instant Snapshot Download (.jpg)
  function downloadInstantSnap(camId: string, previewUrl: string | null) {
    if (!isAdmin || !previewUrl) return
    const link = document.createElement('a')
    link.href = previewUrl
    link.download = `${camId}-snap-${Date.now()}.jpg`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    showToast(`Saved snapshot (${camId}.jpg)`)
  }

  // Instant Client-Side Video Clip Recorder (.webm)
  function toggleClipRecord(camId: string, initialPreview: string | null) {
    if (!isAdmin) return

    if (recordingCamId === camId && recorderRef.current) {
      recorderRef.current.stop()
      return
    }

    if (!initialPreview) {
      showToast('Wait for live frame before recording.')
      return
    }

    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 360
    recordCanvasRef.current = canvas

    const stream = canvas.captureStream(12)
    const recorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm',
    })

    recordChunksRef.current = []
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        recordChunksRef.current.push(e.data)
      }
    }

    recorder.onstop = () => {
      const blob = new Blob(recordChunksRef.current, { type: 'video/webm' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${camId}-clip-${Date.now()}.webm`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.setTimeout(() => URL.revokeObjectURL(url), 3000)
      setRecordingCamId(null)
      setRecordingSeconds(0)
      recorderRef.current = null
      recordCanvasRef.current = null
      showToast(`Saved video clip (${camId}.webm)`)
    }

    recorderRef.current = recorder
    setRecordingCamId(camId)
    setRecordingSeconds(0)
    recorder.start(200)
    showToast(`Recording clip for ${camId}...`)
  }

  useEffect(() => {
    if (!recordingCamId) return
    const timer = window.setInterval(() => {
      setRecordingSeconds((s) => s + 1)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [recordingCamId])

  useEffect(() => {
    if (!recordingCamId || !recordCanvasRef.current) return
    const session = phoneSessions.find((s) => s.camera_id === recordingCamId)
    const raw = session as unknown as Record<string, unknown> | undefined
    const preview =
      typeof raw?.preview_image === 'string' ? raw.preview_image : null
    if (!preview) return

    const img = new Image()
    img.onload = () => {
      const canvas = recordCanvasRef.current
      if (!canvas) return
      canvas.width = img.width || 640
      canvas.height = img.height || 360
      const ctx = canvas.getContext('2d')
      ctx?.drawImage(img, 0, 0)
    }
    img.src = preview
  }, [phoneSessions, recordingCamId])

  // Admin-only preview/status poll. A sub-second interval per connected browser
  // would overload the backend as the number of viewers grows.
  const syncStreams = useCallback(async () => {
    if (!canOperate || document.visibilityState !== 'visible') return
    if (streamLockRef.current) return
    streamLockRef.current = true
    try {
      const status = await getPhoneCameraStatus()
      const autoIp = (status as unknown as { host_ip?: string }).host_ip
      if (!manualIpOverride && autoIp && autoIp !== '127.0.0.1') {
        setHostIp(autoIp)
      }
      setPhoneSessions(status.sessions ?? [])
      setConnected(true)
      setLastSync(new Date())
    } catch {
      // handled by summary loop
    } finally {
      streamLockRef.current = false
    }
  }, [canOperate, manualIpOverride])

  // Shared dashboard data changes at the detector write interval (2 seconds),
  // so a 5-second client refresh is responsive without multiplying DB reads.
  const syncDatabase = useCallback(async () => {
    if (!isAuthenticated) return
    if (document.visibilityState !== 'visible') return
    if (summaryLockRef.current) return
    summaryLockRef.current = true
    try {
      await getHealth()
      const [sumData, camList] = await Promise.all([getSummary(), getCameras()])
      setSummary(sumData)
      setDbCameras(camList)
      setConnected(true)

      const targetCam = inspectedCameraId || selectedAnalyticsCamId
      if (targetCam) {
        try {
          const hist = await getCameraDetectionHistory(targetCam, 60)
          setHistoryItems(hist.items)
        } catch {
          setHistoryItems([])
        }
      }
    } catch {
      setConnected(false)
    } finally {
      summaryLockRef.current = false
    }
  }, [inspectedCameraId, isAuthenticated, selectedAnalyticsCamId])

  useEffect(() => {
    if (!canOperate) {
      setPhoneSessions([])
      return
    }
    void syncStreams()
    const t = window.setInterval(() => void syncStreams(), 1000)
    return () => window.clearInterval(t)
  }, [canOperate, syncStreams])

  useEffect(() => {
    if (!isAuthenticated) return
    void syncDatabase()
    const t = window.setInterval(() => void syncDatabase(), 5000)
    return () => window.clearInterval(t)
  }, [isAuthenticated, syncDatabase])

  // Combine SQLite cameras + active sessions
  const allCameraNodes = useMemo<CameraNode[]>(() => {
    const sessionMap = new Map<string, PhoneCameraDetection>()
    phoneSessions.forEach((s) => {
      if (s.camera_id) sessionMap.set(s.camera_id, s)
    })

    const nodes: CameraNode[] = []
    const seenIds = new Set<string>()

    dbCameras.forEach((cam) => {
      const id = String(cam.id)
      seenIds.add(id)
      const liveSession = sessionMap.get(id)
      const rawCam = cam as unknown as Record<string, unknown>
      const capacity =
        typeof rawCam.capacity === 'number' && rawCam.capacity > 0
          ? rawCam.capacity
          : 50

      const isOnline =
        (liveSession?.connected && liveSession?.receiving_frames) ||
        cam.status === 'online'
      const count =
        liveSession?.people_count != null
          ? liveSession.people_count
          : cam.people_count
      const occupancyPct = Math.min(100, Math.round((count / capacity) * 100))
      const waitMinutes = count === 0 ? 0 : Math.max(1, Math.ceil(count / 5))

      const rawSession = liveSession as unknown as
        | Record<string, unknown>
        | undefined
      const previewUrl =
        typeof rawSession?.preview_image === 'string'
          ? rawSession.preview_image
          : null
      const roi = (rawSession?.roi as RoiBox | undefined) ?? null

      nodes.push({
        id,
        name: liveSession?.camera_name || cam.name,
        place:
          (typeof rawSession?.location === 'string' && rawSession.location) ||
          cam.location ||
          'Main Entrance',
        count,
        capacity,
        occupancyPct,
        waitMinutes,
        congestionLabel: cam.congestion || 'Low',
        status: isOnline ? 'Online' : 'Offline',
        previewUrl,
        runs: liveSession?.detection_runs ?? 0,
        confidencePct:
          liveSession?.average_confidence != null
            ? Math.round(liveSession.average_confidence * 100)
            : null,
        roi,
      })
    })

    phoneSessions.forEach((s, i) => {
      const id = s.camera_id || `CAM-PHONE-00${i + 1}`
      if (seenIds.has(id)) return
      const rawSession = s as unknown as Record<string, unknown>
      const count = s.people_count ?? 0
      const occupancyPct = Math.min(100, Math.round((count / 50) * 100))
      nodes.push({
        id,
        name: s.camera_name || id,
        place:
          (typeof rawSession.location === 'string' && rawSession.location) ||
          'Main Entrance',
        count,
        capacity: 50,
        occupancyPct,
        waitMinutes: count === 0 ? 0 : Math.max(1, Math.ceil(count / 5)),
        congestionLabel: count > 25 ? 'High' : count > 10 ? 'Moderate' : 'Low',
        status: s.connected ? 'Online' : 'Offline',
        previewUrl:
          typeof rawSession.preview_image === 'string'
            ? rawSession.preview_image
            : null,
        runs: s.detection_runs ?? 0,
        confidencePct:
          s.average_confidence != null
            ? Math.round(s.average_confidence * 100)
            : null,
        roi: (rawSession.roi as RoiBox | undefined) ?? null,
      })
    })

    return nodes
  }, [dbCameras, phoneSessions])

  // Group into Place Folders
  const placeFolders = useMemo<PlaceFolder[]>(() => {
    const groups = new Map<string, CameraNode[]>()
    allCameraNodes.forEach((node) => {
      const placeKey = node.place.trim() || 'Main Entrance'
      const list = groups.get(placeKey) ?? []
      list.push(node)
      groups.set(placeKey, list)
    })

    return Array.from(groups.entries()).map(([name, cams]) => {
      const onlineCams = cams.filter((c) => c.status === 'Online')
      const sortedOnline = [...onlineCams].sort((a, b) => a.count - b.count)
      const totalPeople = onlineCams.reduce((acc, c) => acc + c.count, 0)
      const totalCapacity = cams.reduce((acc, c) => acc + c.capacity, 0)
      return {
        name,
        cameras: cams,
        onlineCount: onlineCams.length,
        totalPeople,
        totalCapacity,
        occupancyPct:
          totalCapacity > 0
            ? Math.min(100, Math.round((totalPeople / totalCapacity) * 100))
            : 0,
        bestCamera: sortedOnline[0] ?? null,
      }
    })
  }, [allCameraNodes])

  const currentPlaceFolder = useMemo(
    () => placeFolders.find((f) => f.name === activePlaceName) ?? null,
    [placeFolders, activePlaceName],
  )

  const inspectedCamera = useMemo(
    () => allCameraNodes.find((c) => c.id === inspectedCameraId) ?? null,
    [allCameraNodes, inspectedCameraId],
  )

  const onlineCameraNodes = useMemo(
    () =>
      allCameraNodes
        .filter((c) => c.status === 'Online')
        .sort((a, b) => a.count - b.count),
    [allCameraNodes],
  )

  const globalBestCamera = onlineCameraNodes[0] ?? null
  const totalCrowd =
    summary?.estimated_people ??
    onlineCameraNodes.reduce((s, c) => s + c.count, 0)

  const chartData = useMemo(
    () =>
      [...historyItems].reverse().map((item) => ({
        time: new Date(item.detected_at).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        people: item.people_count,
      })),
    [historyItems],
  )

  async function copyPhoneLink() {
    try {
      await navigator.clipboard.writeText(phoneCameraUrl)
      setCopiedLink(true)
      showToast('Sensor link copied to clipboard')
      window.setTimeout(() => setCopiedLink(false), 2000)
    } catch {
      showToast('Copy failed')
    }
  }

  function exportCsv() {
    if (historyItems.length === 0) return
    const header = 'ID,Sensor_ID,Gate_Name,People_Count,Confidence,Timestamp'
    const rows = historyItems.map(
      (h) =>
        `${h.id},${h.camera_id},"${h.camera_name}",${h.people_count},${
          h.average_confidence ?? ''
        },${h.detected_at}`,
    )
    const uri = encodeURI(
      'data:text/csv;charset=utf-8,' + [header, ...rows].join('\n'),
    )
    const a = document.createElement('a')
    a.href = uri
    a.download = `${selectedAnalyticsCamId}-telemetry.csv`
    a.click()
  }

  function signOut() {
    clearAdminToken()
    setIsAdmin(false)
    setIsAuthenticated(false)
    setUserRole('viewer')
    setUserEmail('')
    setIsDrawingRoi(false)
    setShowSignOutConfirm(false)
    setMobileSidebarOpen(false)
    setDbCameras([])
    setPhoneSessions([])
    setSummary(null)
    setHistoryItems([])
    navigate('/', { replace: true })
    setShowLoginModal(true)
    showToast('Signed out')
  }

  return (
    <div className="queuesense-app flex h-screen w-screen flex-col overflow-hidden bg-gradient-to-br from-[#F0F4FA] via-[#F7F9FC] to-[#EEF2FF] text-slate-900 select-none">
      {isNavigating && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-slate-950/10 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 rounded-full bg-slate-900 px-4 py-2 text-xs font-bold text-white shadow-xl">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white" />
            Opening dashboard view…
          </div>
        </div>
      )}
      {/* TOP COMMAND HEADER */}
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200/80 bg-white/85 px-6 backdrop-blur-xl">
        <div className="flex items-center gap-6">
          <button
            type="button"
            aria-label="Toggle navigation"
            aria-expanded={mobileSidebarOpen}
            onClick={() => setMobileSidebarOpen((open) => !open)}
            className="mobile-menu hidden h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700"
          >
            <Menu size={19} />
          </button>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-600/25">
              <Activity size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-extrabold tracking-tight text-slate-900">
                  Queue<span className="text-blue-600">Sense</span>
                </span>
                <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[10px] font-extrabold text-indigo-700">
                  SPATIAL OS
                </span>
              </div>
              <p className="text-[11px] font-medium text-slate-500">
                Smart Crowd Routing & Place Directory
              </p>
            </div>
          </div>

          {/* INTERACTIVE BREADCRUMB PATH */}
          <div className="hidden items-center gap-1.5 rounded-xl border border-slate-200/80 bg-slate-100/70 px-3 py-1.5 text-xs font-semibold text-slate-600 md:flex">
            <button
              onClick={() => {
                navigateTo('explorer')
                setActivePlaceName(null)
                setInspectedCameraId(null)
              }}
              className="hover:text-blue-600"
            >
              All Places
            </button>
            {activePlaceName && (
              <>
                <ChevronRight size={13} className="text-slate-400" />
                <button
                  onClick={() => setInspectedCameraId(null)}
                  className="font-bold text-slate-900 hover:text-blue-600"
                >
                  {activePlaceName}
                </button>
              </>
            )}
            {inspectedCamera && (
              <>
                <ChevronRight size={13} className="text-slate-400" />
                <span className="rounded-md bg-blue-600 px-2 py-0.5 font-mono text-[11px] font-bold text-white">
                  {inspectedCamera.name}
                </span>
              </>
            )}
          </div>
        </div>

        {/* RIGHT CONTROLS */}
        <div className="flex items-center gap-2.5">
          {canOperate ? (
            <>
              <button
                onClick={() => setShowPairModal(true)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-2 text-xs font-bold text-blue-700 hover:bg-blue-100"
              >
                <Smartphone size={14} />
                Pair Sensor Node
              </button>

              <button
                onClick={() => setShowSignOutConfirm(true)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-xs font-bold text-emerald-800 hover:bg-emerald-100"
              >
                <LogOut size={14} className="text-emerald-600" />
                Sign out
              </button>
            </>
          ) : isAuthenticated ? (
            <button
              onClick={() => setShowSignOutConfirm(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
            >
              <LogOut size={14} /> Signed in (Logout)
            </button>
          ) : (
            <button
              onClick={() => {
                setLoginError('')
                setShowLoginModal(true)
              }}
              className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3.5 py-2 text-xs font-bold text-white shadow-2xs hover:bg-slate-800"
            >
              <UserCheck size={14} />
              Sign in
            </button>
          )}

          {isAuthenticated && (
            <div className="google-account flex min-w-0 items-center gap-2 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#4285f4] via-[#ea4335] to-[#34a853] text-[11px] font-extrabold text-white">G</span>
              <span className="min-w-0 leading-tight">
                <span className="block max-w-32 truncate text-[11px] font-bold text-slate-700">{userEmail}</span>
                <span className="block text-[10px] font-extrabold uppercase tracking-wide text-blue-600">{userRole}</span>
              </span>
            </div>
          )}

          <div
            className={`hidden items-center gap-2 rounded-xl border px-3 py-2 font-mono text-[11px] font-bold sm:inline-flex ${
              connected
                ? 'border-emerald-200 bg-emerald-50/70 text-emerald-800'
                : 'border-rose-200 bg-rose-50 text-rose-800'
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                connected ? 'animate-pulse bg-emerald-500' : 'bg-rose-500'
              }`}
            />
            {connected
              ? lastSync?.toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })
              : 'OFFLINE'}
          </div>
        </div>
      </header>

      {/* MAIN ZERO-SCROLL WORKSPACE */}
      <div className="flex flex-1 overflow-hidden">
        {/* LEFT SPATIAL SIDEBAR */}
        <aside className={`mobile-sidebar flex w-64 shrink-0 flex-col justify-between border-r border-slate-200/80 bg-white/80 p-4 backdrop-blur-md ${mobileSidebarOpen ? 'mobile-sidebar-open' : ''}`}>
          <div className="space-y-5">
            <div className="space-y-1">
              <p className="px-2.5 pb-1 text-[10px] font-extrabold tracking-wider text-slate-400 uppercase">
                Navigation
              </p>
              {(
                [
                  {
                    id: 'explorer',
                    label: 'Places Directory',
                    icon: LayoutGrid,
                  },
                  {
                    id: 'wayfinding',
                    label: 'Public Queue Board',
                    icon: Monitor,
                  },
                  {
                    id: 'analytics',
                    label: 'Historical Trends',
                    icon: BarChart3,
                  },
                  ...(isAdmin
                    ? [
                        {
                          id: 'settings' as const,
                          label: 'Admin & Security',
                          icon: Settings,
                        },
                      ]
                    : []),
                ] as const
              ).map((item) => {
                const Icon = item.icon
                const active = section === item.id
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      navigateTo(item.id)
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-xs font-bold transition ${
                      active
                        ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-sm shadow-blue-600/20'
                        : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900'
                    }`}
                  >
                    <Icon size={15} />
                    {item.label}
                  </button>
                )
              })}
            </div>

            {/* PLACE FOLDERS TREE */}
            <div className="space-y-1">
              <div className="flex items-center justify-between px-2.5 pb-1">
                <span className="text-[10px] font-extrabold tracking-wider text-slate-400 uppercase">
                  Place Folders ({placeFolders.length})
                </span>
                <button
                  onClick={() => {
                    navigate('/')
                    setSection('explorer')
                    setActivePlaceName(null)
                    setInspectedCameraId(null)
                  }}
                  className="text-[10px] font-bold text-blue-600 hover:underline"
                >
                  View All
                </button>
              </div>

              <div className="max-h-60 space-y-1 overflow-y-auto pr-1">
                {placeFolders.map((folder) => {
                  const isOpen =
                    section === 'explorer' && activePlaceName === folder.name
                  const FolderIcon = isOpen ? FolderOpen : Folder
                  return (
                    <button
                      key={folder.name}
                      onClick={() => {
                        navigate(`/?place=${encodeURIComponent(folder.name)}`)
                        setSection('explorer')
                        setActivePlaceName(folder.name)
                        setInspectedCameraId(null)
                      }}
                      className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs font-bold transition ${
                        isOpen
                          ? 'border border-blue-200 bg-blue-50/90 text-blue-700'
                          : 'text-slate-600 hover:bg-slate-100/70 hover:text-slate-900'
                      }`}
                    >
                      <span className="flex items-center gap-2 truncate">
                        <FolderIcon
                          size={15}
                          className={
                            isOpen ? 'text-blue-600' : 'text-amber-500'
                          }
                        />
                        <span className="truncate">{folder.name}</span>
                      </span>
                      <span className="rounded-md bg-white px-1.5 py-0.5 font-mono text-[10px] font-extrabold text-slate-700 shadow-2xs tabular-nums">
                        {folder.totalPeople}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* LIVE VENUE RADAR WIDGET */}
          <div className="rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50/80 via-white to-indigo-50/60 p-4 shadow-2xs">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-extrabold text-blue-700 uppercase">
                Live Venue Count
              </span>
              <Radio size={14} className="text-blue-600" />
            </div>
            <p className="mt-1.5 text-3xl font-extrabold tracking-tight text-slate-900 tabular-nums">
              {totalCrowd}{' '}
              <span className="text-xs font-semibold text-slate-500">
                people
              </span>
            </p>
            <p className="mt-1 text-[11px] font-bold text-slate-500">
              {summary?.online_cameras ?? onlineCameraNodes.length} active cameras · {summary?.offline_cameras ?? Math.max(0, allCameraNodes.length - onlineCameraNodes.length)} offline
            </p>
            {globalBestCamera ? (
              <div className="mt-2.5 rounded-xl border border-emerald-200 bg-emerald-50/80 px-2.5 py-1.5 text-[11px] font-bold text-emerald-800">
                Fastest: {globalBestCamera.name} ({globalBestCamera.count})
              </div>
            ) : (
              <p className="mt-2 text-[11px] text-slate-400">
                No active gates online
              </p>
            )}
          </div>
        </aside>

        {/* CENTER FIXED STAGE */}
        <main className="flex flex-1 flex-col overflow-hidden p-6">
          {/* =========================================================
              VIEW 1: PLACES EXPLORER
             ========================================================= */}
          {section === 'explorer' && (
            <div className="flex h-full flex-col overflow-hidden">
              {/* LEVEL 1: PLACE FOLDERS GRID */}
              {!activePlaceName && !inspectedCamera && (
                <>
                  <div className="mb-5 flex shrink-0 flex-wrap items-center justify-between gap-4">
                    <div>
                      <h1 className="text-xl font-extrabold tracking-tight text-slate-900">
                        Monitored Places Directory
                      </h1>
                      <p className="text-xs font-medium text-slate-500">
                        Select any Place folder to view live gate queue counts,
                        2D floorplans, and estimated wait times.
                      </p>
                    </div>

                    {isAdmin && (
                      <button
                        onClick={() => navigateTo('settings')}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-bold text-slate-700 shadow-2xs hover:bg-slate-50"
                      >
                        <Plus size={14} />
                        Add Place / Gate
                      </button>
                    )}
                  </div>

                  {placeFolders.length === 0 ? (
                    <div className="flex flex-1 flex-col items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-white/70 p-10 text-center">
                      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
                        <Folder size={28} />
                      </div>
                      <h2 className="mt-3 text-base font-extrabold text-slate-900">
                        No Place Folders Active Yet
                      </h2>
                      <p className="mt-1 max-w-md text-xs text-slate-500">
                        Activate a sensor node to populate the directory.
                      </p>
                    </div>
                  ) : (
                    <div className="grid flex-1 auto-rows-max grid-cols-1 gap-5 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
                      {placeFolders.map((folder) => (
                        <button
                          key={folder.name}
                          onClick={() => setActivePlaceName(folder.name)}
                          className="group relative flex flex-col justify-between overflow-hidden rounded-3xl border border-slate-200/90 bg-white p-5 text-left shadow-xs transition-all hover:-translate-y-0.5 hover:border-blue-400 hover:shadow-md"
                        >
                          <div>
                            <div className="flex items-start justify-between">
                              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-100 to-amber-50 text-amber-600 ring-1 ring-amber-200/60 transition group-hover:from-blue-600 group-hover:to-indigo-600 group-hover:text-white">
                                <Folder size={22} />
                              </div>
                              <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono text-[11px] font-bold text-slate-700">
                                {folder.cameras.length}{' '}
                                {folder.cameras.length === 1 ? 'Gate' : 'Gates'}
                              </span>
                            </div>

                            <h2 className="mt-4 text-lg font-extrabold text-slate-900 group-hover:text-blue-600">
                              {folder.name}
                            </h2>
                            <p className="mt-0.5 text-xs font-medium text-slate-500">
                              {folder.onlineCount} active ·{' '}
                              {folder.occupancyPct}% capacity load
                            </p>
                          </div>

                          <div className="mt-5 space-y-2.5 border-t border-slate-100 pt-3.5">
                            <div className="flex items-baseline justify-between">
                              <span className="text-xs font-bold text-slate-400 uppercase">
                                Total Crowd
                              </span>
                              <span className="text-2xl font-extrabold text-slate-900 tabular-nums">
                                {folder.totalPeople}{' '}
                                <span className="text-xs font-semibold text-slate-500">
                                  people
                                </span>
                              </span>
                            </div>

                            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                              <div
                                className={`h-full rounded-full transition-all duration-500 ${
                                  folder.occupancyPct >= 75
                                    ? 'bg-rose-500'
                                    : folder.occupancyPct >= 40
                                      ? 'bg-amber-500'
                                      : 'bg-emerald-500'
                                }`}
                                style={{
                                  width: `${Math.max(5, folder.occupancyPct)}%`,
                                }}
                              />
                            </div>

                            {folder.bestCamera && (
                              <div className="flex items-center justify-between rounded-xl bg-emerald-50 px-3 py-1.5 text-[11px] font-bold text-emerald-800">
                                <span>Best Gate: {folder.bestCamera.name}</span>
                                <span className="tabular-nums">
                                  {folder.bestCamera.count} waiting
                                </span>
                              </div>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* LEVEL 2: INSIDE A PLACE FOLDER (GRID VIEW OR 2D FLOORPLAN VIEW) */}
              {activePlaceName && currentPlaceFolder && !inspectedCamera && (
                <>
                  <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200/80 bg-white px-4 py-3 shadow-2xs">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => setActivePlaceName(null)}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100"
                      >
                        <ArrowLeft size={14} />
                        All Places
                      </button>
                      <div>
                        <div className="flex items-center gap-2">
                          <FolderOpen size={16} className="text-blue-600" />
                          <h1 className="text-base font-extrabold text-slate-900">
                            {currentPlaceFolder.name}
                          </h1>
                          <span className="rounded-full bg-blue-50 px-2.5 py-0.5 font-mono text-xs font-extrabold text-blue-700 tabular-nums">
                            {currentPlaceFolder.totalPeople} people
                          </span>
                        </div>
                        {currentPlaceFolder.bestCamera && (
                          <p className="text-xs font-medium text-emerald-700">
                            Recommended Gate:{' '}
                            <strong>
                              {currentPlaceFolder.bestCamera.name}
                            </strong>{' '}
                            ({currentPlaceFolder.bestCamera.count} people · ~
                            {currentPlaceFolder.bestCamera.waitMinutes} min
                            wait)
                          </p>
                        )}
                      </div>
                    </div>

                    {/* SWITCH BETWEEN CARD GRID AND 2D ARCHITECTURAL FLOORPLAN */}
                    <div className="flex items-center gap-2">
                      <div className="inline-flex rounded-xl border border-slate-200 bg-slate-100 p-1">
                        <button
                          onClick={() => setPlaceViewMode('grid')}
                          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-bold transition ${
                            placeViewMode === 'grid'
                              ? 'bg-white text-slate-900 shadow-2xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          <LayoutGrid size={13} />
                          Card Grid
                        </button>
                        <button
                          onClick={() => setPlaceViewMode('floorplan')}
                          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-bold transition ${
                            placeViewMode === 'floorplan'
                              ? 'bg-white text-blue-600 shadow-2xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          <MapIcon size={13} />
                          2D Floorplan
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* SUB-VIEW A: 2D ARCHITECTURAL FLOORPLAN SCHEMATIC */}
                  {placeViewMode === 'floorplan' ? (
                    <div className="relative flex flex-1 flex-col justify-between overflow-hidden rounded-3xl border border-slate-200 bg-white p-6 shadow-xs">
                      {/* Architectural Blueprint Grid Background */}
                      <div
                        className="pointer-events-none absolute inset-0 opacity-45"
                        style={{
                          backgroundImage:
                            'radial-gradient(#94a3b8 1px, transparent 1px), linear-gradient(to right, #f1f5f9 1px, transparent 1px), linear-gradient(to bottom, #f1f5f9 1px, transparent 1px)',
                          backgroundSize: '24px 24px, 48px 48px, 48px 48px',
                        }}
                      />

                      <div className="relative z-10 flex items-center justify-between">
                        <div>
                          <span className="rounded-full bg-blue-50 px-3 py-1 font-mono text-[10px] font-extrabold text-blue-700 uppercase">
                            LIVE SPATIAL SCHEMATIC · {currentPlaceFolder.name}
                          </span>
                          <h2 className="mt-1 text-lg font-extrabold text-slate-900">
                            Interactive Gate Topology & Flow Paths
                          </h2>
                        </div>

                        <div className="flex items-center gap-3 text-xs font-bold">
                          <span className="flex items-center gap-1.5 text-emerald-700">
                            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                            Fast (&lt;40%)
                          </span>
                          <span className="flex items-center gap-1.5 text-amber-700">
                            <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
                            Moderate (40–74%)
                          </span>
                          <span className="flex items-center gap-1.5 text-rose-700">
                            <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
                            Crowded (75%+)
                          </span>
                        </div>
                      </div>

                      {/* CENTRAL ARCHITECTURAL CONCOURSE DIAGRAM */}
                      <div className="relative z-10 my-4 flex flex-1 flex-col justify-between rounded-3xl border-2 border-dashed border-slate-300 bg-slate-50/70 p-6">
                        <div className="mx-auto rounded-xl border border-slate-200 bg-white px-6 py-2 text-center shadow-2xs">
                          <span className="font-mono text-[10px] font-extrabold tracking-widest text-slate-400 uppercase">
                            VISITOR ARRIVAL PLAZA
                          </span>
                        </div>

                        {/* GATE PINS PLOTTED ACROSS THE FLOORPLAN */}
                        <div className="my-auto grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                          {currentPlaceFolder.cameras.map((cam) => {
                            const isBest =
                              currentPlaceFolder.bestCamera?.id === cam.id &&
                              cam.status === 'Online'
                            const colorRing =
                              cam.occupancyPct >= 75
                                ? 'border-rose-400 bg-rose-50/90 text-rose-900'
                                : cam.occupancyPct >= 40
                                  ? 'border-amber-400 bg-amber-50/90 text-amber-900'
                                  : 'border-emerald-400 bg-emerald-50/90 text-emerald-900'

                            return (
                              <button
                                key={cam.id}
                                onClick={() => {
                                  setInspectedCameraId(cam.id)
                                  setSelectedAnalyticsCamId(cam.id)
                                }}
                                className={`group relative flex flex-col justify-between rounded-2xl border-2 p-4 text-left shadow-sm transition hover:-translate-y-1 hover:shadow-md ${colorRing}`}
                              >
                                <div className="flex items-center justify-between">
                                  <span className="rounded-md bg-white/90 px-2 py-0.5 font-mono text-[11px] font-extrabold text-slate-800">
                                    {cam.id}
                                  </span>
                                  {isBest && (
                                    <span className="rounded-full bg-emerald-600 px-2.5 py-0.5 text-[10px] font-extrabold text-white">
                                      RECOMMENDED ROUTE
                                    </span>
                                  )}
                                </div>

                                <div className="my-3 flex items-baseline justify-between">
                                  <div>
                                    <h3 className="text-base font-extrabold">
                                      {cam.name}
                                    </h3>
                                    <p className="text-xs opacity-75">
                                      ~{cam.waitMinutes} min wait
                                    </p>
                                  </div>
                                  <div className="text-right">
                                    <span className="text-3xl font-extrabold tabular-nums">
                                      {cam.count}
                                    </span>
                                    <span className="block text-[10px] font-bold uppercase opacity-75">
                                      People
                                    </span>
                                  </div>
                                </div>

                                <div className="flex items-center justify-between border-t border-black/10 pt-2 text-[11px] font-bold">
                                  <span>Load: {cam.occupancyPct}%</span>
                                  <span className="underline">
                                    Inspect Node →
                                  </span>
                                </div>
                              </button>
                            )
                          })}
                        </div>

                        <div className="mx-auto rounded-xl border border-slate-200 bg-white px-6 py-2 text-center shadow-2xs">
                          <span className="font-mono text-[10px] font-extrabold tracking-widest text-slate-400 uppercase">
                            INTERIOR CONCOURSE / SECURE ZONE
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    /* SUB-VIEW B: STANDARD CAMERA CARDS GRID */
                    <div className="grid flex-1 auto-rows-max grid-cols-1 gap-5 overflow-y-auto pr-1 md:grid-cols-2 xl:grid-cols-3">
                      {currentPlaceFolder.cameras.map((cam) => {
                        const showVideo = canOperate && !hiddenVideoIds.has(cam.id)
                        const isRecordingThis = recordingCamId === cam.id
                        const isBestInPlace =
                          currentPlaceFolder.bestCamera?.id === cam.id &&
                          cam.status === 'Online'

                        return (
                          <article
                            key={cam.id}
                            className={`flex flex-col justify-between overflow-hidden rounded-3xl border bg-white shadow-xs transition ${
                              isBestInPlace
                                ? 'border-emerald-400 ring-2 ring-emerald-100'
                                : 'border-slate-200/90'
                            }`}
                          >
                            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`h-2.5 w-2.5 rounded-full ${
                                    cam.status === 'Online'
                                      ? 'animate-pulse bg-emerald-500'
                                      : 'bg-slate-300'
                                  }`}
                                />
                                <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-bold text-slate-800">
                                  {cam.id}
                                </span>
                                {cam.roi && (
                                  <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-extrabold text-blue-700">
                                    ROI ZONE
                                  </span>
                                )}
                                {isBestInPlace && (
                                  <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-extrabold text-white">
                                    FASTEST
                                  </span>
                                )}
                              </div>

                              {isAdmin ? (
                                <button
                                  onClick={() =>
                                    toggleCameraVideoVisibility(cam.id)
                                  }
                                  className={`inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-xs font-bold transition ${
                                    showVideo
                                      ? 'border-blue-600 bg-blue-600 text-white'
                                      : 'border-slate-200 bg-slate-50 text-slate-700'
                                  }`}
                                >
                                  {showVideo ? (
                                    <>
                                      <Eye size={12} />
                                      Video On
                                    </>
                                  ) : (
                                    <>
                                      <EyeOff size={12} />
                                      Numbers Only
                                    </>
                                  )}
                                </button>
                              ) : (
                                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-600">
                                  {cam.congestionLabel} Load
                                </span>
                              )}
                            </div>

                            {showVideo ? (
                              <div className="relative h-48 w-full bg-slate-950">
                                {cam.previewUrl ? (
                                  <img
                                    src={cam.previewUrl}
                                    alt={cam.name}
                                    className="h-full w-full object-contain"
                                  />
                                ) : (
                                  <div className="flex h-full items-center justify-center text-xs font-semibold text-slate-400">
                                    {cam.status === 'Online'
                                      ? 'Receiving live video footage...'
                                      : 'Sensor offline'}
                                  </div>
                                )}

                                {isRecordingThis && (
                                  <div className="absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-rose-600 px-2.5 py-1 font-mono text-[10px] font-extrabold text-white shadow-md">
                                    <span className="h-2 w-2 animate-ping rounded-full bg-white" />
                                    REC 00:
                                    {String(recordingSeconds).padStart(2, '0')}
                                  </div>
                                )}

                                <button
                                  onClick={() => {
                                    setInspectedCameraId(cam.id)
                                    setSelectedAnalyticsCamId(cam.id)
                                  }}
                                  title="Expand View & ROI Tool"
                                  className="absolute top-3 right-3 rounded-xl bg-white/90 p-1.5 text-slate-900 shadow-sm hover:bg-white"
                                >
                                  <Maximize2 size={13} />
                                </button>

                                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-slate-950/90 via-slate-950/50 to-transparent px-3.5 py-2 font-mono text-[11px] font-bold text-white tabular-nums">
                                  <span>People: {cam.count}</span>
                                  <span>
                                    Conf:{' '}
                                    {cam.confidencePct != null
                                      ? `${cam.confidencePct}%`
                                      : '--'}
                                  </span>
                                  <span>Cycles: {cam.runs}</span>
                                </div>
                              </div>
                            ) : (
                              <div className="flex h-48 flex-col justify-between bg-gradient-to-b from-slate-50/70 to-white p-4">
                                <div className="flex items-center justify-between text-[11px] font-bold text-slate-400">
                                  <span>Live Gate Occupancy</span>
                                  <span className="font-mono tabular-nums">
                                    Syncs: {cam.runs}
                                  </span>
                                </div>

                                <div className="my-auto flex items-center justify-between">
                                  <div>
                                    <p className="text-[10px] font-extrabold tracking-wider text-slate-400 uppercase">
                                      People in Queue
                                    </p>
                                    <div className="flex items-baseline gap-2">
                                      <span className="text-5xl font-extrabold tracking-tight text-slate-900 tabular-nums">
                                        {cam.status === 'Online'
                                          ? cam.count
                                          : '--'}
                                      </span>
                                      <span className="text-xs font-bold text-slate-500">
                                        people
                                      </span>
                                    </div>
                                  </div>

                                  <div className="rounded-2xl border border-blue-100 bg-blue-50/70 px-3.5 py-2.5 text-right">
                                    <span className="text-[10px] font-extrabold text-blue-600 uppercase">
                                      Est. Wait
                                    </span>
                                    <p className="mt-0.5 flex items-center justify-end gap-1 font-mono text-lg font-extrabold text-slate-900 tabular-nums">
                                      <Clock
                                        size={14}
                                        className="text-blue-600"
                                      />
                                      ~{cam.waitMinutes}m
                                    </p>
                                  </div>
                                </div>

                                <div>
                                  <div className="mb-1 flex justify-between text-[11px] font-bold text-slate-500">
                                    <span>
                                      Capacity ({cam.count}/{cam.capacity})
                                    </span>
                                    <span className="font-mono tabular-nums">
                                      {cam.occupancyPct}%
                                    </span>
                                  </div>
                                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                                    <div
                                      className={`h-full rounded-full transition-all duration-300 ${
                                        cam.occupancyPct >= 75
                                          ? 'bg-rose-500'
                                          : cam.occupancyPct >= 40
                                            ? 'bg-amber-500'
                                            : 'bg-emerald-500'
                                      }`}
                                      style={{
                                        width: `${Math.max(
                                          4,
                                          cam.occupancyPct,
                                        )}%`,
                                      }}
                                    />
                                  </div>
                                </div>
                              </div>
                            )}

                            <div className="space-y-2.5 border-t border-slate-100 p-3.5">
                              {showVideo && (
                                <div className="grid grid-cols-2 gap-2">
                                  <button
                                    onClick={() =>
                                      downloadInstantSnap(
                                        cam.id,
                                        cam.previewUrl,
                                      )
                                    }
                                    disabled={!cam.previewUrl}
                                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 py-1.5 text-xs font-bold text-slate-700 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-40"
                                  >
                                    <Camera size={13} />
                                    Save Snap
                                  </button>
                                  <button
                                    onClick={() =>
                                      toggleClipRecord(cam.id, cam.previewUrl)
                                    }
                                    disabled={!cam.previewUrl}
                                    className={`inline-flex items-center justify-center gap-1.5 rounded-xl py-1.5 text-xs font-bold transition disabled:opacity-40 ${
                                      isRecordingThis
                                        ? 'animate-pulse bg-rose-600 text-white'
                                        : 'border border-slate-200 bg-slate-50 text-slate-700 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700'
                                    }`}
                                  >
                                    {isRecordingThis ? (
                                      <>
                                        <CircleDot size={13} />
                                        Stop ({recordingSeconds}s)
                                      </>
                                    ) : (
                                      <>
                                        <Film size={13} />
                                        Record Clip
                                      </>
                                    )}
                                  </button>
                                </div>
                              )}

                              <div className="flex items-center justify-between">
                                <div>
                                  <h3 className="text-sm font-extrabold text-slate-900">
                                    {cam.name}
                                  </h3>
                                  <p className="text-[11px] font-medium text-slate-500">
                                    {cam.status}
                                  </p>
                                </div>
                                <button
                                  onClick={() => {
                                    setInspectedCameraId(cam.id)
                                    setSelectedAnalyticsCamId(cam.id)
                                  }}
                                  className="rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-600"
                                >
                                  View Details
                                </button>
                              </div>
                            </div>
                          </article>
                        )
                      })}
                    </div>
                  )}
                </>
              )}

              {/* LEVEL 3: SINGLE GATE DETAIL VIEW + INTERACTIVE ROI DRAWING */}
              {inspectedCamera && (
                <div className="flex h-full flex-col overflow-hidden">
                  <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200/80 bg-white px-4 py-3 shadow-2xs">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => {
                          setInspectedCameraId(null)
                          setIsDrawingRoi(false)
                        }}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100"
                      >
                        <ArrowLeft size={14} />
                        Back to {inspectedCamera.place}
                      </button>
                      <div>
                        <h2 className="text-base font-extrabold text-slate-900">
                          {inspectedCamera.name}{' '}
                          <span className="ml-1 font-mono text-xs font-bold text-blue-600">
                            ({inspectedCamera.id})
                          </span>
                        </h2>
                        <p className="text-xs text-slate-500">
                          Place Folder: {inspectedCamera.place}
                        </p>
                      </div>
                    </div>

                    {/* ADMIN-ONLY VIDEO, ROI ZONE & CAPTURE CONTROLS */}
                    {isAdmin && (
                      <div className="flex flex-wrap items-center gap-2">
                        {!hiddenVideoIds.has(inspectedCamera.id) && (
                          <>
                            <button
                              onClick={() => {
                                setIsDrawingRoi((v) => !v)
                                setDraftRoi(null)
                              }}
                              className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-bold transition ${
                                isDrawingRoi
                                  ? 'border-indigo-600 bg-indigo-600 text-white'
                                  : 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                              }`}
                            >
                              <Crop size={14} />
                              {isDrawingRoi
                                ? 'Drag on Video to Set Zone...'
                                : 'Draw Queue Zone (ROI)'}
                            </button>

                            {inspectedCamera.roi && (
                              <button
                                onClick={() =>
                                  void saveRoiToBackend(
                                    inspectedCamera.id,
                                    null,
                                  )
                                }
                                className="rounded-xl border border-slate-200 bg-slate-100 px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-200"
                              >
                                Clear ROI
                              </button>
                            )}

                            <button
                              onClick={() =>
                                downloadInstantSnap(
                                  inspectedCamera.id,
                                  inspectedCamera.previewUrl,
                                )
                              }
                              disabled={!inspectedCamera.previewUrl}
                              className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-2xs hover:bg-blue-700 disabled:opacity-40"
                            >
                              <Camera size={14} />
                              Save Snap (.jpg)
                            </button>

                            <button
                              onClick={() =>
                                toggleClipRecord(
                                  inspectedCamera.id,
                                  inspectedCamera.previewUrl,
                                )
                              }
                              disabled={!inspectedCamera.previewUrl}
                              className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-bold transition disabled:opacity-40 ${
                                recordingCamId === inspectedCamera.id
                                  ? 'animate-pulse bg-rose-600 text-white'
                                  : 'border border-slate-200 bg-slate-100 text-slate-800 hover:bg-slate-200'
                              }`}
                            >
                              <Film size={14} />
                              {recordingCamId === inspectedCamera.id
                                ? `Stop & Save (${recordingSeconds}s)`
                                : 'Record Clip (.webm)'}
                            </button>
                          </>
                        )}

                        <button
                          onClick={() =>
                            toggleCameraVideoVisibility(inspectedCamera.id)
                          }
                          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-900 px-3.5 py-1.5 text-xs font-bold text-white"
                        >
                          {!hiddenVideoIds.has(inspectedCamera.id) ? (
                            <>
                              <EyeOff size={14} /> Hide Video
                            </>
                          ) : (
                            <>
                              <Eye size={14} /> Show Video
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="grid flex-1 grid-cols-1 gap-5 overflow-hidden lg:grid-cols-[1.35fr_1fr]">
                    {/* LEFT: VIDEO FOOTAGE WITH INTERACTIVE ROI OVERLAY OR PURE TELEMETRY */}
                    <div className="flex flex-col justify-between overflow-hidden rounded-3xl border border-slate-200 bg-white p-4 shadow-xs">
                      {isAdmin && !hiddenVideoIds.has(inspectedCamera.id) ? (
                        <div
                          ref={videoStageRef}
                          onMouseDown={(e) => {
                            if (!isDrawingRoi || !videoStageRef.current) return
                            const rect =
                              videoStageRef.current.getBoundingClientRect()
                            const x = Math.max(
                              0,
                              Math.min(1, (e.clientX - rect.left) / rect.width),
                            )
                            const y = Math.max(
                              0,
                              Math.min(1, (e.clientY - rect.top) / rect.height),
                            )
                            setDragStart({ x, y })
                            setDraftRoi({ x1: x, y1: y, x2: x, y2: y })
                          }}
                          onMouseMove={(e) => {
                            if (
                              !isDrawingRoi ||
                              !dragStart ||
                              !videoStageRef.current
                            )
                              return
                            const rect =
                              videoStageRef.current.getBoundingClientRect()
                            const x = Math.max(
                              0,
                              Math.min(1, (e.clientX - rect.left) / rect.width),
                            )
                            const y = Math.max(
                              0,
                              Math.min(1, (e.clientY - rect.top) / rect.height),
                            )
                            setDraftRoi({
                              x1: Math.min(dragStart.x, x),
                              y1: Math.min(dragStart.y, y),
                              x2: Math.max(dragStart.x, x),
                              y2: Math.max(dragStart.y, y),
                            })
                          }}
                          onMouseUp={() => {
                            if (!isDrawingRoi || !draftRoi) return
                            setDragStart(null)
                            setIsDrawingRoi(false)
                            if (
                              Math.abs(draftRoi.x2 - draftRoi.x1) > 0.08 &&
                              Math.abs(draftRoi.y2 - draftRoi.y1) > 0.08
                            ) {
                              void saveRoiToBackend(
                                inspectedCamera.id,
                                draftRoi,
                              )
                            }
                            setDraftRoi(null)
                          }}
                          className={`relative flex-1 overflow-hidden rounded-2xl bg-slate-950 ${
                            isDrawingRoi ? 'cursor-crosshair ring-2 ring-indigo-500' : ''
                          }`}
                        >
                          {inspectedCamera.previewUrl ? (
                            <img
                              src={inspectedCamera.previewUrl}
                              alt={inspectedCamera.name}
                              draggable={false}
                              className="h-full w-full object-contain pointer-events-none"
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center text-xs text-slate-400">
                              Receiving live video footage...
                            </div>
                          )}

                          {/* LIVE DRAG BOX PREVIEW WHILE DRAWING ROI */}
                          {draftRoi && (
                            <div
                              className="pointer-events-none absolute border-2 border-indigo-400 bg-indigo-500/20"
                              style={{
                                left: `${draftRoi.x1 * 100}%`,
                                top: `${draftRoi.y1 * 100}%`,
                                width: `${(draftRoi.x2 - draftRoi.x1) * 100}%`,
                                height: `${(draftRoi.y2 - draftRoi.y1) * 100}%`,
                              }}
                            />
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-slate-100 bg-gradient-to-b from-slate-50/80 to-white p-8 text-center">
                          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
                            <Users size={26} />
                          </div>
                          <p className="mt-3 text-6xl font-extrabold text-slate-900 tabular-nums">
                            {inspectedCamera.count}
                          </p>
                          <p className="mt-1 text-xs font-bold text-slate-500">
                            People Currently in Queue · {inspectedCamera.name}
                          </p>
                          <div className="mt-4 w-full max-w-xs">
                            <div className="mb-1 flex justify-between text-xs font-bold text-slate-600">
                              <span>Capacity Load</span>
                              <span>{inspectedCamera.occupancyPct}%</span>
                            </div>
                            <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                              <div
                                className="h-full rounded-full bg-blue-600 transition-all duration-300"
                                style={{
                                  width: `${Math.max(
                                    4,
                                    inspectedCamera.occupancyPct,
                                  )}%`,
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="mt-4 grid grid-cols-4 gap-2.5 text-center">
                        <div className="rounded-2xl border border-slate-200/80 bg-slate-50 p-2.5">
                          <span className="text-[10px] font-extrabold text-slate-400 uppercase">
                            People
                          </span>
                          <p className="text-xl font-extrabold text-slate-900 tabular-nums">
                            {inspectedCamera.count}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-slate-200/80 bg-slate-50 p-2.5">
                          <span className="text-[10px] font-extrabold text-slate-400 uppercase">
                            Est. Wait
                          </span>
                          <p className="text-xl font-extrabold text-blue-600 tabular-nums">
                            ~{inspectedCamera.waitMinutes}m
                          </p>
                        </div>
                        <div className="rounded-2xl border border-slate-200/80 bg-slate-50 p-2.5">
                          <span className="text-[10px] font-extrabold text-slate-400 uppercase">
                            Accuracy
                          </span>
                          <p className="text-xl font-extrabold text-emerald-600 tabular-nums">
                            {inspectedCamera.confidencePct != null
                              ? `${inspectedCamera.confidencePct}%`
                              : '--'}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-slate-200/80 bg-slate-50 p-2.5">
                          <span className="text-[10px] font-extrabold text-slate-400 uppercase">
                            Sync Cycles
                          </span>
                          <p className="text-xl font-extrabold text-slate-900 tabular-nums">
                            {inspectedCamera.runs}
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* RIGHT: SQLITE TREND CHART */}
                    <div className="flex flex-col justify-between overflow-hidden rounded-3xl border border-slate-200 bg-white p-5 shadow-xs">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-sm font-extrabold text-slate-900">
                            Live Queue History
                          </h3>
                          <p className="text-xs text-slate-500">
                            SQLite records for {inspectedCamera.id}
                          </p>
                        </div>
                        <button
                          onClick={exportCsv}
                          className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100"
                        >
                          <Download size={13} />
                          Export CSV
                        </button>
                      </div>

                      <div className="my-4 flex-1">
                        {chartData.length > 0 ? (
                          <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={chartData}>
                              <defs>
                                <linearGradient
                                  id="colorCrowd"
                                  x1="0"
                                  y1="0"
                                  x2="0"
                                  y2="1"
                                >
                                  <stop
                                    offset="5%"
                                    stopColor="#2563eb"
                                    stopOpacity={0.25}
                                  />
                                  <stop
                                    offset="95%"
                                    stopColor="#2563eb"
                                    stopOpacity={0}
                                  />
                                </linearGradient>
                              </defs>
                              <CartesianGrid
                                stroke="#e2e8f0"
                                strokeDasharray="3 3"
                                vertical={false}
                              />
                              <XAxis
                                dataKey="time"
                                tick={{ fill: '#64748b', fontSize: 10 }}
                                axisLine={false}
                                tickLine={false}
                              />
                              <YAxis
                                allowDecimals={false}
                                tick={{ fill: '#64748b', fontSize: 10 }}
                                axisLine={false}
                                tickLine={false}
                              />
                              <Tooltip />
                              <Area
                                type="monotone"
                                dataKey="people"
                                stroke="#2563eb"
                                strokeWidth={2.5}
                                fill="url(#colorCrowd)"
                                isAnimationActive={false}
                              />
                            </AreaChart>
                          </ResponsiveContainer>
                        ) : (
                          <div className="flex h-full items-center justify-center text-xs text-slate-400">
                            No SQLite history recorded yet.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* =========================================================
              VIEW 2: PUBLIC QUEUE BOARD
             ========================================================= */}
          {section === 'wayfinding' && (
            <div className="flex h-full flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white p-6 shadow-xs">
              <div className="flex shrink-0 items-center justify-between border-b border-slate-100 pb-4">
                <div>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-extrabold text-emerald-700">
                    <Sparkles size={13} />
                    PUBLIC WAYFINDING DISPLAY
                  </span>
                  <h1 className="mt-1.5 text-2xl font-extrabold tracking-tight text-slate-900">
                    Live Entry Gate Queue Board
                  </h1>
                </div>
                <div className="text-right">
                  <span className="text-[11px] font-bold text-slate-400 uppercase">
                    Last Sync
                  </span>
                  <p className="font-mono text-base font-extrabold text-slate-800 tabular-nums">
                    {lastSync ? lastSync.toLocaleTimeString() : '--'}
                  </p>
                </div>
              </div>

              {onlineCameraNodes.length === 0 ? (
                <div className="flex flex-1 items-center justify-center text-sm font-semibold text-slate-400">
                  No active gates online.
                </div>
              ) : (
                <div className="mt-5 grid flex-1 auto-rows-max grid-cols-1 gap-4 overflow-y-auto md:grid-cols-2">
                  {onlineCameraNodes.map((gate, idx) => {
                    const fastest = idx === 0
                    return (
                      <div
                        key={gate.id}
                        className={`flex items-center justify-between rounded-3xl border p-6 transition ${
                          fastest
                            ? 'border-emerald-400 bg-gradient-to-r from-emerald-50/80 to-white ring-2 ring-emerald-100'
                            : 'border-slate-200 bg-slate-50/50'
                        }`}
                      >
                        <div>
                          <div className="flex items-center gap-2.5">
                            <span
                              className={`flex h-9 w-9 items-center justify-center rounded-xl font-mono text-sm font-extrabold ${
                                fastest
                                  ? 'bg-emerald-600 text-white'
                                  : 'bg-slate-200 text-slate-700'
                              }`}
                            >
                              #{idx + 1}
                            </span>
                            <div>
                              <div className="flex items-center gap-2">
                                <h2 className="text-lg font-extrabold text-slate-900">
                                  {gate.name}
                                </h2>
                                {fastest && (
                                  <span className="rounded-full bg-emerald-600 px-2.5 py-0.5 text-[10px] font-extrabold text-white">
                                    SHORTEST QUEUE
                                  </span>
                                )}
                              </div>
                              <p className="text-xs font-medium text-slate-500">
                                Place: <strong>{gate.place}</strong> · Est.
                                Wait: ~{gate.waitMinutes} min
                              </p>
                            </div>
                          </div>
                        </div>

                        <div className="text-right">
                          <p className="text-4xl font-extrabold text-slate-900 tabular-nums">
                            {gate.count}
                          </p>
                          <p className="text-[10px] font-extrabold text-slate-400 uppercase">
                            People
                          </p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* =========================================================
              VIEW 3: HISTORICAL TRENDS
             ========================================================= */}
          {section === 'analytics' && (
            <div className="flex h-full flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white p-6 shadow-xs">
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
                <div>
                  <h1 className="text-lg font-extrabold text-slate-900">
                    SQLite Historical Crowd Telemetry
                  </h1>
                  <p className="text-xs text-slate-500">
                    Verified time-series records stored in queuesense.db
                  </p>
                </div>

                <div className="flex items-center gap-2.5">
                  <select
                    value={selectedAnalyticsCamId}
                    onChange={(e) => setSelectedAnalyticsCamId(e.target.value)}
                    className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2 text-xs font-bold text-slate-800 outline-none"
                  >
                    {allCameraNodes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.place} / {c.name} ({c.id})
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={exportCsv}
                    disabled={historyItems.length === 0}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 py-2 text-xs font-bold text-white shadow-2xs hover:bg-blue-700 disabled:opacity-40"
                  >
                    <Download size={14} />
                    Export CSV
                  </button>
                </div>
              </div>

              <div className="mt-4 grid flex-1 grid-cols-1 gap-5 overflow-hidden lg:grid-cols-[1.5fr_1fr]">
                <div className="h-full rounded-2xl border border-slate-100 bg-slate-50/50 p-4">
                  {chartData.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chartData}>
                        <CartesianGrid
                          stroke="#e2e8f0"
                          strokeDasharray="3 3"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="time"
                          tick={{ fill: '#64748b', fontSize: 10 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          allowDecimals={false}
                          tick={{ fill: '#64748b', fontSize: 10 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip />
                        <Area
                          type="monotone"
                          dataKey="people"
                          stroke="#2563eb"
                          strokeWidth={2.5}
                          fill="#bfdbfe"
                          isAnimationActive={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-slate-400">
                      No history recorded for {selectedAnalyticsCamId}.
                    </div>
                  )}
                </div>

                <div className="overflow-y-auto rounded-2xl border border-slate-200">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 text-[10px] font-extrabold text-slate-500 uppercase">
                      <tr>
                        <th className="px-3.5 py-2.5">Time</th>
                        <th className="px-3.5 py-2.5">People</th>
                        <th className="px-3.5 py-2.5">Accuracy</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                      {historyItems.map((h) => (
                        <tr key={h.id}>
                          <td className="px-3.5 py-2 text-slate-600">
                            {new Date(h.detected_at).toLocaleTimeString()}
                          </td>
                          <td className="px-3.5 py-2 font-extrabold text-slate-900">
                            {h.people_count}
                          </td>
                          <td className="px-3.5 py-2 text-blue-600">
                            {h.average_confidence != null
                              ? `${Math.round(h.average_confidence * 100)}%`
                              : '--'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* =========================================================
              VIEW 4: ADMIN SETTINGS & STRONG PASSWORD CHANGER
             ========================================================= */}
          {section === 'settings' && isAdmin && (
            <div className="grid h-full grid-cols-1 gap-5 overflow-hidden lg:grid-cols-[1.05fr_1.35fr]">
              <div className="space-y-4 overflow-y-auto pr-1">
                <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xs">
                  <div className="flex items-center gap-2">
                    <UserCheck size={16} className="text-blue-600" />
                    <h2 className="text-base font-extrabold text-slate-900">
                      User Access
                    </h2>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">Accounts appear here after their first Google sign-in. New accounts are viewers by default.</p>
                  {userMessage && <p className="mt-2 text-xs font-bold text-slate-600">{userMessage}</p>}
                  <div className="relative mt-3">
                    <input
                      value={userSearch}
                      onChange={(e) => setUserSearch(e.target.value)}
                      placeholder="Search signed-in Gmail accounts"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs outline-none focus:border-blue-600 focus:bg-white"
                    />
                  </div>
                  <div className="mt-3 max-h-32 divide-y divide-slate-100 overflow-y-auto text-xs">
                    {visibleUsers.map((user) => <div key={user.id} className="flex items-center justify-between gap-2 py-2"><span className="truncate text-slate-700">{user.email}</span><select value={user.role} onChange={(e) => void handleUserRoleChange(user.id, e.target.value as UserRole)} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-bold uppercase text-slate-600"><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option></select></div>)}
                    {visibleUsers.length === 0 && <p className="py-3 text-center text-slate-400">No matching signed-in accounts.</p>}
                  </div>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xs">
                  <h2 className="text-base font-extrabold text-slate-900">
                    Add Gate to Place Folder
                  </h2>
                  <form
                    className="mt-3 space-y-2.5"
                    onSubmit={async (e) => {
                      e.preventDefault()
                      if (!newGateName.trim() || !newPlaceName.trim()) return
                      setSubmittingGate(true)
                      try {
                        await createCamera({
                          name: newGateName.trim(),
                          location: newPlaceName.trim(),
                          capacity: Number(newCapacity) || 50,
                        })
                        setNewGateName('')
                        await syncDatabase()
                        showToast('Gate added to Place folder')
                      } catch {
                        showToast('Failed to add gate')
                      } finally {
                        setSubmittingGate(false)
                      }
                    }}
                  >
                    <input
                      required
                      value={newPlaceName}
                      onChange={(e) => setNewPlaceName(e.target.value)}
                      placeholder="Place Folder (e.g. Main Entrance)"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs outline-none focus:border-blue-600"
                    />
                    <input
                      required
                      value={newGateName}
                      onChange={(e) => setNewGateName(e.target.value)}
                      placeholder="Gate Name (e.g. Gate 2)"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs outline-none focus:border-blue-600"
                    />
                    <input
                      required
                      type="number"
                      min={1}
                      value={newCapacity}
                      onChange={(e) => setNewCapacity(e.target.value)}
                      placeholder="Capacity (50)"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs outline-none focus:border-blue-600"
                    />
                    <button
                      type="submit"
                      disabled={submittingGate}
                      className="w-full rounded-xl bg-blue-600 py-2.5 text-xs font-bold text-white hover:bg-blue-700"
                    >
                      {submittingGate ? 'Saving...' : '+ Add Gate'}
                    </button>
                  </form>
                </div>
              </div>

              <div className="flex flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white p-5 shadow-xs">
                <h2 className="text-base font-extrabold text-slate-900">
                  Admin Video Feed Controls ({allCameraNodes.length})
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Choose which nodes display video footage during your Admin
                  session.
                </p>

                <div className="mt-3 flex-1 divide-y divide-slate-100 overflow-y-auto pr-1">
                  {allCameraNodes.map((cam) => {
                    const videoVisible = !hiddenVideoIds.has(cam.id)
                    return (
                      <div
                        key={cam.id}
                        className="flex items-center justify-between py-3"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-extrabold text-slate-900">
                              {cam.name}
                            </span>
                            <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[10px] font-bold text-slate-600">
                              {cam.id}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-500">
                            Place Folder: {cam.place}
                          </p>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() =>
                              toggleCameraVideoVisibility(cam.id)
                            }
                            className={`inline-flex items-center gap-1 rounded-xl border px-3 py-1.5 text-xs font-bold ${
                              videoVisible
                                ? 'border-blue-600 bg-blue-600 text-white'
                                : 'border-slate-200 bg-slate-50 text-slate-700'
                            }`}
                          >
                            {videoVisible ? (
                              <>
                                <CheckCircle2 size={12} /> Video Shown
                              </>
                            ) : (
                              <>
                                <EyeOff size={12} /> Numbers Only
                              </>
                            )}
                          </button>
                          <button
                            onClick={async () => {
                              try {
                                await deleteCamera(cam.id)
                                await syncDatabase()
                                showToast(`Deleted ${cam.name}`)
                              } catch {
                                showToast('Delete failed')
                              }
                            }}
                            className="rounded-xl border border-rose-200 bg-rose-50 p-2 text-rose-700 hover:bg-rose-100"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* GOOGLE SIGN-IN MODAL */}
      {showLoginModal && (
        <div
          role="presentation"
          onClick={() => { if (isAuthenticated) setShowLoginModal(false) }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-xs"
        >
          <section
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-extrabold text-slate-800">
                <UserCheck size={13} />
                QUEUESENSE
              </span>
              {isAuthenticated && <button onClick={() => setShowLoginModal(false)} className="rounded-xl p-1 text-slate-400 hover:bg-slate-100"><X size={16} /></button>}
            </div>

            <h3 className="mt-3 text-lg font-extrabold text-slate-900">
              Sign in to QueueSense
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Continue securely with the Google account you use for QueueSense.
            </p>

            <div className="mt-5 space-y-3">
              <div className="min-h-11">
                <div ref={googleButtonRef} className="flex justify-center" />
                {showGoogleFallback && <button type="button" onClick={openGoogleSignIn} className="flex w-full items-center justify-center gap-3 rounded-xl border border-slate-300 bg-white py-3 text-sm font-bold text-slate-700 shadow-sm transition hover:bg-slate-50 active:scale-[0.99]"><span className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-200 text-xs font-extrabold text-[#4285F4]">G</span>Continue with Google</button>}
              </div>
              {isSigningIn && <div className="flex items-center justify-center gap-2 rounded-xl bg-blue-50 py-3 text-xs font-bold text-blue-700"><span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" /> Signing you in…</div>}
              {loginError && (
                <p className="text-xs font-bold text-rose-600">{loginError}</p>
              )}
            </div>
          </section>
        </div>
      )}

      {showSignOutConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-xs">
          <section role="dialog" aria-modal="true" aria-labelledby="signout-title" className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
            <h3 id="signout-title" className="text-lg font-extrabold text-slate-900">Sign out of QueueSense?</h3>
            <p className="mt-1 text-xs text-slate-500">You will need to sign in with Google again to view protected queue data and use your assigned role.</p>
            <div className="mt-5 flex gap-2">
              <button onClick={() => setShowSignOutConfirm(false)} className="flex-1 rounded-xl border border-slate-200 bg-white py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-50">Cancel</button>
              <button onClick={signOut} className="flex-1 rounded-xl bg-rose-600 py-2.5 text-xs font-bold text-white hover:bg-rose-700">Yes, sign out</button>
            </div>
          </section>
        </div>
      )}

      {/* PAIR SENSOR NODE MODAL */}
      {showPairModal && canOperate && (
        <div
          role="presentation"
          onClick={() => setShowPairModal(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-xs"
        >
          <section
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-xs font-extrabold text-blue-700">
                <Zap size={13} />
                AUTO-SYNCED WIFI NODE
              </span>
              <button
                onClick={() => setShowPairModal(false)}
                className="rounded-xl p-1 text-slate-400 hover:bg-slate-100"
              >
                <X size={16} />
              </button>
            </div>

            <h3 className="mt-2.5 text-lg font-extrabold text-slate-900">
              Pair Mobile Sensor Node
            </h3>

            <div className="mt-3 flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-2">
              <span className="text-xs font-bold text-slate-600">
                Laptop Wi-Fi IP
              </span>
              <input
                value={hostIp}
                onChange={(e) => {
                  setManualIpOverride(true)
                  setHostIp(e.target.value)
                }}
                className="w-32 rounded-lg border border-slate-300 bg-white px-2 py-1 text-right font-mono text-xs font-bold text-slate-900 outline-none"
              />
            </div>

            <div className="my-4 flex justify-center">
              <div className="rounded-2xl border border-slate-200 p-3 shadow-2xs">
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(
                    phoneCameraUrl,
                  )}`}
                  alt="QR Code"
                  width={165}
                  height={165}
                />
              </div>
            </div>

            <p className="break-all rounded-xl border border-blue-200 bg-blue-50/70 p-2.5 text-center font-mono text-[11px] font-bold text-blue-800">
              {phoneCameraUrl}
            </p>

            <div className="mt-3.5 flex gap-2">
              <button
                onClick={() => void copyPhoneLink()}
                className="flex-1 inline-flex items-center justify-center gap-1 rounded-xl border border-slate-200 bg-slate-100 py-2.5 text-xs font-bold text-slate-800 hover:bg-slate-200"
              >
                {copiedLink ? <Check size={14} /> : <Copy size={14} />}
                {copiedLink ? 'Copied' : 'Copy Link'}
              </button>
              <a
                href={phoneCameraUrl}
                target="_blank"
                rel="noreferrer"
                className="flex-1 rounded-xl bg-blue-600 py-2.5 text-center text-xs font-bold text-white hover:bg-blue-700"
              >
                Open Tab
              </a>
            </div>
          </section>
        </div>
      )}

      {toast && (
        <div className="fixed right-5 bottom-5 z-50 rounded-2xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white shadow-xl">
          {toast}
        </div>
      )}
    </div>
  )
}
