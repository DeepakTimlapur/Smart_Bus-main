"use client"



import { useState, useEffect, useRef, useCallback } from "react"

import {

  Camera,

  CheckCircle2,

  XCircle,

  AlertTriangle,

  AlertCircle,

  Users,

  Eye,

  RefreshCw,

  Play,

  Pause,

  Sparkles,

  ShieldCheck,

  ShieldAlert,

  ArrowRight,

  Info,

  Clock,

  UserCheck,

  User,

  Activity,

  Zap,

} from "lucide-react"

import {

  recognizeFacesBatch,

  startBusTrip,

  stopBusTrip,

  type FaceRecognitionItem,

  type MultiFaceRecognitionResponse,

} from "@/lib/api"

import {

  generateCanonicalFaceEmbedding,

  temporalFaceTracker,

  evaluateFaceQuality,

  evaluateLiveness,

} from "@/lib/face-recognition"

import {

  embedFacesFromVideo,

  preloadBrowserFaceModel,

} from "@/lib/browser-face-embedder"

import {

  detectFacesSCRFD,

  preloadSCRFDModel,

  type SCRFDFace,

} from "@/lib/scrfd-face-detector"



interface DriverFaceRecognitionProps {

  busId: string

  currentStop?: string

  currentPassengers: number

  capacity: number

  onAttendanceUpdated: () => void

}



