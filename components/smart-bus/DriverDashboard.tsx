"use client"

import { useState, useEffect } from "react"
import {
  Bus as BusIcon,
  Users,
  UserCheck,
  MapPin,
  Clock,
  Radio,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Send,
  RefreshCw,
  Phone,
  Shield,
  Eye,
  Navigation,
} from "lucide-react"
import {
  recordAttendanceEvent,
  getBuses,
  getAttendance,
  getManagedStudents,
  type Bus,
  type Attendance,
  type AttendanceEventResult,
  type ManagedStudent,
} from "@/lib/api"
import DriverGPS from "./DriverGPS"
import DriverFaceRecognition from "./DriverFaceRecognition"

interface DriverDashboardProps {
  user: {
    username: string
    name?: string | null
    email?: string | null
    phone?: string | null
    assigned_bus?: string | null
    role: string
  }
  initialTab?: "all" | "face" | "cockpit" | "gps" | "manifest"
}

export default function DriverDashboard({ user, initialTab = "all" }: DriverDashboardProps) {
  const assignedBusId = user.assigned_bus || "BUS-01"
  const [activeTab, setActiveTab] = useState<"all" | "face" | "cockpit" | "gps" | "manifest">(initialTab)

  const [busDetails, setBusDetails] = useState<Bus | null>(null)
  const [attendanceList, setAttendanceList] = useState<Attendance[]>([])
  const [assignedStudents, setAssignedStudents] = useState<ManagedStudent[]>([])
  const [loading, setLoading] = useState(false)

  // Terminal State
  const [studentIdInput, setStudentIdInput] = useState("")
  const [actionInput, setActionInput] = useState<"AUTO" | "BOARDED" | "EXITED" | "DENIED">("AUTO")
  const [stopInput, setStopInput] = useState("Main Campus Gate")
  const [terminalLoading, setTerminalLoading] = useState(false)
  const [terminalResult, setTerminalResult] = useState<AttendanceEventResult | null>(null)

  const loadBusData = async () => {
    setLoading(true)
    try {
      const [allBuses, allAttendance, allStudents] = await Promise.all([
        getBuses().catch(() => []),
        getAttendance().catch(() => []),
        getManagedStudents().catch(() => []),
      ])

      const found = allBuses.find((b) => b.bus_id === assignedBusId) || allBuses[0]
      if (found) setBusDetails(found)

      // Filter attendance for this bus
      const forBus = allAttendance.filter((a) => a.bus_id === assignedBusId)
      setAttendanceList(forBus)

      // Filter students assigned to this bus
      const myStudents = allStudents.filter((s) => s.assigned_bus === assignedBusId)
      setAssignedStudents(myStudents)
    } catch (err) {
      console.error("Failed to load driver data:", err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadBusData()
  }, [assignedBusId])

  // Handle Non-QR Attendance Submission
  const handleRecordAttendance = async (studentIdToUse?: string, actionOverride?: "BOARDED" | "EXITED" | "DENIED") => {
    const targetId = (studentIdToUse || studentIdInput).trim()
    if (!targetId) {
      alert("Please specify or select a Student ID.")
      return
    }

    setTerminalLoading(true)
    setTerminalResult(null)

    const selectedAction = actionOverride || (actionInput === "AUTO" ? undefined : actionInput)

    try {
      const res = await recordAttendanceEvent(
        targetId,
        assignedBusId,
        stopInput,
        selectedAction
      )

      setTerminalResult(res)

      // Refresh bus passengers and logs immediately
      await loadBusData()

      if (!studentIdToUse) {
        setStudentIdInput("")
      }
    } catch (err: any) {
      setTerminalResult({
        success: false,
        action: "DENIED",
        student_id: targetId,
        message: err?.message || "Failed to record entry event.",
      })
    } finally {
      setTerminalLoading(false)
    }
  }

  const currentPassengers = busDetails?.current_passengers ?? 0
  const capacity = busDetails?.capacity ?? 40
  const availableSeats = Math.max(0, capacity - currentPassengers)
  const occupancyPercent = capacity > 0 ? Math.round((currentPassengers / capacity) * 100) : 0

  return (
    <div className="space-y-6">
      {(activeTab === "face" || activeTab === "all") && (
        <DriverFaceRecognition
          busId={assignedBusId}
          currentStop={stopInput}
          currentPassengers={currentPassengers}
          capacity={capacity}
          onAttendanceUpdated={loadBusData}
        />
      )}
      {/* Driver Identity Banner */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="h-16 w-16 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
            <BusIcon className="h-8 w-8" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-2xl font-bold text-white">
                {user.name || "Transit Driver"}
              </h2>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                Driver Command
              </span>
            </div>
            <p className="text-sm text-zinc-400 mt-1">
              Username: <span className="font-mono text-zinc-200 font-semibold">{user.username}</span> • Assigned Fleet Unit:{" "}
              <span className="font-bold text-emerald-400 font-mono">{assignedBusId}</span>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            id="btn-nav-face-recognition"
            onClick={() => setActiveTab("face")}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-md shadow-emerald-950/50 transition"
          >
            <Eye className="h-4 w-4" />
            Face Recognition
          </button>
          <button
            onClick={loadBusData}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm font-medium border border-zinc-700 transition"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin text-amber-400" : ""}`} />
            Sync Fleet State
          </button>
        </div>
      </div>

      {/* Driver Dashboard Navigation Tab Bar */}
      <div className="flex flex-wrap items-center gap-2 p-1.5 rounded-2xl bg-zinc-900/80 border border-zinc-800">
        <button
          id="tab-face-recognition"
          onClick={() => setActiveTab("face")}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition ${
            activeTab === "face"
              ? "bg-emerald-600 text-white shadow-md shadow-emerald-950/40"
              : "text-zinc-400 hover:text-white hover:bg-zinc-800"
          }`}
        >
          <Eye className="h-4 w-4 text-emerald-400" />
          <span>Face Recognition</span>
          <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-emerald-500/20 text-emerald-300 font-mono">
            4-Face
          </span>
        </button>

        <button
          id="tab-cockpit"
          onClick={() => setActiveTab("cockpit")}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition ${
            activeTab === "cockpit"
              ? "bg-amber-600 text-white shadow-md shadow-amber-950/40"
              : "text-zinc-400 hover:text-white hover:bg-zinc-800"
          }`}
        >
          <BusIcon className="h-4 w-4 text-amber-400" />
          <span>Cockpit & Occupancy</span>
        </button>

        <button
          id="tab-gps"
          onClick={() => setActiveTab("gps")}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition ${
            activeTab === "gps"
              ? "bg-indigo-600 text-white shadow-md shadow-indigo-950/40"
              : "text-zinc-400 hover:text-white hover:bg-zinc-800"
          }`}
        >
          <Radio className="h-4 w-4 text-indigo-400" />
          <span>GPS Telemetry</span>
        </button>

        <button
          id="tab-manifest"
          onClick={() => setActiveTab("manifest")}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition ${
            activeTab === "manifest"
              ? "bg-sky-600 text-white shadow-md shadow-sky-950/40"
              : "text-zinc-400 hover:text-white hover:bg-zinc-800"
          }`}
        >
          <Users className="h-4 w-4 text-sky-400" />
          <span>Student Manifest</span>
        </button>

        <button
          id="tab-all-views"
          onClick={() => setActiveTab("all")}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold ml-auto transition ${
            activeTab === "all"
              ? "bg-zinc-800 text-zinc-100 border border-zinc-700"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
          }`}
        >
          <span>All Views</span>
        </button>
      </div>

      {/* GPS Broadcaster Component */}
      {(activeTab === "gps" || activeTab === "all") && (
        <div id="section-gps" className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5">
          <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
            <Radio className="h-5 w-5 text-emerald-400 animate-pulse" />
            Live GPS Telemetry Broadcaster
          </h3>
          <p className="text-xs text-zinc-400 mb-4">
            Broadcast high-accuracy GPS coordinates, speed, and heading to the transit operations center.
          </p>
          <DriverGPS busId={assignedBusId} />
        </div>
      )}

      {/* Assigned Students Roster & Attendance Logs */}
      {(activeTab === "manifest" || activeTab === "all") && (
        <>
          {/* Assigned Students Roster (Quick 1-Click Boarding) */}
          <div id="section-manifest" className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-bold text-white">
              Assigned Students Roster ({assignedStudents.length})
            </h3>
            <p className="text-xs text-zinc-400">
              Students registered for this vehicle. Use quick actions to record boarding.
            </p>
          </div>
        </div>

        {assignedStudents.length === 0 ? (
          <p className="text-sm text-zinc-500 text-center py-6">
            No students currently assigned to {assignedBusId}.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-400 uppercase tracking-wider border-b border-zinc-800 bg-zinc-950/50">
                <tr>
                  <th className="py-3 px-4">Student ID</th>
                  <th className="py-3 px-4">Name</th>
                  <th className="py-3 px-4">Dept</th>
                  <th className="py-3 px-4">Fee Clearance</th>
                  <th className="py-3 px-4">Transit Status</th>
                  <th className="py-3 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                {assignedStudents.map((st) => {
                  const isBoarded = st.is_boarded
                  const isFeePaid = st.fee_status === "PAID"

                  return (
                    <tr key={st.student_id} className="hover:bg-zinc-800/30 transition">
                      <td className="py-3 px-4 font-mono font-semibold text-white">
                        {st.student_id}
                      </td>
                      <td className="py-3 px-4">{st.name}</td>
                      <td className="py-3 px-4 text-xs text-zinc-400">{st.department || "Engineering"}</td>
                      <td className="py-3 px-4 text-xs">
                        <span
                          className={`px-2 py-0.5 rounded-full font-semibold ${
                            isFeePaid
                              ? "bg-emerald-500/20 text-emerald-400"
                              : "bg-rose-500/20 text-rose-400"
                          }`}
                        >
                          {st.fee_status || "PAID"}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                            isBoarded
                              ? "bg-emerald-500/20 text-emerald-400"
                              : "bg-zinc-800 text-zinc-400"
                          }`}
                        >
                          {isBoarded ? "ON BUS" : "OFF BUS"}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right space-x-2">
                        {!isBoarded ? (
                          <button
                            onClick={() => handleRecordAttendance(st.student_id, "BOARDED")}
                            disabled={terminalLoading}
                            className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white transition"
                          >
                            Board
                          </button>
                        ) : (
                          <button
                            onClick={() => handleRecordAttendance(st.student_id, "EXITED")}
                            disabled={terminalLoading}
                            className="px-3 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white transition"
                          >
                            Exit
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent Attendance Logs for this Bus */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
        <h3 className="text-lg font-bold text-white mb-1">
          Recent Entry & Exit Logs ({assignedBusId})
        </h3>
        <p className="text-xs text-zinc-400 mb-4">
          Audit trail of boarding, exit, and denied attempts for this vehicle.
        </p>

        {attendanceList.length === 0 ? (
          <p className="text-sm text-zinc-500 text-center py-6">
            No transit events recorded yet for this bus today.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-400 uppercase tracking-wider border-b border-zinc-800 bg-zinc-950/50">
                <tr>
                  <th className="py-3 px-4">Timestamp</th>
                  <th className="py-3 px-4">Student</th>
                  <th className="py-3 px-4">Stop</th>
                  <th className="py-3 px-4">Action</th>
                  <th className="py-3 px-4">Fee Clearance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                {attendanceList.slice(0, 10).map((log, idx) => (
                  <tr key={idx} className="hover:bg-zinc-800/30 transition">
                    <td className="py-3 px-4 font-mono text-xs">
                      {log.date} {log.time}
                    </td>
                    <td className="py-3 px-4 font-semibold text-white">
                      {log.name || log.student_id}
                    </td>
                    <td className="py-3 px-4 text-zinc-400">{log.stop || "Campus Terminal"}</td>
                    <td className="py-3 px-4">
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                          log.status === "BOARDED"
                            ? "bg-emerald-500/20 text-emerald-400"
                            : log.status === "DENIED"
                            ? "bg-rose-500/20 text-rose-400"
                            : "bg-blue-500/20 text-blue-400"
                        }`}
                      >
                        {log.status || "BOARDED"}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-xs font-mono">{log.fee_status || "PAID"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </>
      )}
    </div>
  )
}


