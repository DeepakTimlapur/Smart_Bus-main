"use client"

import { useState, useEffect, useRef } from "react"
import {
  Bus as BusIcon,
  MapPin,
  Clock,
  RefreshCw,
  Phone,
  CreditCard,
  User,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Radio,
  Navigation,
  Sparkles,
  Eye,
} from "lucide-react"
import { getMyBusLocation, getMyFee, getAttendance, type GPSLocation, type Attendance } from "@/lib/api"
import FaceRegistration from "./FaceRegistration"
import LiveMap, { type BusMapMarker } from "./LiveMap"
import { calculateDistanceMeters, formatDistance } from "@/lib/distance"

interface StudentDashboardProps {
  user: {
    username: string
    name?: string | null
    student_id?: string | null
    email?: string | null
    phone?: string | null
    department?: string | null
    assigned_bus?: string | null
    role: string
  }
}

export default function StudentDashboard({ user }: StudentDashboardProps) {
  const [gpsLocation, setGpsLocation] = useState<GPSLocation | null>(null)
  const [feeData, setFeeData] = useState<any>(null)
  const [attendanceLogs, setAttendanceLogs] = useState<Attendance[]>([])
  const [loadingLocation, setLoadingLocation] = useState(false)
  const [lastRefreshed, setLastRefreshed] = useState<string>("")
  const [studentCoords, setStudentCoords] = useState<{
    latitude: number
    longitude: number
  } | null>(null)
  const [locationError, setLocationError] = useState("")
  const [trackingLocation, setTrackingLocation] = useState(false)
  const watchId = useRef<number | null>(null)

  const studentId = user.student_id || user.username
  const assignedBus = user.assigned_bus || ""

  const loadData = async () => {
    setLoadingLocation(true)
    try {
      const [gpsRes, feeRes, attRes] = await Promise.all([
        getMyBusLocation().catch(() => null),
        getMyFee().catch(() => null),
        getAttendance().catch(() => []),
      ])

      if (gpsRes) setGpsLocation(gpsRes)
      if (feeRes) setFeeData(feeRes)
      if (attRes) {
        // Filter attendance strictly for this student
        const myLogs = attRes.filter(
          (a) => a.student_id === studentId || a.student_id === user.username
        )
        setAttendanceLogs(myLogs)
      }
      setLastRefreshed(new Date().toLocaleTimeString())
    } catch (err) {
      console.error("Error loading student telemetry:", err)
    } finally {
      setLoadingLocation(false)
    }
  }

  useEffect(() => {
    loadData()
    // Poll GPS location every 8 seconds
    const interval = setInterval(() => {
      getMyBusLocation()
        .then((loc) => {
          if (loc) setGpsLocation(loc)
        })
        .catch(() => {})
    }, 8000)
    return () => clearInterval(interval)
  }, [studentId])

  const startStudentLocationTracking = () => {
    if (!("geolocation" in navigator)) {
      setLocationError("Your browser does not support location services.")
      return
    }

    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current)
    }

    setLocationError("")
    setTrackingLocation(true)

    watchId.current = navigator.geolocation.watchPosition(
      (position) => {
        setStudentCoords({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        })
        setLocationError("")
      },
      (error) => {
        setTrackingLocation(false)
        setLocationError(
          error.code === error.PERMISSION_DENIED
            ? "Location permission denied. Allow location access in your browser."
            : error.code === error.POSITION_UNAVAILABLE
            ? "Your current location is unavailable."
            : "Location request timed out. Please try again."
        )
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    )
  }

  useEffect(() => {
    return () => {
      if (watchId.current !== null && "geolocation" in navigator) {
        navigator.geolocation.clearWatch(watchId.current)
      }
    }
  }, [])

  const busCoordinatesAvailable =
    gpsLocation?.success !== false &&
    typeof gpsLocation?.latitude === "number" &&
    typeof gpsLocation?.longitude === "number" &&
    Number.isFinite(gpsLocation.latitude) &&
    Number.isFinite(gpsLocation.longitude) &&
    Math.abs(gpsLocation.latitude) <= 90 &&
    Math.abs(gpsLocation.longitude) <= 180

  const distanceLabel =
    studentCoords && busCoordinatesAvailable
      ? formatDistance(
          calculateDistanceMeters(
            studentCoords,
            {
              latitude: gpsLocation.latitude!,
              longitude: gpsLocation.longitude!,
            }
          )
        )
      : "Distance unavailable"

  const feeStatus = feeData?.status || "UNKNOWN"
  const isPaid = feeStatus === "PAID"
  const isPartial = feeStatus === "PARTIAL"

  return (
    <div className="space-y-6">
      {/* Student Profile & Pass Header */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 backdrop-blur-md p-6 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="h-16 w-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <User className="h-8 w-8" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-2xl font-bold text-white">
                  {user.name || "Student"}
                </h2>
                <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  Verified Student
                </span>
              </div>
              <p className="text-sm text-zinc-400 mt-1">
                Student ID: <span className="font-mono text-zinc-200 font-semibold">{studentId}</span>
                {user.department && ` â€¢ Dept: ${user.department}`}
              </p>
              <div className="flex items-center gap-4 mt-2 text-xs text-zinc-400">
                <span>{user.email}</span>
                {user.phone && <span>{user.phone}</span>}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <a
              id="link-student-face-registration"
              href="#student-face-registration-module"
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-md shadow-indigo-950/50 transition"
            >
              <Eye className="h-3.5 w-3.5" />
              <span>Face Biometrics</span>
            </a>
            <button
              onClick={loadData}
              disabled={loadingLocation}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm font-medium border border-zinc-700 transition"
            >
              <RefreshCw className={`h-4 w-4 ${loadingLocation ? "animate-spin text-emerald-400" : ""}`} />
              Sync Live Telemetry
            </button>
          </div>
        </div>
      </div>

      {/* Biometric Face Registration Module */}
      <FaceRegistration
        studentId={studentId}
        studentName={user.name || undefined}
        department={user.department || undefined}
        assignedBus={assignedBus}
        onStatusChanged={loadData}
      />

      {/* Grid: 1. Live Bus Tracker, 2. Digital Transport Pass & Fees */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Live GPS Telemetry Card */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Radio className="h-5 w-5 text-emerald-400 animate-pulse" />
                <h3 className="text-lg font-bold text-white">Assigned Bus & Live GPS</h3>
              </div>
              <span className="px-3 py-1 rounded-full text-xs font-mono font-semibold bg-zinc-800 text-zinc-300 border border-zinc-700">
                {assignedBus}
              </span>
            </div>

            <p className="text-xs text-zinc-400 mt-1">
              Real-time telemetry stream from vehicle onboard transponder
            </p>

            {/* Telemetry Display */}
            <div className="mt-5 grid grid-cols-2 gap-3">
              <div className="p-4 rounded-xl bg-zinc-950/60 border border-zinc-800/80">
                <span className="text-xs text-zinc-500 font-medium block">Current Vicinity</span>
                <span className="text-sm font-semibold text-zinc-200 mt-1 flex items-center gap-1.5 truncate">
                  <MapPin className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  {gpsLocation?.area || gpsLocation?.city || "GPS unavailable"}
                </span>
                <span className="text-xs text-zinc-400 block truncate mt-0.5">
                  {gpsLocation?.state ? `${gpsLocation.state}, India` : "Location unavailable"}
                </span>
              </div>

              <div className="p-4 rounded-xl bg-zinc-950/60 border border-zinc-800/80">
                <span className="text-xs text-zinc-500 font-medium block">Vehicle Speed</span>
                <span className="text-xl font-bold font-mono text-emerald-400 mt-1 block">
                  {gpsLocation?.speed !== null && gpsLocation?.speed !== undefined ? `${Math.round(Number(gpsLocation.speed))} km/h` : "Speed unavailable"}
                </span>
                <span className="text-xs text-zinc-500">Live Telemetry</span>
              </div>
            </div>

            {/* Distance from student to the assigned bus */}
            <div className="mt-3 p-4 rounded-xl bg-zinc-950/60 border border-zinc-800">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-xs text-zinc-500 block">
                    Distance to {assignedBus}
                  </span>
                  <span className="text-lg font-bold text-emerald-400 mt-1 block">
                    {distanceLabel}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={startStudentLocationTracking}
                  className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold"
                >
                  {trackingLocation ? "Refresh Location Tracking" : "Track My Location"}
                </button>
              </div>
              <p className="text-xs text-zinc-500 mt-2">
                Straight-line GPS distance, not road travel distance.
              </p>
              {locationError && (
                <p role="alert" className="text-xs text-amber-400 mt-2">
                  {locationError}
                </p>
              )}
              {!studentCoords && !locationError && (
                <p className="text-xs text-zinc-400 mt-2">
                  Allow location access to calculate your distance to the bus.
                </p>
              )}
              {studentCoords && !busCoordinatesAvailable && (
                <p className="text-xs text-amber-400 mt-2">
                  Waiting for valid live bus GPS coordinates.
                </p>
              )}
            </div>

            {/* Geographic Coordinates */}
            <div className="mt-3 p-3 rounded-xl bg-zinc-950/40 border border-zinc-800/50 flex items-center justify-between text-xs font-mono text-zinc-400">
              <div className="flex items-center gap-1.5">
                <Navigation className="h-3.5 w-3.5 text-zinc-500" />
                <span>Lat: {typeof gpsLocation?.latitude === "number" ? gpsLocation.latitude.toFixed(4) : "Unavailable"}Â°</span>
                <span className="text-zinc-600">â€¢</span>
                <span>Lng: {typeof gpsLocation?.longitude === "number" ? gpsLocation.longitude.toFixed(4) : "Unavailable"}Â°</span>
              </div>
              <span className="text-zinc-500 text-[11px]">
                {lastRefreshed ? `Pings active (${lastRefreshed})` : "Active stream"}
              </span>
            </div>

            {/* Render the map only when valid GPS coordinates are available */}
            {assignedBus && busCoordinatesAvailable ? (
              <div className="mt-4 rounded-xl overflow-hidden border border-zinc-800">
                <LiveMap
                  buses={[
                    {
                      bus_id: assignedBus,
                      bus_name: `${assignedBus} (My Bus)`,
                      route: "Route unavailable",
                      driver_name: "Unavailable",
                      status: (gpsLocation?.speed && gpsLocation.speed > 0 ? "IN_TRANSIT" : "ACTIVE") as any,
                      latitude: gpsLocation!.latitude!,
                      longitude: gpsLocation!.longitude!,
                      speed: gpsLocation?.speed != null ? Number(gpsLocation.speed) : 0,
                      heading: gpsLocation?.heading != null ? Number(gpsLocation.heading) : 0,
                      address: [gpsLocation?.area, gpsLocation?.city].filter(Boolean).join(", ") || "GPS unavailable",
                      last_updated: lastRefreshed || "Telemetry timestamp unavailable",
                    },
                  ]}
                  selectedBusId={assignedBus}
                  height="240px"
                  centerOnBus={true}
                />
              </div>
            ) : (
              <div role="status" className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/40 p-6 text-sm text-zinc-400">
                {!assignedBus
                  ? "No bus is assigned to this account."
                  : "Live bus GPS coordinates are unavailable. The map will appear when valid coordinates are received."}
              </div>
            )}
          </div>

          {/* Assigned Driver & Route Details */}
          <div className="mt-6 pt-5 border-t border-zinc-800/80">
            <span className="text-xs text-zinc-500 block">Designated Driver</span>
            <span className="text-sm font-semibold text-zinc-200">
              Driver details unavailable
            </span>
          </div>
        </div>

        {/* Digital Transit Pass & Fee Card */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <CreditCard className="h-5 w-5 text-indigo-400" />
                <h3 className="text-lg font-bold text-white">Digital Transport Pass</h3>
              </div>
              <span
                className={`px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider ${
                  isPaid
                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                    : isPartial
                    ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                    : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                }`}
              >
                {feeStatus}
              </span>
            </div>

            <p className="text-xs text-zinc-400 mt-1">
              Institutional bus boarding authorization and fee clearance status
            </p>

            {/* Fee Breakdown Cards */}
            <div className="mt-5 grid grid-cols-3 gap-3 text-center">
              <div className="p-3.5 rounded-xl bg-zinc-950/60 border border-zinc-800">
                <span className="text-xs text-zinc-500 block">Total Dues</span>
                <span className="text-base font-bold text-zinc-200 mt-1 block">
                  ₹{feeData?.total_fee != null ? Number(feeData.total_fee).toLocaleString("en-IN") : "—"}
                </span>
              </div>
              <div className="p-3.5 rounded-xl bg-zinc-950/60 border border-zinc-800">
                <span className="text-xs text-zinc-500 block">Paid Amount</span>
                <span className="text-base font-bold text-emerald-400 mt-1 block">
                  ₹{feeData?.paid_amount != null ? Number(feeData.paid_amount).toLocaleString("en-IN") : "—"}
                </span>
              </div>
              <div className="p-3.5 rounded-xl bg-zinc-950/60 border border-zinc-800">
                <span className="text-xs text-zinc-500 block">Pending Dues</span>
                <span className={`text-base font-bold mt-1 block ${feeData?.pending_amount > 0 ? "text-rose-400" : "text-zinc-400"}`}>
                  ₹{feeData?.total_fee != null && feeData?.paid_amount != null ? Math.max(0, Number(feeData.total_fee) - Number(feeData.paid_amount)).toLocaleString("en-IN") : "—"}
                </span>
              </div>
            </div>

            {/* Pass Validity Notice */}
            <div className="mt-4 p-4 rounded-xl bg-zinc-950/60 border border-zinc-800 flex items-center justify-between">
              <div>
                <span className="text-xs text-zinc-500 block">Pass Expiry / Validity</span>
                <span className="text-sm font-semibold text-zinc-200 mt-0.5 block">
                  {feeData?.valid_until || "Unavailable"}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
                <CheckCircle2 className="h-4 w-4" />
                Valid for Boarding
              </div>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-zinc-800/80 text-xs text-zinc-500 flex items-center justify-between">
            <span>Academic Year: {feeData?.academic_year || "2026-27"}</span>
            <span>Non-QR Terminal Boarding</span>
          </div>
        </div>
      </div>

      {/* Personal Transit & Attendance History */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              <Clock className="h-5 w-5 text-emerald-400" />
              My Boarding & Attendance History
            </h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              Verified boarding and exit events recorded at transit terminals
            </p>
          </div>
          <span className="text-xs text-zinc-500 font-mono">
            {attendanceLogs.length} Records
          </span>
        </div>

        {attendanceLogs.length === 0 ? (
          <div className="p-8 text-center rounded-xl bg-zinc-950/40 border border-zinc-800/60">
            <BusIcon className="h-8 w-8 text-zinc-600 mx-auto mb-2" />
            <p className="text-sm text-zinc-400 font-medium">No recent boarding logs found for your student profile.</p>
            <p className="text-xs text-zinc-500 mt-1">
              Events will be recorded automatically when you board your bus at campus or stop terminals.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-400 uppercase tracking-wider border-b border-zinc-800 bg-zinc-950/50">
                <tr>
                  <th className="py-3 px-4">Event Date & Time</th>
                  <th className="py-3 px-4">Bus ID</th>
                  <th className="py-3 px-4">Stop / Terminal</th>
                  <th className="py-3 px-4">Status / Action</th>
                  <th className="py-3 px-4">Fee Clearance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                {attendanceLogs.map((log, idx) => {
                  const action = log.status || "BOARDED"
                  const isBoarded = action === "BOARDED"
                  const isDenied = action === "DENIED"

                  return (
                    <tr key={idx} className="hover:bg-zinc-800/30 transition">
                      <td className="py-3 px-4 font-mono text-xs">
                        {log.date} {log.time && `â€¢ ${log.time}`}
                      </td>
                      <td className="py-3 px-4 font-semibold text-white">
                        {log.bus_id || assignedBus}
                      </td>
                      <td className="py-3 px-4 text-zinc-400">
                        {log.stop || "Campus Terminal"}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                            isBoarded
                              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                              : isDenied
                              ? "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                              : "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                          }`}
                        >
                          {isBoarded ? (
                            <CheckCircle2 className="h-3 w-3" />
                          ) : isDenied ? (
                            <XCircle className="h-3 w-3" />
                          ) : (
                            <Clock className="h-3 w-3" />
                          )}
                          {action}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-xs font-mono">
                        <span className="text-emerald-400">{log.fee_status || "PAID"}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}