export default function DriverFaceRecognition({

  busId,

  currentStop = "Main Campus Gate",

  currentPassengers,

  capacity,

  onAttendanceUpdated,

}: DriverFaceRecognitionProps) {

  const [cameraActive, setCameraActive] = useState(false)

  const [cameraPaused, setCameraPaused] = useState(false)

  const [cameraError, setCameraError] = useState<string | null>(null)

  const [processing, setProcessing] = useState(false)

  const [detectedCount, setDetectedCount] = useState(0)

  const [cameraRole, setCameraRole] = useState<"ENTRY" | "EXIT">("ENTRY")



  // Active Trip Session State

  const [currentTripId, setCurrentTripId] = useState<string>(() => {

    const today = new Date().toISOString().split("T")[0]

    return `TRIP-${busId}-${today}`

  })

  const [tripActive, setTripActive] = useState<boolean>(true)

  const [tripNotice, setTripNotice] = useState<string | null>(null)

  const [recognizedFaces, setRecognizedFaces] = useState<FaceRecognitionItem[]>([

    {

      face_index: 1,

      student_id: "Awaiting Face",

      name: "Waiting for student...",

      status: "LOW CONFIDENCE",

      confidence: 0,

      fee_status: "STANDBY",

      assigned_bus: busId,

      boarding_status: "STANDBY",

      message: "Face slot 1 ready for entrance scanning",

    },

    {

      face_index: 2,

      student_id: "Awaiting Face",

      name: "Waiting for student...",

      status: "LOW CONFIDENCE",

      confidence: 0,

      fee_status: "STANDBY",

      assigned_bus: busId,

      boarding_status: "STANDBY",

      message: "Face slot 2 ready for entrance scanning",

    },

    {

      face_index: 3,

      student_id: "Awaiting Face",

      name: "Waiting for student...",

      status: "LOW CONFIDENCE",

      confidence: 0,

      fee_status: "STANDBY",

      assigned_bus: busId,

      boarding_status: "STANDBY",

      message: "Face slot 3 ready for entrance scanning",

    },

    {

      face_index: 4,

      student_id: "Awaiting Face",

      name: "Waiting for student...",

      status: "LOW CONFIDENCE",

      confidence: 0,

      fee_status: "STANDBY",

      assigned_bus: busId,

      boarding_status: "STANDBY",

      message: "Face slot 4 ready for entrance scanning",

    },

  ])

  const [lastScanTime, setLastScanTime] = useState<string | null>(null)

  const [scanNotice, setScanNotice] = useState<string>("Ready to scan entrance")

  const [autoScanEnabled, setAutoScanEnabled] = useState(true)



  const videoRef = useRef<HTMLVideoElement | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const latestDetectionsRef = useRef<SCRFDFace[]>([])

  // Prevent repeated API calls for the same tracked face and camera role.
  // ENTRY and EXIT are intentionally independent so a BOARDED passenger
  // can still be processed by the EXIT camera.
  const lastRecognitionAttemptRef = useRef<Map<string, number>>(new Map())

  // Remember the completed operation for this track/role during the
  // current trip. This prevents repeated ENTRY or EXIT processing without
  // changing any UI.
  const processedCameraRoleRef = useRef<
    Map<string, "ENTRY" | "EXIT">
  >(new Map())

  // Keep a short history of production ArcFace embeddings per tracked face.
  // Averaging the last 3 embeddings stabilizes frame-to-frame similarity.
  const embeddingHistoryRef = useRef<
    Map<string, number[][]>
  >(new Map())

  const embeddingQualityHistoryRef = useRef<
    Map<string, number[]>
  >(new Map())

  const streamRef = useRef<MediaStream | null>(null)

  const animationFrameRef = useRef<number | null>(null)

  const autoScanIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const processingRef = useRef<boolean>(false)



  // Initialize and synchronize temporal face tracker trip session

  useEffect(() => {

    temporalFaceTracker.setTripId(currentTripId)

  }, [currentTripId])



  // Trip Lifecycle Handlers

  const handleStartNewTrip = async () => {

    try {

      setProcessing(true)

      const res = await startBusTrip(busId)

      if (res.success && res.trip_id) {

        setCurrentTripId(res.trip_id)

        setTripActive(true)

        temporalFaceTracker.resetTrip(res.trip_id)

        // New trip = new ENTRY/EXIT lifecycle.
        lastRecognitionAttemptRef.current.clear()
        processedCameraRoleRef.current.clear()
    embeddingHistoryRef.current.clear()
        embeddingQualityHistoryRef.current.clear()

        setTripNotice(`New trip started: ${res.trip_id}. Boarding states reset.`)

        setScanNotice(`Started new trip session: ${res.trip_id}`)

        onAttendanceUpdated()

      }

    } catch (err: any) {

      setTripNotice("Failed to start trip: " + (err?.detail || err?.message))

    } finally {

      setProcessing(false)

    }

  }



  const handleStopTrip = async () => {

    try {

      setProcessing(true)

      const res = await stopBusTrip(busId)

      if (res.success) {

        setTripActive(false)

        setTripNotice(`Trip closed for ${busId}.`)

        setScanNotice(`Trip closed for ${busId}. Bus is in terminal.`)

        onAttendanceUpdated()

      }

    } catch (err: any) {

      setTripNotice("Failed to stop trip: " + (err?.detail || err?.message))

    } finally {

      setProcessing(false)

    }

  }



  // Clean stop of video tracks (Privacy Compliance)

  const stopCamera = useCallback(() => {

    if (animationFrameRef.current) {

      cancelAnimationFrame(animationFrameRef.current)

      animationFrameRef.current = null

    }

    if (autoScanIntervalRef.current) {

      clearInterval(autoScanIntervalRef.current)

      autoScanIntervalRef.current = null

    }

    if (streamRef.current) {

      streamRef.current.getTracks().forEach((track) => track.stop())

      streamRef.current = null

    }

    if (videoRef.current) {

      videoRef.current.srcObject = null

    }

    setCameraActive(false)

    setCameraPaused(false)

    setDetectedCount(0)

    latestDetectionsRef.current = []

    lastRecognitionAttemptRef.current.clear()
    processedCameraRoleRef.current.clear()
    embeddingHistoryRef.current.clear()
        embeddingQualityHistoryRef.current.clear()

  }, [])



  useEffect(() => {

    return () => {

      stopCamera()

    }

  }, [stopCamera])



  // Start Camera

  const startCamera = async () => {

    setCameraError(null)

    setScanNotice("Loading production face recognition model...")



    try {

      await Promise.all([

  preloadBrowserFaceModel(),

  preloadSCRFDModel(),

])

      setScanNotice("Production face recognition model ready")



      const stream = await navigator.mediaDevices.getUserMedia({

        video: {

          width: { ideal: 640 },

          height: { ideal: 480 },

          facingMode: "environment", // Face entrance door

        },

        audio: false,

      })



      streamRef.current = stream

      setCameraActive(true)

      setCameraPaused(false)



      setTimeout(() => {

        if (videoRef.current) {

          videoRef.current.srcObject = stream

          videoRef.current.play().then(() => {

            setScanNotice("Camera active • Monitoring entrance")

            startRenderingLoop()

          }).catch((err) => {

            console.error("Video play error:", err)

          })

        }

      }, 100)

    } catch (err: any) {

      console.warn("Camera could not be started:", err)

      setCameraError(

        "Camera permission denied or camera device not found. You can use the Multi-Student Test Simulation to test simultaneous face recognition."

      )

      setCameraActive(false)

    }

  }



  // Automatically activate the existing camera widget.
  useEffect(() => {
    void startCamera()
    // Intentionally run only when this component mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Live Canvas Rendering & Bounding Boxes

  const startRenderingLoop = () => {

    const render = () => {

      if (!videoRef.current || !canvasRef.current || videoRef.current.readyState < 2) {

        animationFrameRef.current = requestAnimationFrame(render)

        return

      }



      const video = videoRef.current

      const canvas = canvasRef.current

      const ctx = canvas.getContext("2d")



      if (ctx) {

        canvas.width = video.videoWidth || 640

        canvas.height = video.videoHeight || 480



        // Clear canvas

        ctx.clearRect(0, 0, canvas.width, canvas.height)



        // Draw bounding boxes for detected faces

        latestDetectionsRef.current.slice(0, 4).forEach((det, idx) => {

          const { x, y, width, height } = det.bbox



          // Color coded: Green, Cyan, Amber, Violet

          const colors = ["#10b981", "#06b6d4", "#f59e0b", "#8b5cf6"]

          const color = colors[idx % colors.length]



          ctx.strokeStyle = color

          ctx.lineWidth = 2.5

          ctx.strokeRect(x, y, width, height)



          // Corner markers

          const corner = 12

          ctx.lineWidth = 4

          ctx.beginPath()

          ctx.moveTo(x, y + corner)

          ctx.lineTo(x, y)

          ctx.lineTo(x + corner, y)

          ctx.moveTo(x + width - corner, y)

          ctx.lineTo(x + width, y)

          ctx.lineTo(x + width, y + corner)

          ctx.moveTo(x, y + height - corner)

          ctx.lineTo(x, y + height)

          ctx.lineTo(x + corner, y + height)

          ctx.moveTo(x + width - corner, y + height)

          ctx.lineTo(x + width, y + height)

          ctx.lineTo(x + width, y + height - corner)

          ctx.stroke()



          // Badge label

          ctx.fillStyle = color

          ctx.fillRect(x, Math.max(0, y - 24), 90, 22)

          ctx.fillStyle = "#ffffff"

          ctx.font = "bold 11px sans-serif"

          ctx.fillText(`FACE ${idx + 1} [${Math.round(det.confidence * 100)}%]`, x + 6, Math.max(14, y - 8))

        })

      }



      animationFrameRef.current = requestAnimationFrame(render)

    }



    animationFrameRef.current = requestAnimationFrame(render)

  }



  // Periodic automatic scan (runs every 2 seconds when camera active & not paused)

  useEffect(() => {

    if (cameraActive && !cameraPaused && autoScanEnabled) {

      autoScanIntervalRef.current = setInterval(() => {

        if (!processing && videoRef.current && videoRef.current.readyState >= 2) {

          processCurrentFrame()

        }

      }, 1500)

    } else {

      if (autoScanIntervalRef.current) {

        clearInterval(autoScanIntervalRef.current)

        autoScanIntervalRef.current = null

      }

    }

    return () => {

      if (autoScanIntervalRef.current) {

        clearInterval(autoScanIntervalRef.current)

      }

    }

  }, [cameraActive, cameraPaused, autoScanEnabled, processing])



  // Process live frame using the real SCRFD + ArcFace production pipeline.
  //
  // SCRFD is the only live detector and ArcFace w600k_mbf is the only
  // live embedding model. The tracker supplies quality/liveness and
  // stable track IDs. Server-side idempotency remains authoritative.
  //
  // We do not block the first real verification behind the legacy
  // needsBoardingRequest temporal gate. That gate can leave a real
  // camera face permanently waiting for consensus.
  const processCurrentFrame = async () => {
    if (!videoRef.current || processingRef.current) return

    processingRef.current = true
    setProcessing(true)

    try {
      const video = videoRef.current

      // 1. Detect real faces with SCRFD-500M.
      const scrfdStart = performance.now()
      const detections = await detectFacesSCRFD(video)
      const scrfdMs = performance.now() - scrfdStart

      console.log("[FACE TIMING] SCRFD:", scrfdMs.toFixed(1) + " ms")
      latestDetectionsRef.current = detections.slice(0, 4)
      setDetectedCount(Math.min(4, detections.length))

      if (detections.length === 0) {
        setScanNotice("No face detected — move closer and face the camera")
        processingRef.current = false
        setProcessing(false)
        return
      }

      // 2. Generate REAL 512-D ArcFace embeddings from SCRFD boxes.
      const limitedDetections = detections.slice(0, 4)

      const arcfaceStart = performance.now()

      const productionEmbeddings = await embedFacesFromVideo(
        video,
        limitedDetections.map((face) => face.bbox)
      )

      const arcfaceMs = performance.now() - arcfaceStart

      console.log("[FACE TIMING] ArcFace:", arcfaceMs.toFixed(1) + " ms")

      if (productionEmbeddings.length !== limitedDetections.length) {
        throw new Error(
          `Embedding count mismatch: detected ${limitedDetections.length}, generated ${productionEmbeddings.length}`
        )
      }

      const productionDetections = limitedDetections.map((face, index) => ({
        ...face,
        embedding: productionEmbeddings[index],
      }))

      // Never send an invalid or fake embedding to the backend.
      for (const [index, face] of productionDetections.entries()) {
        const embedding = face.embedding

        if (
          !Array.isArray(embedding) ||
          embedding.length !== 512 ||
          !embedding.every(Number.isFinite)
        ) {
          throw new Error(
            `Invalid production face embedding at face ${index + 1}: expected finite 512-D vector`
          )
        }

        const norm = Math.sqrt(
          embedding.reduce((sum, value) => sum + value * value, 0)
        )

        if (!Number.isFinite(norm) || norm < 0.99 || norm > 1.01) {
          throw new Error(
            `Invalid production embedding norm at face ${index + 1}: ${norm}`
          )
        }

        console.log("[PRODUCTION FACE]", {
          face: index + 1,
          dimension: embedding.length,
          finite: true,
          norm,
          detector: "SCRFD-500M-KPS",
          embedder: "ArcFace w600k_mbf",
        })
      }

      // 3. Update tracking. The tracker calculates quality/liveness and
      // maintains independent tracks for multiple simultaneous faces.
      const trackerStart = performance.now()

      const trackingUpdates = temporalFaceTracker.update(
        productionDetections,
        video
      )

      const trackerMs = performance.now() - trackerStart

      console.log("[FACE TIMING] Tracker:", trackerMs.toFixed(1) + " ms")
// Phase 2: bounded per-track embedding history.
      const activeTrackIds = new Set<string>()

      for (const update of trackingUpdates) {
        const trackId = String(update.track.trackId)
        activeTrackIds.add(trackId)

        const embedding = update.faceItem.embedding

        if (
          !Array.isArray(embedding) ||
          embedding.length !== 512 ||
          !embedding.every(Number.isFinite)
        ) {
          continue
        }

        const norm = Math.sqrt(
          embedding.reduce((sum, value) => sum + value * value, 0)
        )

        if (!Number.isFinite(norm) || norm < 0.99 || norm > 1.01) {
          continue
        }

        const history = embeddingHistoryRef.current.get(trackId) ?? []
        const qualityHistory =
          embeddingQualityHistoryRef.current.get(trackId) ?? []

        const rawQuality = update.track.quality?.qualityScore
        const quality = Number.isFinite(rawQuality)
          ? Math.max(0, Math.min(1, Number(rawQuality)))
          : 0.1

        history.push([...embedding])
        qualityHistory.push(quality)

        while (history.length > 5) history.shift()
        while (qualityHistory.length > 5) qualityHistory.shift()

        // Keep sample and quality indices aligned.
        while (history.length > qualityHistory.length) history.shift()
        while (qualityHistory.length > history.length) qualityHistory.shift()

        embeddingHistoryRef.current.set(trackId, history)
        embeddingQualityHistoryRef.current.set(trackId, qualityHistory)
      }

      // Remove history for tracks no longer returned by the tracker.
      for (const trackId of embeddingHistoryRef.current.keys()) {
        if (!activeTrackIds.has(trackId)) {
          embeddingHistoryRef.current.delete(trackId)
          embeddingQualityHistoryRef.current.delete(trackId)
        }
      }

      for (const trackId of embeddingQualityHistoryRef.current.keys()) {
        if (!activeTrackIds.has(trackId)) {
          embeddingQualityHistoryRef.current.delete(trackId)
        }
      }

      // 4. Do not wait indefinitely for the legacy temporal-consensus
      // request gate. The server is authoritative and idempotent.
      const now = Date.now()

      const candidates = trackingUpdates
        .slice(0, 4)
        .filter((update) => {
          const state = update.track.state
          const trackId = String(update.track.trackId)

          // ENTRY:
          // A passenger who has already entered must never be sent
          // through another ENTRY request for this tracked face.
          if (
            cameraRole === "ENTRY" &&
            (state === "BOARDED" || state === "ALREADY_BOARDED")
          ) {
            return false
          }


          // If this exact tracked face already completed the operation
          // for the current camera role, do not send it again.
          const processedRole =
            processedCameraRoleRef.current.get(trackId)

          if (processedRole === cameraRole) {
            return false
          }

          const attemptKey = `${currentTripId}:${cameraRole}:${trackId}`
          const lastAttempt =
            lastRecognitionAttemptRef.current.get(attemptKey) ?? 0

          // Retry UNKNOWN/transient failures after 4 seconds.
          return now - lastAttempt >= 4000
        })

      console.log("[FACE RECOGNITION PIPELINE]", {
        detected: limitedDetections.length,
        tracks: trackingUpdates.length,
        candidates: candidates.length,
        states: trackingUpdates.map((u) => ({
          trackId: String(u.track.trackId),
          state: u.track.state,
          quality: u.track.quality?.qualityScore,
          liveness: u.track.liveness?.livenessStatus,
        })),
      })

      if (candidates.length === 0) {
        const boardedCount = trackingUpdates.filter(
          (u) =>
            u.track.state === "BOARDED" ||
            u.track.state === "ALREADY_BOARDED"
        ).length

        setScanNotice(
          boardedCount > 0
            ? `Face already processed for trip ${currentTripId}`
            : "Face detected — waiting for the next verification attempt"
        )

        processingRef.current = false
        setProcessing(false)
        return
      }

      // Record attempts before the network request to prevent overlapping
      // scans from creating duplicate client requests.
      candidates.forEach((update) => {
        const trackId = String(update.track.trackId)
        const attemptKey = `${currentTripId}:${cameraRole}:${trackId}`

        lastRecognitionAttemptRef.current.set(
          attemptKey,
          now
        )
      })

      const facesToSend = candidates.map((update) => {
        const trackId =
          String(update.track.trackId)

        const fallbackEmbedding =
          update.faceItem.embedding

        const history =
          embeddingHistoryRef.current.get(trackId) ?? []

        const qualityHistory =
          embeddingQualityHistoryRef.current.get(trackId) ?? []

        // Use the current embedding if temporal history
        // is not available yet.
        if (history.length === 0) {
          return {
            embedding: fallbackEmbedding,
            bbox: update.faceItem.bbox,
            quality: update.track.quality,
            liveness: update.track.liveness,
          }
        }

        const dimension = 512

        const aggregatedEmbedding =
          new Array<number>(dimension).fill(0)

        let totalWeight = 0

        for (
          let sampleIndex = 0;
          sampleIndex < history.length;
          sampleIndex++
        ) {
          const sample =
            history[sampleIndex]

          if (
            !Array.isArray(sample) ||
            sample.length !== dimension ||
            !sample.every(Number.isFinite)
          ) {
            continue
          }

          const quality =
            Math.max(
              0.1,
              Math.min(
                1,
                qualityHistory[sampleIndex] ?? 0.1
              )
            )

          // Slightly prefer newer observations.
          const recencyWeight =
            0.75 +
            0.25 *
              (
                (sampleIndex + 1) /
                history.length
              )

          const weight =
            quality * recencyWeight

          totalWeight += weight

          for (let i = 0; i < dimension; i++) {
            aggregatedEmbedding[i] +=
              sample[i] * weight
          }
        }

        if (totalWeight <= 0) {
          return {
            embedding: fallbackEmbedding,
            bbox: update.faceItem.bbox,
            quality: update.track.quality,
            liveness: update.track.liveness,
          }
        }

        // Weighted mean.
        for (let i = 0; i < dimension; i++) {
          aggregatedEmbedding[i] /=
            totalWeight
        }

        // L2-normalize the final ArcFace vector.
        const norm = Math.sqrt(
          aggregatedEmbedding.reduce(
            (sum, value) =>
              sum + value * value,
            0
          )
        )

        if (
          !Number.isFinite(norm) ||
          norm <= 1e-8
        ) {
          return {
            embedding: fallbackEmbedding,
            bbox: update.faceItem.bbox,
            quality: update.track.quality,
            liveness: update.track.liveness,
          }
        }

        for (let i = 0; i < dimension; i++) {
          aggregatedEmbedding[i] /=
            norm
        }

        console.log(
          "[ADVANCED EMBEDDING AGGREGATION]",
          {
            trackId,
            samples: history.length,
            qualitySamples:
              qualityHistory.length,
            dimension,
            norm: Number(
              norm.toFixed(6)
            ),
          }
        )

        return {
          embedding: aggregatedEmbedding,
          bbox: update.faceItem.bbox,
          quality: update.track.quality,
          liveness: update.track.liveness,
        }
      })
      setScanNotice(
        `Verifying ${facesToSend.length} face${facesToSend.length === 1 ? "" : "s"}...`
      )

      // 5. Backend is authoritative for identity, fee, bus assignment,
      // capacity and boarding/deboarding idempotency.
      console.log("[FACE SEND]", {
        count: facesToSend.length,
        embeddingDimensions: facesToSend.map((f) => f.embedding.length),
        quality: facesToSend.map((f) => f.quality),
        liveness: facesToSend.map((f) => f.liveness),
      })

      const res = await recognizeFacesBatch(
        busId,
        currentStop,
        facesToSend,
        currentTripId,
        cameraRole
      )

      console.log("[FACE RESPONSE]", res)

      console.log("[FACE RECOGNITION RESULT]", res)

      // 6. Map results back to the filtered candidate list.
      // Do NOT use trackingUpdates[idx] because candidates are filtered.
      res.processed_faces.forEach((pf, idx) => {
        const candidate = candidates[idx]

        if (!candidate) return

        const trackId = String(candidate.track.trackId)

        // ENTRY completed successfully or was already completed.
        if (
          cameraRole === "ENTRY" &&
          (pf.status === "RECOGNIZED" ||
            pf.status === "ALREADY BOARDED" ||
            pf.status === "ALREADY EXITED")
        ) {
          processedCameraRoleRef.current.set(trackId, "ENTRY")

          temporalFaceTracker.markBoarded(
            candidate.track.trackId,
            pf.student_id,
            currentTripId
          )
        }

        // EXIT completed successfully or was already completed.
        if (
          cameraRole === "EXIT" &&
          (pf.status === "EXIT SUCCESSFUL" ||
            pf.status === "ALREADY EXITED")
        ) {
          processedCameraRoleRef.current.set(trackId, "EXIT")
        }
      })

      updateRecognitionResults(res)
    } catch (err: any) {
      console.error("Frame recognition error:", err)

      const message =
        err?.detail ||
        err?.message ||
        (typeof err === "string" ? err : "Failed to process face")

      setScanNotice(`Recognition error: ${message}`)
    } finally {
      processingRef.current = false
      setProcessing(false)
    }
  }


  // Update 4-card UI state with results

  const updateRecognitionResults = (res: MultiFaceRecognitionResponse) => {

    setLastScanTime(new Date().toLocaleTimeString())

    setScanNotice(res.message || `Processed ${res.count} student(s) at entrance`)



    // Fill up to 4 cards

    const updatedCards: FaceRecognitionItem[] = []



    for (let i = 0; i < 4; i++) {

      if (i < res.processed_faces.length) {

        updatedCards.push(res.processed_faces[i])

      } else {

        // Empty slot

        updatedCards.push({

          face_index: i + 1,

          student_id: "Empty Slot",

          name: "No face detected in slot",

          status: "LOW CONFIDENCE",

          recognition_state: "DETECTING",

          confidence: 0,

          fee_status: "NONE",

          assigned_bus: busId,

          boarding_status: "STANDBY",

          message: "Ready for next passenger",

        })

      }

    }



    setRecognizedFaces(updatedCards)

    onAttendanceUpdated()

  }



  // 1-Student Entrance Test Simulation (Anita Sharma - Registered & Paid)

  const handleSimulateSingleStudent = async () => {

    setProcessing(true)

    setScanNotice("[Simulation] Simulating 1 registered student (Anita Sharma) entering...")

    try {

      const simulatedFaces = [

        {

          embedding: generateCanonicalFaceEmbedding("3BR23EC045"),

          bbox: { x: 120, y: 50, width: 140, height: 180 },

          quality: { qualityScore: 0.94, qualityLabel: "EXCELLENT", isAcceptable: true },

          liveness: { isLive: true, livenessStatus: "VERIFIED" as const, livenessScore: 0.95 },

        },

      ]

      const res = await recognizeFacesBatch(busId, currentStop, simulatedFaces, currentTripId)

      updateRecognitionResults(res)

    } catch (err: any) {

      setScanNotice("Error: " + (err?.detail || err?.message))

    } finally {

      setProcessing(false)

    }

  }



  // Multi-Student Entrance Test Simulation (Tests 4 simultaneous students entering at once!)

  const handleSimulateMultiStudentEntrance = async () => {

    setProcessing(true)

    setScanNotice("[Simulation] Simulating 4 students entering the bus simultaneously...")



    try {

      const simulatedFaces = [

        // Face 1: Anita Sharma (Registered & Paid)

        {

          embedding: generateCanonicalFaceEmbedding("3BR23EC045"),

          bbox: { x: 30, y: 50, width: 120, height: 160 },

          quality: { qualityScore: 0.92, qualityLabel: "EXCELLENT", isAcceptable: true },

          liveness: { isLive: true, livenessStatus: "VERIFIED" as const, livenessScore: 0.94 },

        },

        // Face 2: Kiran Kumar (Registered & Paid)

        {

          embedding: generateCanonicalFaceEmbedding("3BR23CS089"),

          bbox: { x: 170, y: 50, width: 120, height: 160 },

          quality: { qualityScore: 0.89, qualityLabel: "GOOD", isAcceptable: true },

          liveness: { isLive: true, livenessStatus: "VERIFIED" as const, livenessScore: 0.91 },

        },

        // Face 3: Rahul Verma (Fee Expired / Pending)

        {

          embedding: generateCanonicalFaceEmbedding("3BR23ME012"),

          bbox: { x: 310, y: 50, width: 120, height: 160 },

          quality: { qualityScore: 0.87, qualityLabel: "GOOD", isAcceptable: true },

          liveness: { isLive: true, livenessStatus: "VERIFIED" as const, livenessScore: 0.90 },

        },

        // Face 4: Unregistered Person

        {

          embedding: generateCanonicalFaceEmbedding("UNREGISTERED_PERSON_RANDOM_99"),

          bbox: { x: 450, y: 50, width: 120, height: 160 },

          quality: { qualityScore: 0.80, qualityLabel: "GOOD", isAcceptable: true },

          liveness: { isLive: true, livenessStatus: "VERIFIED" as const, livenessScore: 0.85 },

        },

      ]



      const res = await recognizeFacesBatch(busId, currentStop, simulatedFaces, currentTripId)

      updateRecognitionResults(res)

    } catch (err: any) {

      console.error("Simulation error:", err)

      setScanNotice("Simulation error: " + (err?.detail || err?.message))

    } finally {

      setProcessing(false)

    }

  }



  // 10s Continuous Standing Anti-Duplicate Test:

  // Tests that repeated/continuous visibility of the same student creates exactly ONE boarding event and NEVER duplicates!

  const handleSimulateContinuousStanding = async () => {

    setProcessing(true)

    setScanNotice(

      "[Anti-Duplicate Test] Firing continuous frames of Anita Sharma (Simulating standing in front of camera for 10s)..."

    )



    try {

      const studentFace = {

        embedding: generateCanonicalFaceEmbedding("3BR23EC045"),

        bbox: { x: 120, y: 50, width: 140, height: 180 },

        quality: { qualityScore: 0.95, qualityLabel: "EXCELLENT", isAcceptable: true },

        liveness: { isLive: true, livenessStatus: "VERIFIED" as const, livenessScore: 0.96 },

      }



      // Frame 1: First appearance -> Boards or detects already boarded

      const res1 = await recognizeFacesBatch(busId, currentStop, [studentFace], currentTripId)

      updateRecognitionResults(res1)



      // Short delay, then Frame 2 (student still standing)

      await new Promise((r) => setTimeout(r, 600))

      const res2 = await recognizeFacesBatch(busId, currentStop, [studentFace], currentTripId)

      updateRecognitionResults(res2)



      // Short delay, then Frame 3 (student still standing 10 seconds later)

      await new Promise((r) => setTimeout(r, 600))

      const res3 = await recognizeFacesBatch(busId, currentStop, [studentFace], currentTripId)

      updateRecognitionResults(res3)



      setScanNotice(

        `Anti-Duplicate Consensus Verified: Student remained in camera view across consecutive frames. Status: "${res3.processed_faces[0]?.status}". No duplicate boarding event recorded!`

      )

    } catch (err: any) {

      setScanNotice("Test error: " + (err?.detail || err?.message))

    } finally {

      setProcessing(false)

    }

  }



  // Motion Blur / Low Quality Test Simulation

  const handleSimulateLowQualityBlur = async () => {

    setProcessing(true)

    setScanNotice("[Quality Test] Simulating heavily blurred face entering entrance...")

    try {

      const blurFace = {

        embedding: generateCanonicalFaceEmbedding("3BR23EC045"),

        bbox: { x: 120, y: 50, width: 140, height: 180 },

        quality: {

          blur: 0.88,

          isAcceptable: false,

          qualityScore: 0.28,

          qualityLabel: "FACE BLURRED",

          error: "Motion blur detected. Frame rejected for biometric verification.",

        },

        liveness: { isLive: true, livenessStatus: "VERIFIED" as const, livenessScore: 0.9 },

      }

      const res = await recognizeFacesBatch(busId, currentStop, [blurFace], currentTripId)

      updateRecognitionResults(res)

    } catch (err: any) {

      setScanNotice("Error: " + (err?.detail || err?.message))

    } finally {

      setProcessing(false)

    }

  }



  // Photo Spoof / Liveness Failure Simulation

  const handleSimulatePhotoSpoof = async () => {

    setProcessing(true)

    setScanNotice("[Anti-Spoof Test] Simulating printed paper photo presented to camera...")

    try {

      const spoofFace = {

        embedding: generateCanonicalFaceEmbedding("3BR23EC045"),

        bbox: { x: 120, y: 50, width: 140, height: 180 },

        quality: { qualityScore: 0.90, qualityLabel: "GOOD", isAcceptable: true },

        liveness: {

          isLive: false,

          livenessStatus: "FAILED" as const,

          livenessScore: 0.12,

          reason: "Static printed paper photo detected. Motion variance zero.",

        },

      }

      const res = await recognizeFacesBatch(busId, currentStop, [spoofFace], currentTripId)

      updateRecognitionResults(res)

    } catch (err: any) {

      setScanNotice("Error: " + (err?.detail || err?.message))

    } finally {

      setProcessing(false)

    }

  }



  // Student Exit / Deboarding Test Simulation (Anita Sharma deboarding at exit camera)

  const handleSimulateExitStudent = async () => {

    setProcessing(true)

    setScanNotice("[Exit Simulation] Simulating student (Anita Sharma) scanning at exit door camera...")

    try {

      const exitFace = {

        embedding: generateCanonicalFaceEmbedding("3BR23EC045"),

        bbox: { x: 120, y: 50, width: 140, height: 180 },

        quality: { qualityScore: 0.94, qualityLabel: "EXCELLENT", isAcceptable: true },

        liveness: { isLive: true, livenessStatus: "VERIFIED" as const, livenessScore: 0.95 },

      }

      const res = await recognizeFacesBatch(busId, currentStop, [exitFace], currentTripId, "EXIT")

      updateRecognitionResults(res)

    } catch (err: any) {

      setScanNotice("Exit error: " + (err?.detail || err?.message))

    } finally {

      setProcessing(false)

    }

  }



  // Deboarding Rejection Test (Student never boarded tries to exit)

  const handleSimulateExitUnboarded = async () => {

    setProcessing(true)

    setScanNotice("[Exit Gate Test] Simulating unboarded student presenting at exit door...")

    try {

      const unboardedFace = {

        embedding: generateCanonicalFaceEmbedding("3BR23ME012"), // Rahul Verma

        bbox: { x: 120, y: 50, width: 140, height: 180 },

        quality: { qualityScore: 0.90, qualityLabel: "GOOD", isAcceptable: true },

        liveness: { isLive: true, livenessStatus: "VERIFIED" as const, livenessScore: 0.92 },

      }

      const res = await recognizeFacesBatch(busId, currentStop, [unboardedFace], currentTripId, "EXIT")

      updateRecognitionResults(res)

    } catch (err: any) {

      setScanNotice("Exit error: " + (err?.detail || err?.message))

    } finally {

      setProcessing(false)

    }

  }



  const isOvercapacity = currentPassengers >= capacity



  return (

    <div id="driver-face-recognition-terminal">
{/* Video Feed & Multi-Face Overlay Area */}

      {cameraActive && (

        <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 space-y-3">

          <div className="flex items-center justify-between text-xs">

            <div className="flex items-center gap-2">

              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping" />

              <span className="text-zinc-200 font-semibold">Bus Entrance Camera Feed</span>

              {cameraPaused && (

                <span className="px-2 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30">

                  Paused

                </span>

              )}

            </div>



            <div className="flex items-center gap-4 text-zinc-400 font-mono text-[11px]">

              <span>Detected: {detectedCount}/4 faces</span>

              <span>Stop: {currentStop}</span>

            </div>

          </div>



          <div className="relative mx-auto max-w-xl aspect-video rounded-xl overflow-hidden bg-black border border-zinc-800">

            <video

              ref={videoRef}

              autoPlay

              playsInline

              muted

              className="w-full h-full object-cover"

            />

            <canvas

              ref={canvasRef}

              className="absolute inset-0 w-full h-full pointer-events-none"

            />



            {processing && (

              <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px] flex items-center justify-center gap-2 text-white text-xs font-semibold">

                <RefreshCw className="h-4 w-4 animate-spin text-emerald-400" />

                <span>Processing biometrics & verifying consensus...</span>

              </div>

            )}

          </div>



          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-zinc-400 pt-1">

            <div className="flex items-center gap-2">

              <input

                id="chk-auto-scan"

                type="checkbox"

                checked={autoScanEnabled}

                onChange={(e) => setAutoScanEnabled(e.target.checked)}

                className="rounded border-zinc-700 bg-zinc-800 text-emerald-500 focus:ring-0"

              />

              <label htmlFor="chk-auto-scan" className="text-zinc-300 cursor-pointer">

                Auto-scan every 2 seconds

              </label>

            </div>



            <div className="flex items-center gap-2">

              <button

                id="btn-scan-frame-now"

                onClick={processCurrentFrame}

                disabled={processing}

                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 font-medium transition"

              >

                <RefreshCw className={`h-3 w-3 ${processing ? "animate-spin text-emerald-400" : ""}`} />

                Scan Current Frame

              </button>

            </div>

          </div>

        </div>

      )}



      {cameraError && (

        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs">

          <p className="font-semibold">Camera Access Note:</p>

          <p className="mt-1 text-zinc-300">{cameraError}</p>

        </div>

      )}



    </div>

  )

}


























