"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import {
  Camera,
  CheckCircle2,
  AlertCircle,
  Clock,
  ShieldCheck,
  RefreshCw,
  Eye,
  Sparkles,
  Lock,
  ChevronRight,
  Info,
  X,
} from "lucide-react"
import {
  getFaceStatus,
  registerStudentFace,
  enrollStudentFaceSamples,
  requestFaceReRegistration,
  type FaceStatusResponse,
} from "@/lib/api"
import { ClientFaceEngine } from "@/lib/face-recognition"

interface FaceRegistrationProps {
  studentId: string
  studentName?: string
  department?: string
  assignedBus?: string
  onStatusChanged?: () => void
}

export default function FaceRegistration({
  studentId,
  studentName,
  department,
  assignedBus,
  onStatusChanged,
}: FaceRegistrationProps) {
  const [faceStatus, setFaceStatus] = useState<FaceStatusResponse | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [cameraActive, setCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [faceDetected, setFaceDetected] = useState(false)
  const [samplesCollected, setSamplesCollected] = useState(0)
  const [collecting, setCollecting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [showReregModal, setShowReregModal] = useState(false)
  const [reregReason, setReregReason] = useState("")
  const [reregSubmitting, setReregSubmitting] = useState(false)
  const [faceQualityNotice, setFaceQualityNotice] = useState("Align face inside the oval frame")

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const sampleEmbeddingsRef = useRef<number[][]>([])
  const detectionAnimRef = useRef<number | null>(null)

  // Load status
  const fetchStatus = useCallback(async () => {
    try {
      setLoadingStatus(true)
      const res = await getFaceStatus(studentId)
      setFaceStatus(res)
    } catch (err: any) {
      console.warn("Could not load face status:", err?.message || err)
    } finally {
      setLoadingStatus(false)
    }
  }, [studentId])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  // Stop camera stream cleanly (Privacy Compliance)
  const stopCamera = useCallback(() => {
    if (detectionAnimRef.current) {
      cancelAnimationFrame(detectionAnimRef.current)
      detectionAnimRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    setCameraActive(false)
    setCollecting(false)
    setFaceDetected(false)
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopCamera()
    }
  }, [stopCamera])

  // Start Camera
  const startCamera = async () => {
    setCameraError(null)
    setErrorMessage(null)
    setSuccessMessage(null)
    setSamplesCollected(0)
    sampleEmbeddingsRef.current = []

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: "user",
        },
        audio: false,
      })

      streamRef.current = stream
      setCameraActive(true)

      // Allow react DOM to render video element
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play().then(() => {
            startDetectionLoop()
          }).catch((err) => {
            console.error("Video play failed:", err)
          })
        }
      }, 100)
    } catch (err: any) {
      console.error("Camera access failed:", err)
      const msg =
        err.name === "NotAllowedError" || err.name === "PermissionDeniedError"
          ? "Camera permission denied by browser. You can enable it in site settings or use Quick Biometric Capture."
          : "Webcam not detected or unavailable. You can use Quick Biometric Capture."
      setCameraError(msg)
      setCameraActive(false)
    }
  }

  // Detection loop
  const startDetectionLoop = () => {
    const loop = () => {
      if (!videoRef.current || !canvasRef.current || videoRef.current.readyState < 2) {
        detectionAnimRef.current = requestAnimationFrame(loop)
        return
      }

      const video = videoRef.current
      const canvas = canvasRef.current
      const ctx = canvas.getContext("2d")

      if (ctx) {
        canvas.width = video.videoWidth || 640
        canvas.height = video.videoHeight || 480

        const detections = ClientFaceEngine.detectFaces(video)

        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height)

        // Draw oval guide
        const centerX = canvas.width / 2
        const centerY = canvas.height / 2
        const radiusX = canvas.width * 0.22
        const radiusY = canvas.height * 0.35

        ctx.beginPath()
        ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, 2 * Math.PI)
        ctx.lineWidth = 3
        ctx.strokeStyle = detections.length > 0 ? "#10b981" : "rgba(255, 255, 255, 0.4)"
        ctx.setLineDash([8, 6])
        ctx.stroke()
        ctx.setLineDash([])

        if (detections.length > 0) {
          const det = detections[0]
          setFaceDetected(true)
          setFaceQualityNotice("Face Detected & Centered • Ready to sample")

          // Draw bounding box
          ctx.strokeStyle = "#10b981"
          ctx.lineWidth = 2
          ctx.strokeRect(det.bbox.x, det.bbox.y, det.bbox.width, det.bbox.height)

          // Corners
          const len = 16
          ctx.lineWidth = 4
          // Top-left
          ctx.beginPath()
          ctx.moveTo(det.bbox.x, det.bbox.y + len)
          ctx.lineTo(det.bbox.x, det.bbox.y)
          ctx.lineTo(det.bbox.x + len, det.bbox.y)
          ctx.stroke()
          // Top-right
          ctx.beginPath()
          ctx.moveTo(det.bbox.x + det.bbox.width - len, det.bbox.y)
          ctx.lineTo(det.bbox.x + det.bbox.width, det.bbox.y)
          ctx.lineTo(det.bbox.x + det.bbox.width, det.bbox.y + len)
          ctx.stroke()
          // Bottom-left
          ctx.beginPath()
          ctx.moveTo(det.bbox.x, det.bbox.y + det.bbox.height - len)
          ctx.lineTo(det.bbox.x, det.bbox.y + det.bbox.height)
          ctx.lineTo(det.bbox.x + len, det.bbox.y + det.bbox.height)
          ctx.stroke()
          // Bottom-right
          ctx.beginPath()
          ctx.moveTo(det.bbox.x + det.bbox.width - len, det.bbox.y + det.bbox.height)
          ctx.lineTo(det.bbox.x + det.bbox.width, det.bbox.y + det.bbox.height)
          ctx.lineTo(det.bbox.x + det.bbox.width, det.bbox.y + det.bbox.height - len)
          ctx.stroke()

          // Draw label
          ctx.fillStyle = "#10b981"
          ctx.font = "bold 13px sans-serif"
          ctx.fillText(`BIOMETRIC FACE TARGET [${Math.round(det.confidence * 100)}%]`, det.bbox.x + 4, det.bbox.y - 8)
        } else {
          setFaceDetected(false)
          setFaceQualityNotice("Center your face inside the oval guide")
        }
      }

      detectionAnimRef.current = requestAnimationFrame(loop)
    }

    detectionAnimRef.current = requestAnimationFrame(loop)
  }

  // Sample collection: captures real JPEG frames from the video element.
  // Each accepted frame is encoded as a data-URL and collected for
  // server-side embedding generation via the shared ONNX model.
  const collectSamples = async () => {
    if (!videoRef.current || !canvasRef.current) return
    setCollecting(true)
    setErrorMessage(null)
    sampleEmbeddingsRef.current = []
    setSamplesCollected(0)

    const TOTAL_SAMPLES = 5
    const capturedImages: string[] = []

    for (let i = 1; i <= TOTAL_SAMPLES; i++) {
      if (!videoRef.current || !streamRef.current) break

      const detections = ClientFaceEngine.detectFaces(videoRef.current)
      if (detections.length === 0) {
        setFaceQualityNotice(`Sample ${i}/${TOTAL_SAMPLES}: no face detected, retrying…`)
        await new Promise((res) => setTimeout(res, 600))
        i-- // retry this sample
        continue
      }

      // Capture real pixel data from the video frame into a JPEG data-URL.
      const canvas = canvasRef.current
      const ctx = canvas.getContext("2d")
      if (!ctx) break
      canvas.width = videoRef.current.videoWidth || 640
      canvas.height = videoRef.current.videoHeight || 480
      ctx.drawImage(videoRef.current, 0, 0)
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85)
      capturedImages.push(dataUrl)
      setSamplesCollected(i)
      setFaceQualityNotice(`Sample ${i}/${TOTAL_SAMPLES} captured ✓`)

      await new Promise((res) => setTimeout(res, 500))
    }

    setCollecting(false)

    if (capturedImages.length >= 3) {
      await finalizeRegistration(capturedImages)
    } else {
      setErrorMessage("Could not capture enough clear samples. Please ensure good lighting and try again.")
    }
  }

  // Finalize: send real captured JPEG frames to the server.
  // The server (lib/face-embedding-server.ts + the enroll-samples route)
  // runs them through the ONE shared ONNX model and stores the resulting
  // real embedding with full provenance metadata. No embedding generation
  // happens on the browser side -- we send pixels, receive a stored result.
  const finalizeRegistration = async (capturedImages: string[]) => {
    setSubmitting(true)
    try {
      const res = await enrollStudentFaceSamples(capturedImages)
      setSuccessMessage(res.message || "Face registration completed successfully!")
      stopCamera()
      await fetchStatus()
      if (onStatusChanged) onStatusChanged()
    } catch (err: any) {
      // A 503 here means the real ONNX model isn't installed yet on the
      // server -- surface that clearly rather than swallowing it.
      setErrorMessage(err?.detail || err?.message || "Failed to register face biometrics.")
    } finally {
      setSubmitting(false)
    }
  }

  // Submit re-registration request to admin
  const handleSubmitReRegistration = async (e: React.FormEvent) => {
    e.preventDefault()
    setReregSubmitting(true)
    try {
      const res = await requestFaceReRegistration(reregReason || "Appearance update")
      setSuccessMessage(res.message || "Re-registration request submitted to Administrator.")
      setShowReregModal(false)
      setReregReason("")
      await fetchStatus()
      if (onStatusChanged) onStatusChanged()
    } catch (err: any) {
      setErrorMessage(err?.detail || err?.message || "Failed to submit request.")
    } finally {
      setReregSubmitting(false)
    }
  }

  const isRegistered = Boolean(faceStatus?.face_registered)
  const reregStatus = faceStatus?.face_reregistration_status || "NONE"
  const isReregPending = reregStatus === "PENDING"
  const isReregApproved = reregStatus === "APPROVED"

  return (
    <div id="student-face-registration-module" className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-zinc-800/80">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
            <Eye className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-white">Biometric Face Registration</h3>
              <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-zinc-800 text-zinc-300 border border-zinc-700">
                Transit Biometrics
              </span>
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">
              Secure 512D facial embedding for hands-free boarding recognition
            </p>
          </div>
        </div>

        {/* Current Status Pill */}
        <div className="flex items-center gap-2">
          {loadingStatus ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700">
              <RefreshCw className="h-3 w-3 animate-spin" />
              Loading status...
            </span>
          ) : isReregPending ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
              <Clock className="h-3.5 w-3.5" />
              Re-registration Pending Approval
            </span>
          ) : isReregApproved ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Re-registration Approved: Register New Face
            </span>
          ) : isRegistered ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Face Registered
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700">
              <AlertCircle className="h-3.5 w-3.5 text-amber-400" />
              Not Registered
            </span>
          )}
        </div>
      </div>

      {/* Messages */}
      {successMessage && (
        <div className="mt-4 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{successMessage}</span>
          </div>
          <button onClick={() => setSuccessMessage(null)} className="text-zinc-400 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {errorMessage && (
        <div className="mt-4 p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={() => setErrorMessage(null)} className="text-zinc-400 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Main Body */}
      <div className="mt-6">
        {/* State A: Face Already Registered */}
        {isRegistered && !isReregApproved && !cameraActive ? (
          <div className="p-6 rounded-xl bg-zinc-950/60 border border-zinc-800">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-emerald-400" />
                  <h4 className="text-sm font-semibold text-white">Active Face Profile on Record</h4>
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed max-w-xl">
                  Your facial biometrics are securely registered in the Smart Bus Transit System.
                  When you board bus <span className="text-zinc-200 font-semibold">{assignedBus}</span>,
                  the driver camera will automatically recognize you and record your attendance.
                </p>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2 text-xs">
                  <div className="p-2.5 rounded-lg bg-zinc-900 border border-zinc-800">
                    <span className="text-zinc-500 block">Registration Status</span>
                    <span className="text-emerald-400 font-semibold mt-0.5 block">Active & Verified</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-zinc-900 border border-zinc-800">
                    <span className="text-zinc-500 block">Registered Date</span>
                    <span className="text-zinc-300 font-mono mt-0.5 block truncate">
                      {faceStatus?.face_registered_at
                        ? new Date(faceStatus.face_registered_at).toLocaleDateString()
                        : "Verified"}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-zinc-900 border border-zinc-800">
                    <span className="text-zinc-500 block">Sample Quality</span>
                    <span className="text-zinc-300 font-semibold mt-0.5 block">5 High-Res Samples</span>
                  </div>
                </div>
              </div>

              {/* Action: Re-registration Request */}
              <div className="flex flex-col sm:items-end justify-center shrink-0">
                {isReregPending ? (
                  <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-center max-w-xs">
                    <Clock className="h-6 w-6 text-amber-400 mx-auto mb-1.5" />
                    <span className="text-xs font-semibold text-amber-300 block">
                      Request Under Review
                    </span>
                    <p className="text-[11px] text-zinc-400 mt-1">
                      Administrator approval is pending. You will be notified once reviewed.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <button
                      id="btn-re-register-face"
                      onClick={() => {
                        setCameraActive(true)
                        startCamera()
                      }}
                      className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-sm transition"
                    >
                      <Camera className="h-3.5 w-3.5" />
                      Update Face Biometrics
                    </button>
                    <button
                      id="btn-request-reregistration"
                      onClick={() => setShowReregModal(true)}
                      className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold border border-zinc-700 transition shadow-sm"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Request Re-registration
                    </button>
                  </div>
                )}
                <span className="text-[11px] text-zinc-500 mt-2 text-right">
                  Only one face profile can be active per student
                </span>
              </div>
            </div>
          </div>
        ) : (
          /* State B: Not Registered OR Re-registration Approved OR Active Camera */
          <div>
            {!cameraActive ? (
              <div className="p-6 rounded-xl bg-zinc-950/60 border border-zinc-800 text-center">
                <div className="max-w-md mx-auto space-y-4">
                  <div className="h-16 w-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 mx-auto">
                    <Camera className="h-8 w-8" />
                  </div>

                  <div>
                    <h4 className="text-base font-bold text-white">
                      {isReregApproved ? "Register Your Updated Face" : "Register Your Face for Bus Boarding"}
                    </h4>
                    <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed">
                      Capture your face using your webcam to enable hands-free automatic bus boarding.
                      Make sure you are in a well-lit area looking straight at the camera.
                    </p>
                  </div>

                  {cameraError && (
                    <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 text-left">
                      <p className="font-semibold">Notice:</p>
                      <p className="mt-0.5">{cameraError}</p>
                    </div>
                  )}

                  <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
                    <button
                      id="btn-start-camera"
                      onClick={startCamera}
                      className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg shadow-emerald-950/50 transition"
                    >
                      <Camera className="h-4 w-4" />
                      Start Camera Registration
                    </button>
                  </div>

                  <p className="text-[11px] text-zinc-500 flex items-center justify-center gap-1.5 pt-2">
                    <Lock className="h-3 w-3" />
                    Face images are sent to the server for real biometric embedding. A camera is required.
                  </p>
                </div>
              </div>
            ) : (
              /* Active Camera View */
              <div className="p-6 rounded-xl bg-zinc-950/90 border border-zinc-800 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-ping" />
                    <span className="text-xs font-semibold text-zinc-200">Live Registration Camera</span>
                  </div>
                  <span className="text-xs font-mono text-zinc-400">{faceQualityNotice}</span>
                </div>

                {/* Video & Canvas Frame */}
                <div className="relative mx-auto max-w-lg aspect-video rounded-2xl overflow-hidden bg-black border border-zinc-700 shadow-2xl">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-cover transform -scale-x-100"
                  />
                  <canvas
                    ref={canvasRef}
                    className="absolute inset-0 w-full h-full pointer-events-none transform -scale-x-100"
                  />

                  {/* Corner Visual Indicators */}
                  <div className="absolute top-3 left-3 px-2 py-1 rounded bg-black/60 backdrop-blur-md text-[10px] font-mono text-emerald-400 border border-emerald-500/30">
                    640x480 • 30FPS
                  </div>

                  <div className="absolute top-3 right-3 px-2 py-1 rounded bg-black/60 backdrop-blur-md text-[10px] font-mono text-zinc-300 border border-zinc-700">
                    ID: {studentId}
                  </div>

                  {/* Sample collection indicator */}
                  {collecting && (
                    <div className="absolute bottom-4 inset-x-4 p-3 rounded-xl bg-black/80 backdrop-blur-md border border-emerald-500/40 text-center">
                      <div className="flex items-center justify-between text-xs text-white mb-1.5 font-semibold">
                        <span>Sampling Biometric Features...</span>
                        <span className="text-emerald-400 font-mono">{samplesCollected} / 5</span>
                      </div>
                      <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
                        <div
                          className="bg-emerald-500 h-2 transition-all duration-300 rounded-full"
                          style={{ width: `${(samplesCollected / 5) * 100}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Camera Control Actions */}
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-2">
                  <div className="text-xs text-zinc-400 space-y-0.5">
                    <p className="font-semibold text-zinc-200">Guidelines:</p>
                    <p>1. Center your face inside the green oval.</p>
                    <p>2. Keep still while 5 samples are captured.</p>
                  </div>

                  <div className="flex items-center gap-3 w-full sm:w-auto">
                    <button
                      id="btn-cancel-camera"
                      onClick={stopCamera}
                      disabled={collecting || submitting}
                      className="flex-1 sm:flex-initial px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium border border-zinc-700 transition"
                    >
                      Cancel
                    </button>

                    <button
                      id="btn-capture-face-samples"
                      onClick={collectSamples}
                      disabled={collecting || submitting}
                      className={`flex-1 sm:flex-initial flex items-center justify-center gap-2 px-6 py-2 rounded-xl text-xs font-semibold shadow-lg transition ${
                        faceDetected
                          ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-950/50"
                          : "bg-zinc-700 text-zinc-400 cursor-not-allowed"
                      }`}
                    >
                      {collecting || submitting ? (
                        <>
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                          <span>Processing...</span>
                        </>
                      ) : (
                        <>
                          <Camera className="h-3.5 w-3.5" />
                          <span>Capture & Register Face</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modal: Request Re-Registration */}
      {showReregModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <div className="flex items-center gap-2 text-white font-bold text-base">
                <RefreshCw className="h-4 w-4 text-emerald-400" />
                Request Face Re-registration
              </div>
              <button
                onClick={() => setShowReregModal(false)}
                className="text-zinc-400 hover:text-white transition"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="text-xs text-zinc-400 leading-relaxed">
              In accordance with institutional transit security policy, re-registering your facial biometrics
              requires Administrator approval to prevent duplicate profiles or unauthorized overwrites.
            </p>

            <form onSubmit={handleSubmitReRegistration} className="space-y-4">
              <div>
                <label className="text-xs font-medium text-zinc-300 block mb-1.5">
                  Reason for Face Update
                </label>
                <textarea
                  required
                  rows={3}
                  value={reregReason}
                  onChange={(e) => setReregReason(e.target.value)}
                  placeholder="e.g., Appearance change, new spectacles, updated haircut, or lighting issue during previous registration..."
                  className="w-full rounded-xl bg-zinc-950 border border-zinc-800 p-3 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500 transition"
                />
              </div>

              <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/80 text-[11px] text-zinc-400 space-y-1">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Student ID:</span>
                  <span className="text-zinc-200 font-mono">{studentId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Current Status:</span>
                  <span className="text-emerald-400">Registered</span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowReregModal(false)}
                  className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium border border-zinc-700 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={reregSubmitting}
                  className="flex items-center gap-2 px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg shadow-emerald-950/50 transition"
                >
                  {reregSubmitting ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    "Submit Request"
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
