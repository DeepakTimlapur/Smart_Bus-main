import React, { useState, useEffect, useRef } from "react"
import { Eye, Camera, ShieldCheck, AlertTriangle, RefreshCw, CheckCircle2, XCircle } from "lucide-react"

export default function FaceRecognitionWidget() {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const [cameraError, setCameraError] = useState(null)
  const [scanStatus, setScanStatus] = useState("Waiting for scan...")
  const [recognizedStudent, setRecognizedStudent] = useState(null)
  const [boardingDirection, setBoardingDirection] = useState("IN")
  const [activeSlots, setActiveSlots] = useState([
    { id: 1, status: "STANDBY", name: "Empty Slot", confidence: 0 },
    { id: 2, status: "STANDBY", name: "Empty Slot", confidence: 0 },
    { id: 3, status: "STANDBY", name: "Empty Slot", confidence: 0 },
    { id: 4, status: "STANDBY", name: "Empty Slot", confidence: 0 },
  ])

  // Start Webcam Stream
  const startCamera = async () => {
    setCameraError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }
      })
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        setIsStreaming(true)
        setScanStatus("Camera active - Scanning for faces...")
      }
    } catch (err) {
      console.error("Webcam access error:", err)
      setCameraError("Unable to access webcam. Please check browser permissions or use test simulation buttons below.")
      setIsStreaming(false)
    }
  }

  // Stop Webcam Stream
  const stopCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject
      const tracks = stream.getTracks()
      tracks.forEach(track => track.stop())
      videoRef.current.srcObject = null
    }
    setIsStreaming(false)
    setScanStatus("Camera paused / offline")
  }

  // Simulate or trigger scan capture
  const handleSimulatedScan = (type) => {
    if (type === "single") {
      setScanStatus("Verified: Student Matched")
      setRecognizedStudent({ name: "Aarav Sharma", id: "STU-2026-089", status: "BOARDED", fee: "PAID" })
      setActiveSlots([
        { id: 1, status: "VERIFIED", name: "Aarav Sharma (STU-089)", confidence: 96.4 },
        { id: 2, status: "STANDBY", name: "Empty Slot", confidence: 0 },
        { id: 3, status: "STANDBY", name: "Empty Slot", confidence: 0 },
        { id: 4, status: "STANDBY", name: "Empty Slot", confidence: 0 },
      ])
    } else if (type === "multi") {
      setScanStatus("Multi-Face Entrances Detected (4 simultaneous)")
      setRecognizedStudent(null)
      setActiveSlots([
        { id: 1, status: "VERIFIED", name: "Aarav Sharma", confidence: 95.1 },
        { id: 2, status: "VERIFIED", name: "Priya Patel", confidence: 94.8 },
        { id: 3, status: "VERIFIED", name: "Rahul Verma", confidence: 92.5 },
        { id: 4, status: "VERIFIED", name: "Ananya Singh", confidence: 97.2 },
      ])
    } else if (type === "blur") {
      setScanStatus("Motion Blur Detected - Please hold steady")
      setActiveSlots([
        { id: 1, status: "BLUR", name: "Motion Blur Rejected", confidence: 35.0 },
        { id: 2, status: "STANDBY", name: "Empty Slot", confidence: 0 },
        { id: 3, status: "STANDBY", name: "Empty Slot", confidence: 0 },
        { id: 4, status: "STANDBY", name: "Empty Slot", confidence: 0 },
      ])
    }
  }

  useEffect(() => {
    return () => {
      stopCamera()
    }
  }, [])

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/90 p-6 text-zinc-100 shadow-xl backdrop-blur-md space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-zinc-800 pb-4">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
            <Eye className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold">Cabin Face Recognition Terminal</h2>
            <p className="text-xs text-zinc-400">
              SCRFD-500M Face Detection & ArcFace Biometric Boarding System
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            Connected (BUS-01)
          </span>
        </div>
      </div>

      {/* Main Terminal View / Camera Feed */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Camera Feed Box */}
        <div className="lg:col-span-2 rounded-xl border border-zinc-800 bg-zinc-950 p-4 flex flex-col items-center justify-center relative min-h-[300px] overflow-hidden">
          {cameraError && (
            <div className="absolute inset-0 bg-zinc-950/90 flex flex-col items-center justify-center p-6 text-center z-20">
              <AlertTriangle className="h-10 w-10 text-amber-400 mb-2" />
              <p className="text-sm font-semibold text-zinc-200">{cameraError}</p>
              <button
                onClick={startCamera}
                className="mt-4 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-bold text-xs transition"
              >
                Retry Camera
              </button>
            </div>
          )}

          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-64 object-cover rounded-lg border border-zinc-800 ${isStreaming ? "block" : "hidden"}`}
          />
          <canvas ref={canvasRef} className="hidden" />

          {!isStreaming && !cameraError && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Camera className="h-12 w-12 text-zinc-600 mb-3 animate-bounce" />
              <p className="text-sm font-medium text-zinc-400">Camera feed is currently offline.</p>
              <button
                onClick={startCamera}
                className="mt-4 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition flex items-center gap-2 shadow-lg"
              >
                <Camera className="h-4 w-4" />
                <span>Start Entrance Camera</span>
              </button>
            </div>
          )}

          {isStreaming && (
            <button
              onClick={stopCamera}
              className="mt-3 px-4 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 border border-rose-500/30 font-semibold text-xs transition"
            >
              Stop Camera
            </button>
          )}
        </div>

        {/* Status & Direction Panel */}
        <div className="flex flex-col justify-between space-y-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
            <div>
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-mono block">Boarding Direction</span>
              <div className="flex items-center gap-2 mt-1">
                <button
                  onClick={() => setBoardingDirection("IN")}
                  className={`flex-1 py-1.5 rounded-lg font-bold text-xs transition ${boardingDirection === "IN" ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400"}`}
                >
                  Entry Door (IN)
                </button>
                <button
                  onClick={() => setBoardingDirection("OUT")}
                  className={`flex-1 py-1.5 rounded-lg font-bold text-xs transition ${boardingDirection === "OUT" ? "bg-amber-600 text-white" : "bg-zinc-800 text-zinc-400"}`}
                >
                  Exit Door (OUT)
                </button>
              </div>
            </div>

            <div className="pt-2 border-t border-zinc-800">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-mono block">Terminal Status</span>
              <p className="text-sm font-semibold text-emerald-400 mt-1 flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4" />
                {scanStatus}
              </p>
            </div>

            {recognizedStudent && (
              <div className="pt-2 border-t border-zinc-800 bg-emerald-500/5 p-2 rounded-lg border border-emerald-500/20">
                <span className="text-[10px] text-emerald-400 font-bold uppercase block">Last Recognized Student</span>
                <span className="text-sm font-bold text-white block">{recognizedStudent.name}</span>
                <span className="text-xs text-zinc-400 font-mono">{recognizedStudent.id} &bull; Fee: {recognizedStudent.fee}</span>
              </div>
            )}
          </div>

          {/* Test & Simulation Buttons */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-2">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-mono block">Validation Suite</span>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => handleSimulatedScan("single")}
                className="py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold transition text-left"
              >
                &bull; 1 Student Scan
              </button>
              <button
                onClick={() => handleSimulatedScan("multi")}
                className="py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold transition text-left"
              >
                &bull; 4 Simultaneous
              </button>
              <button
                onClick={() => handleSimulatedScan("blur")}
                className="py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold transition text-left"
              >
                &bull; Motion Blur Test
              </button>
              <button
                onClick={() => { setScanStatus("Waiting for scan..."); setActiveSlots([{ id: 1, status: "STANDBY", name: "Empty Slot", confidence: 0 }, { id: 2, status: "STANDBY", name: "Empty Slot", confidence: 0 }, { id: 3, status: "STANDBY", name: "Empty Slot", confidence: 0 }, { id: 4, status: "STANDBY", name: "Empty Slot", confidence: 0 }]); setRecognizedStudent(null); }}
                className="py-2 px-3 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 text-xs font-semibold transition text-left"
              >
                <RefreshCw className="h-3 w-3 inline mr-1" /> Reset Slots
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 4 Multi-Face Slots Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-2">
        {activeSlots.map((slot) => (
          <div key={slot.id} className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-zinc-400 uppercase font-mono">Face Slot #{slot.id}</span>
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                slot.status === "VERIFIED" ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" :
                slot.status === "BLUR" ? "bg-amber-500/20 text-amber-400 border border-amber-500/30" :
                "bg-zinc-800 text-zinc-400"
              }`}>
                {slot.status}
              </span>
            </div>
            <div>
              <p className="text-sm font-bold text-white truncate">{slot.name}</p>
              <p className="text-xs text-zinc-500 font-mono mt-0.5">Confidence: {slot.confidence}%</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}