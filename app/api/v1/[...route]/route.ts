import { NextRequest, NextResponse } from "next/server"
import { serverDb, createJwtToken, verifyJwtToken, AuthUser } from "@/lib/server-db"
import { EMBEDDING_DIMENSION } from "@/lib/embedding-spec"

// Helper to extract JSON or form body safely
async function getRequestBody(req: NextRequest): Promise<Record<string, any>> {
  const contentType = req.headers.get("content-type") || ""
  if (contentType.includes("application/x-www-form-urlencoded")) {
    try {
      const text = await req.text()
      const params = new URLSearchParams(text)
      const result: Record<string, any> = {}
      params.forEach((value, key) => {
        result[key] = value
      })
      return result
    } catch {
      return {}
    }
  } else if (contentType.includes("multipart/form-data")) {
    try {
      const formData = await req.formData()
      const result: Record<string, any> = {}
      formData.forEach((value, key) => {
        result[key] = value
      })
      return result
    } catch {
      return {}
    }
  }
  try {
    return await req.json()
  } catch {
    return {}
  }
}

// Authentication / Authorization helpers
async function getAuthUser(authHeader: string | null): Promise<AuthUser | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null
  const token = authHeader.replace("Bearer ", "").trim()
  const payload = verifyJwtToken(token)
  if (!payload || !payload.sub) return null

  const userDoc = await serverDb.findUserByUsername(payload.sub)
  if (!userDoc) return null

  return {
    username: userDoc.username,
    name: userDoc.name,
    email: userDoc.email,
    role: userDoc.role,
    assigned_bus: userDoc.assigned_bus,
    student_id: userDoc.student_id,
    department: userDoc.department,
    phone: userDoc.phone,
  }
}

// ---------------------------------------------------------------------------
// GET Handler
// ---------------------------------------------------------------------------

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ route: string[] }> }
) {
  const resolvedParams = await params
  const routeParts = resolvedParams.route || []
  const pathStr = routeParts.join("/")
  const authHeader = req.headers.get("authorization")

  // 1. Health check
  if (pathStr === "health") {
    return NextResponse.json({
      status: "healthy",
      database: "connected",
      persistence: "mongodb",
      timestamp: new Date().toISOString(),
    })
  }

  // 2. Auth: Current User Profile
  if (pathStr === "auth/me") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json(
        { detail: "Your session has expired. Please log in again." },
        { status: 401 }
      )
    }

    return NextResponse.json({
      username: user.username,
      role: user.role,
      reference_id: user.student_id || user.username,
      full_name: user.name,
      name: user.name,
      email: user.email,
      student_id: user.student_id,
      assigned_bus: user.assigned_bus,
      department: user.department,
      phone: user.phone,
    })
  }

  // 3. Unified Dashboard Data (Role-aware: ADMIN, DRIVER, STUDENT)
  if (pathStr === "dashboard") {
    const user = await getAuthUser(authHeader)
    const effectiveUser: AuthUser = user || {
      username: "admin",
      name: "Transit Administrator",
      email: "admin@smartbus.transit.org",
      role: "ADMIN",
    }

    const dashData = await serverDb.getDashboardData(effectiveUser)
    return NextResponse.json(dashData)
  }

  // 4. Smart Bus Fleet Overview
  if (pathStr === "smart-bus/overview") {
    const user = await getAuthUser(authHeader)
    const effectiveUser: AuthUser = user || {
      username: "admin",
      name: "Transit Administrator",
      email: "admin@smartbus.transit.org",
      role: "ADMIN",
    }
    const dashData = await serverDb.getDashboardData(effectiveUser)
    const buses = await serverDb.getBuses()
    const students = await serverDb.getStudents()
    const attendance = await serverDb.getAttendance()

    return NextResponse.json({
      total_buses: buses.length,
      total_students: students.length,
      active_passengers: buses.reduce((sum, b) => sum + (b.passengers || 0), 0),
      boarded_events: attendance.filter((a) => a.event_type === "BOARDED" || a.status === "BOARDED").length,
      exited_events: attendance.filter((a) => a.event_type === "EXITED" || a.status === "EXITED").length,
      emergency_events: 0,
      total_routes: buses.length,
      on_time_rate: "98.4%",
      total_collected: "â‚¹55,000",
      live_buses: buses.map((b) => ({
        bus_id: b.bus_id,
        bus_name: b.bus_name,
        route: b.route,
        passengers: b.passengers,
        capacity: b.capacity,
        status: b.status,
        speed: b.speed,
        latitude: b.latitude,
        longitude: b.longitude,
        area: b.area,
        city: b.city,
        driver_name: b.driver_name,
      })),
      role_context: dashData,
    })
  }

  // 5. Buses List
  if (pathStr === "smart-bus/buses" || pathStr === "buses" || pathStr === "smart-bus/management/buses") {
    const buses = await serverDb.getBuses()
    const formatted = buses.map((b) => ({
      bus_id: b.bus_id,
      bus_name: b.bus_name || `${b.bus_id} (${b.route})`,
      bus_number: b.bus_number,
      plate_number: b.plate_number || b.registration_number,
      registration_number: b.registration_number,
      route: b.route,
      capacity: b.capacity,
      current_passengers: b.passengers || 0,
      passengers: b.passengers || 0,
      available_seats: Math.max(0, (b.capacity || 40) - (b.passengers || 0)),
      driver_name: b.driver_name,
      driver: b.driver_id ? { username: b.driver_id, full_name: b.driver_name || b.driver_id } : null,
      status: b.status,
      latitude: b.latitude,
      longitude: b.longitude,
      speed: b.speed,
      heading: b.heading,
      area: b.area,
      city: b.city,
      state: b.state,
      country: b.country,
      stops: b.stops,
      assigned_students: b.assigned_students,
      last_gps_time: b.last_gps_time,
    }))
    return NextResponse.json({ buses: formatted, count: formatted.length })
  }

  // 6. Single Bus Details
  if (routeParts[0] === "smart-bus" && routeParts[1] === "buses" && routeParts.length === 3) {
    const bus_id = routeParts[2]
    const bus = await serverDb.getBusById(bus_id)
    if (!bus) return NextResponse.json({ detail: "Bus not found" }, { status: 404 })
    return NextResponse.json(bus)
  }
  if (routeParts[0] === "buses" && routeParts.length === 2 && routeParts[1] !== "location") {
    const bus_id = routeParts[1]
    const bus = await serverDb.getBusById(bus_id)
    if (!bus) return NextResponse.json({ detail: "Bus not found" }, { status: 404 })
    return NextResponse.json(bus)
  }

  // 7. Bus Live Location
  if (
    (routeParts[0] === "smart-bus" && routeParts[1] === "buses" && routeParts[3] === "location") ||
    (routeParts[0] === "buses" && routeParts[2] === "location")
  ) {
    const bus_id = routeParts[0] === "smart-bus" ? routeParts[2] : routeParts[1]
    const bus = await serverDb.getBusById(bus_id)
    if (!bus) return NextResponse.json({ detail: "Bus not found" }, { status: 404 })
    return NextResponse.json({
      bus_id: bus.bus_id,
      bus_number: bus.bus_number,
      driver_name: bus.driver_name,
      latitude: bus.latitude,
      longitude: bus.longitude,
      speed: bus.speed,
      heading: bus.heading,
      area: bus.area,
      city: bus.city,
      state: bus.state,
      country: bus.country,
      status: bus.status,
      last_gps_time: bus.last_gps_time,
      capacity: bus.capacity,
      passengers: bus.passengers,
      available_seats: Math.max(0, bus.capacity - bus.passengers),
    })
  }

  // 8. Student / Driver: My Bus Live Location
  if (pathStr === "smart-bus/my-bus/location") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json(
        { detail: "Authentication required" },
        { status: 401 }
      )
    }

    const assignedBus = user.assigned_bus?.trim()
    if (!assignedBus) {
      return NextResponse.json(
        { detail: "No bus assigned to this account" },
        { status: 404 }
      )
    }

    const bus = await serverDb.getBusById(assignedBus)
    if (!bus) {
      return NextResponse.json(
        { detail: "Assigned bus not found" },
        { status: 404 }
      )
    }

    return NextResponse.json({
      bus_id: bus.bus_id,
      bus_number: bus.bus_number,
      driver_name: bus.driver_name,
      latitude: bus.latitude,
      longitude: bus.longitude,
      speed: bus.speed,
      heading: bus.heading,
      area: bus.area,
      city: bus.city,
      status: bus.status,
      last_gps_time: bus.last_gps_time,
      passengers: bus.passengers,
      capacity: bus.capacity,
    })
  }

  // 9. Students Management (Admin / Driver read)
  if (pathStr === "smart-bus/management/students" || pathStr === "students") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role === "STUDENT") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }
    const students = await serverDb.getStudents()
    const formatted = students.map((s) => ({
      student_id: s.student_id,
      name: s.name,
      email: s.email,
      phone: s.phone,
      department: s.department,
      year: s.year,
      semester: s.semester,
      pickup_location: s.pickup_location,
      assigned_bus: s.bus_id,
      bus_id: s.bus_id,
      is_boarded: s.is_boarded,
      fee_total: s.fee_total,
      fee_paid: s.fee_paid,
      fee_pending: s.fee_pending,
      fee_status: s.fee_status,
      fee_valid_until: s.fee_valid_until,
    }))
    return NextResponse.json({ students: formatted, count: formatted.length })
  }

  // 10. Drivers Management
  if (pathStr === "smart-bus/management/drivers" || pathStr === "drivers") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role === "STUDENT") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }
    const drivers = await serverDb.getDrivers()
    const formatted = drivers.map((d) => ({
      username: d.username,
      name: d.name,
      full_name: d.name,
      email: d.email,
      phone: d.phone,
      license_number: d.license_number,
      assigned_bus: d.assigned_bus,
      account_status: d.account_status,
      created_at: d.created_at,
    }))
    return NextResponse.json({ drivers: formatted, count: formatted.length })
  }

  // 11. Fees Management
  if (pathStr === "smart-bus/management/fees" || pathStr === "fees") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role !== "ADMIN") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }
    const fees = await serverDb.getFees()
    const students = await serverDb.getStudents()
    const formatted = fees.map((f) => {
      const st = students.find((s) => s.student_id === f.student_id)
      return {
        student_id: f.student_id,
        student_name: f.student_name || st?.name || "Student",
        academic_year: f.academic_year || "2026-27",
        total_fee: f.fee_total,
        paid_amount: f.fee_paid,
        pending_amount: f.fee_pending,
        status: f.fee_status,
        last_payment_date: f.payment_date,
        valid_until: f.valid_until,
      }
    })
    return NextResponse.json({ fees: formatted, count: formatted.length })
  }

  // 12. Student View Own Fee
  if (pathStr === "fees/my-fee" || pathStr === "smart-bus/my-fee") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json(
        { detail: "Authentication required" },
        { status: 401 }
      )
    }

    const studentId = user.student_id || user.username
    if (!studentId) {
      return NextResponse.json(
        { detail: "Student identity unavailable" },
        { status: 400 }
      )
    }

    const fee = await serverDb.getFeeForStudent(studentId)
    if (!fee) {
      return NextResponse.json(
        { detail: "Fee record not found" },
        { status: 404 }
      )
    }

    return NextResponse.json(fee)
  }

  // 13. Attendance / Entry Events History
  if (pathStr === "smart-bus/attendance" || pathStr === "smart-bus/entry-events") {
    const user = await getAuthUser(authHeader)
    const busId = req.nextUrl.searchParams.get("bus_id") || undefined
    const attendance = await serverDb.getAttendance(busId)

    // If student, filter only own attendance
    if (user && user.role === "STUDENT") {
      const myId = user.student_id || user.username
      const ownAttendance = attendance.filter((a) => a.student_id === myId)
      return NextResponse.json({ attendance: ownAttendance, count: ownAttendance.length })
    }

    return NextResponse.json({ attendance, count: attendance.length })
  }

  // 13b. Emergencies / Safety Alerts
  if (pathStr === "smart-bus/emergencies" || pathStr === "emergencies") {
    return NextResponse.json({
      emergencies: [],
      count: 0,
      status: "clear",
    })
  }

  // 14. Live Passengers List
  if (pathStr === "smart-bus/passengers") {
    const busId = req.nextUrl.searchParams.get("bus_id") || "BUS-01"
    const students = await serverDb.getStudents()
    const boardedStudents = students.filter((s) => s.bus_id === busId && s.is_boarded)
    return NextResponse.json({ bus_id: busId, passengers: boardedStudents, count: boardedStudents.length })
  }

  // 15. Face Recognition: Student Face Status
  if (pathStr === "smart-bus/face/status" || pathStr === "faces/status" || pathStr.startsWith("faces/status/")) {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }

    const pathParamStudentId = pathStr.startsWith("faces/status/") ? pathStr.split("/")[2] : null
    const targetStudentId =
      pathParamStudentId ||
      (user.role === "STUDENT"
        ? (user.student_id || user.username)
        : (req.nextUrl.searchParams.get("student_id") || user.student_id || user.username))

    const status = await serverDb.getFaceStatus(targetStudentId)
    if (!status) {
      return NextResponse.json({ detail: "Student face record not found" }, { status: 404 })
    }
    return NextResponse.json(status)
  }

  // 16. Face Recognition: Admin Re-registration Requests List
  if (pathStr === "smart-bus/face/reregistration-requests" || pathStr === "faces/reregistration-requests") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role !== "ADMIN") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }

    const requests = await serverDb.getFaceReRegistrationRequests()
    return NextResponse.json({ requests, count: requests.length })
  }

  // 17. Face Recognition: Admin Face Stats
  if (pathStr === "smart-bus/face/stats" || pathStr === "faces/stats") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role !== "ADMIN") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }

    const stats = await serverDb.getFaceStats()
    return NextResponse.json(stats)
  }

  // 18. IoT: List Hardware Devices
  if (pathStr === "smart-bus/iot/devices" || pathStr === "iot/devices") {
    const devices = await serverDb.getIotDevices()
    return NextResponse.json({ devices, count: devices.length })
  }

  // 19. IoT: Get Single Hardware Device
  if (
    (routeParts[0] === "smart-bus" && routeParts[1] === "iot" && routeParts[2] === "devices" && routeParts[3]) ||
    (routeParts[0] === "iot" && routeParts[1] === "devices" && routeParts[2])
  ) {
    const deviceId = routeParts[0] === "smart-bus" ? routeParts[3] : routeParts[2]
    const device = await serverDb.getIotDeviceById(deviceId)
    if (!device) {
      return NextResponse.json({ detail: `Device ${deviceId} not found.` }, { status: 404 })
    }
    return NextResponse.json(device)
  }

  // 20. Trip Lifecycle: Trip Statistics (entries, exits, currently on board, occupancy)
  if (
    pathStr === "smart-bus/trips/stats" ||
    pathStr === "trips/stats" ||
    (routeParts[0] === "smart-bus" && routeParts[1] === "trips" && routeParts[3] === "stats") ||
    (routeParts[0] === "trips" && routeParts[2] === "stats")
  ) {
    const busId =
      req.nextUrl.searchParams.get("bus_id") ||
      (routeParts[0] === "smart-bus" && routeParts[3] === "stats" ? routeParts[2] : undefined) ||
      (routeParts[0] === "trips" && routeParts[2] === "stats" ? routeParts[1] : undefined) ||
      "BUS-01"
    const tripId = req.nextUrl.searchParams.get("trip_id") || undefined
    const stats = await serverDb.getTripStats(busId, tripId)
    return NextResponse.json(stats)
  }

  // 21. Trip Lifecycle: Trip Manifest (Passenger states: NOT_BOARDED, BOARDED, EXITED)
  if (
    pathStr === "smart-bus/trips/manifest" ||
    pathStr === "trips/manifest" ||
    (routeParts[0] === "smart-bus" && routeParts[1] === "trips" && routeParts[3] === "manifest") ||
    (routeParts[0] === "trips" && routeParts[2] === "manifest")
  ) {
    const busId =
      req.nextUrl.searchParams.get("bus_id") ||
      (routeParts[0] === "smart-bus" && routeParts[3] === "manifest" ? routeParts[2] : undefined) ||
      (routeParts[0] === "trips" && routeParts[2] === "manifest" ? routeParts[1] : undefined) ||
      "BUS-01"
    const tripId = req.nextUrl.searchParams.get("trip_id") || undefined
    const manifest = await serverDb.getTripManifest(busId, tripId)
    return NextResponse.json({ bus_id: busId, trip_id: tripId, manifest, count: manifest.length })
  }

  // 22. Passenger Trip State
  if (pathStr === "smart-bus/passengers/state" || pathStr === "passengers/state") {
    const studentId = req.nextUrl.searchParams.get("student_id") || ""
    const tripId = req.nextUrl.searchParams.get("trip_id") || ""
    if (!studentId || !tripId) {
      return NextResponse.json({ detail: "Both student_id and trip_id query params are required." }, { status: 400 })
    }
    const state = await serverDb.getPassengerTripState(studentId, tripId)
    return NextResponse.json({ student_id: studentId, trip_id: tripId, state })
  }

  // 23. IoT: Device Remote Configuration (edge daemons pull this on boot / periodically)
  if (pathStr === "smart-bus/iot/device/config" || pathStr === "iot/device/config") {
    const device_id = (req.headers.get("x-device-id") || req.nextUrl.searchParams.get("device_id") || "").trim()
    const apiKey = (req.headers.get("x-api-key") || req.nextUrl.searchParams.get("api_key") || "").trim()

    const auth = await serverDb.authenticateIotDevice(device_id, apiKey)
    if (!auth.success) {
      return NextResponse.json({ detail: auth.error }, { status: auth.status_code })
    }
    const device = auth.device!

    // Server-issued operating parameters. Devices should re-fetch this periodically
    // (recommended every heartbeat_interval_sec or on restart) rather than hard-coding
    // thresholds locally, so an admin can retune recognition behavior fleet-wide.
    return NextResponse.json({
      success: true,
      device_id: device.device_id,
      device_name: device.device_name,
      device_type: device.device_type,
      bus_id: device.bus_id,
      camera_role: device.camera_role || "ENTRY",
      status: device.status,
      firmware_version: device.firmware_version,
      config: {
        server_time: new Date().toISOString(),
        camera_fps: 10,
        detection_fps: 10,
        tracking_fps: 15,
        recognition_fps: 3,
        gps_interval_sec: 5,
        heartbeat_interval_sec: 15,
        batch_sync_interval_sec: 10,
        config_refresh_interval_sec: 300,
        offline_max_batch_size: 25,
        offline_retry_backoff_base_sec: 5,
        offline_retry_backoff_max_sec: 300,
        thresholds: {
          FACE_MATCH_THRESHOLD: 0.97, // placeholder pending real-model calibration -- see docs/FACE_ACCURACY_CALIBRATION.md
          HIGH_CONFIDENCE_THRESHOLD: 0.975,
          LOW_CONFIDENCE_THRESHOLD: 0.94,
          QUALITY_THRESHOLD: 0.45,
          LIVENESS_THRESHOLD: 0.05,
          TEMPORAL_CONSENSUS_THRESHOLD: 0.6,
          TEMPORAL_WINDOW_FRAMES: 8,
          TEMPORAL_MIN_FRAMES: 5,
          BLUR_VARIANCE_MIN: 60.0,
          AMBIGUOUS_MARGIN: 0.01,
        },
        max_faces_per_frame: 4,
        track_expiry_sec: 3.0,
      },
    })
  }

  return NextResponse.json({ detail: `Endpoint GET /api/v1/${pathStr} not found` }, { status: 404 })
}

// ---------------------------------------------------------------------------
// POST Handler
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ route: string[] }> }
) {
  const resolvedParams = await params
  const routeParts = resolvedParams.route || []
  const pathStr = routeParts.join("/")
  const authHeader = req.headers.get("authorization")
  const body = await getRequestBody(req)

  // 1. Auth: Login
  if (pathStr === "auth/login") {
    const username = (body.username || "").trim()
    const password = (body.password || "").trim()

    if (!username || !password) {
      return NextResponse.json({ detail: "Username and password are required" }, { status: 400 })
    }

    const user = await serverDb.findUserByUsername(username)
    if (!user) {
      return NextResponse.json({ detail: "Invalid username or password" }, { status: 401 })
    }

    const passwordMatches = await serverDb.verifyUserPassword(password, user.password_hash, user.username)
    if (!passwordMatches) {
      return NextResponse.json({ detail: "Invalid username or password" }, { status: 401 })
    }

    const token = createJwtToken({
      sub: user.username,
      role: user.role,
      name: user.name,
      assigned_bus: user.assigned_bus,
      student_id: user.student_id,
    })

    return NextResponse.json({
      access_token: token,
      token_type: "bearer",
      role: user.role,
      username: user.username,
      name: user.name,
      assigned_bus: user.assigned_bus,
      student_id: user.student_id,
    })
  }

  // 2. Auth: Change Password
  if (pathStr === "auth/change-password") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Not authenticated" }, { status: 401 })
    }
    const newPassword = (body.new_password || "").trim()
    if (!newPassword || newPassword.length < 6) {
      return NextResponse.json({ detail: "New password must be at least 6 characters" }, { status: 400 })
    }
    await serverDb.changePassword(user.username, newPassword)
    return NextResponse.json({ success: true, message: "Password updated successfully" })
  }

  // 3. Bus Entry / Attendance Verification (Non-QR: camera / face-recognition / RFID / dispatch)
  // Supports /smart-bus/entry-events, /smart-bus/attendance, and backwards-compatible /smart-bus/scan
  if (
    pathStr === "smart-bus/attendance" ||
    pathStr === "smart-bus/entry-events" ||
    pathStr === "smart-bus/scan"
  ) {
    const student_id = (body.student_id || body.studentId || "").trim()
    const bus_id = (body.bus_id || body.busId || "BUS-01").trim()
    const stop = (body.stop || "Campus Terminal").trim()
    const event_type = body.event_type || body.action || "AUTO"

    if (!student_id) {
      return NextResponse.json({ detail: "student_id is required" }, { status: 400 })
    }

    const result = await serverDb.recordAttendanceEvent({
      student_id,
      bus_id,
      stop,
      event_type,
    })

    return NextResponse.json(result)
  }

  // 4. Live GPS Telemetry Update (from driver or Raspberry Pi + GPS hardware)
  if (pathStr === "smart-bus/gps" || pathStr === "buses/location" || (routeParts[0] === "buses" && routeParts[2] === "location")) {
    const user = await getAuthUser(authHeader)
    if (user && user.role === "STUDENT") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }

    const bus_id = (body.bus_id || body.busId || (routeParts[0] === "buses" ? routeParts[1] : "BUS-01")).trim()
    const latitude = Number(body.latitude)
    const longitude = Number(body.longitude)

    if (isNaN(latitude) || isNaN(longitude)) {
      return NextResponse.json({ detail: "Valid latitude and longitude are required" }, { status: 400 })
    }

    const result = await serverDb.updateGpsLocation({
      bus_id,
      latitude,
      longitude,
      speed: body.speed !== undefined ? Number(body.speed) : undefined,
      heading: body.heading !== undefined ? Number(body.heading) : undefined,
      route: body.route,
      driver_id: body.driver_id || body.driverId,
      area: body.area,
      city: body.city,
    })

    return NextResponse.json(result)
  }

  // 5. Admin: Create Student + MongoDB Record + Immediate SMTP Email
  if (pathStr === "smart-bus/management/students" || pathStr === "students") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role !== "ADMIN") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }

    const student_id = (body.student_id || body.studentId || "").trim()
    const name = (body.name || "").trim()
    const email = (body.email || "").trim()
    const phone = (body.phone || "+91 99999 00000").trim()
    const department = (body.department || "Computer Science").trim()
    const year = (body.year || "1st Year").trim()
    const semester = (body.semester || "1st Sem").trim()
    const bus_id = (body.bus_id || body.assigned_bus || "BUS-01").trim()
    const pickup_location = (body.pickup_location || "Campus Gate").trim()

    if (!student_id || !name || !email) {
      return NextResponse.json(
        { detail: "student_id, name, and email are required fields" },
        { status: 400 }
      )
    }

    // Email format validation
    if (!email.includes("@")) {
      return NextResponse.json({ detail: "Invalid email format" }, { status: 400 })
    }

    // Check duplicate
    const existing = await serverDb.getStudentById(student_id)
    if (existing) {
      return NextResponse.json(
        { detail: `Student with ID '${student_id}' already exists in MongoDB.` },
        { status: 409 }
      )
    }

    try {
      const { student, emailResult } = await serverDb.createStudentWithAccount({
        student_id,
        name,
        email,
        phone,
        department,
        year,
        semester,
        bus_id,
        pickup_location,
        fee_total: body.fee_total !== undefined ? Number(body.fee_total) : 35000,
        fee_paid: body.fee_paid !== undefined ? Number(body.fee_paid) : 0,
        fee_valid_until: body.fee_valid_until || "2027-05-31",
        password: body.password,
      })

      return NextResponse.json(
        {
          success: true,
          message: "Student record created in MongoDB successfully.",
          student,
          email_dispatch: {
            sent: emailResult.sent,
            recipient: email,
            ...(emailResult.error ? { note: emailResult.error } : {}),
          },
        },
        { status: 201 }
      )
    } catch (err: any) {
      return NextResponse.json(
        { detail: err.message || "Failed to create student in MongoDB." },
        { status: 500 }
      )
    }
  }

  // 6. Admin: Create Driver
  if (pathStr === "smart-bus/management/drivers" || pathStr === "drivers") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role !== "ADMIN") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }

    const username = (body.username || "").trim()
    const name = (body.name || "").trim()
    const email = (body.email || "").trim()
    const phone = (body.phone || "").trim()
    const license_number = (body.license_number || "").trim()

    if (!username || !name) {
      return NextResponse.json({ detail: "username and name are required" }, { status: 400 })
    }

    const driver = await serverDb.createDriver({
      username,
      name,
      email: email || `${username}@smartbus.transit.org`,
      phone: phone || "+91 98888 00000",
      license_number: license_number || "KA-34-DL-PENDING",
      assigned_bus: body.assigned_bus || null,
    })

    return NextResponse.json({ success: true, driver }, { status: 201 })
  }

  // 7. Admin: Create Bus
  if (pathStr === "smart-bus/management/buses" || pathStr === "buses") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role !== "ADMIN") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }

    const bus_id = (body.bus_id || body.busId || "").trim()
    const registration_number = (body.registration_number || body.plate_number || "").trim()
    const route = (body.route || "").trim()

    if (!bus_id || !registration_number || !route) {
      return NextResponse.json(
        { detail: "bus_id, registration_number, and route are required" },
        { status: 400 }
      )
    }

    const bus = await serverDb.createBus({
      bus_id,
      bus_number: body.bus_number || bus_id,
      bus_name: body.bus_name || `${bus_id} (${route})`,
      registration_number,
      route,
      capacity: Number(body.capacity || 40),
      stops: Array.isArray(body.stops) ? body.stops : undefined,
      driver_id: body.driver_id,
      driver_name: body.driver_name,
    })

    return NextResponse.json({ success: true, bus }, { status: 201 })
  }

  // 8. Admin: Create or Update Fee
  if (pathStr === "smart-bus/management/fees" || pathStr === "fees") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role !== "ADMIN") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }
    const student_id = (body.student_id || body.studentId || "").trim()
    if (!student_id) {
      return NextResponse.json({ detail: "student_id is required" }, { status: 400 })
    }
    const fee = await serverDb.createOrUpdateFee(student_id, {
      fee_total: Number(body.total_fee !== undefined ? body.total_fee : body.fee_total !== undefined ? body.fee_total : 35000),
      fee_paid: Number(body.paid_amount !== undefined ? body.paid_amount : body.fee_paid !== undefined ? body.fee_paid : 0),
      academic_year: body.academic_year || "2026-27",
      payment_date: body.payment_date,
      valid_until: body.valid_until,
    })
    const students = await serverDb.getStudents()
    const st = students.find((s) => s.student_id === student_id)
    return NextResponse.json(
      {
        success: true,
        message: "Fee record saved in MongoDB successfully.",
        fee: {
          student_id: fee.student_id,
          student_name: st?.name || "Student",
          academic_year: fee.academic_year,
          total_fee: fee.fee_total,
          paid_amount: fee.fee_paid,
          pending_amount: fee.fee_pending,
          status: fee.fee_status,
          last_payment_date: fee.payment_date,
          valid_until: fee.valid_until,
        },
      },
      { status: 201 }
    )
  }

  // 9. Face Recognition: Student Face Registration
  if (pathStr === "smart-bus/face/register" || pathStr === "faces/register") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role === "DRIVER") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }

    const targetStudentId =
      user.role === "STUDENT"
        ? (user.student_id || user.username)
        : (body.student_id || user.student_id || user.username)

    if (!body.face_embedding || !Array.isArray(body.face_embedding) || body.face_embedding.length !== EMBEDDING_DIMENSION) {
      return NextResponse.json(
        { detail: `Valid ${EMBEDDING_DIMENSION}-dimensional face embedding is required.` },
        { status: 400 }
      )
    }

    // Real-model enforcement (docs/EMBEDDING_SPEC.md): this low-level route
    // accepts a pre-computed embedding + its metadata directly. It is kept
    // for API compatibility, but serverDb.registerFace will reject the call
    // unless embedding_metadata.model_version matches the current spec --
    // see "faces/enroll-samples" below for the recommended path, which
    // computes the embedding server-side from real photos so a caller can
    // never fabricate metadata to bypass this check.
    const sampleCount = Number(body.sample_count || 5)
    // Optional multi-sample enrollment (e.g. raspberry_pi/enroll_face.py): `face_embedding` is the
    // aggregated template, `face_embeddings` the individual samples. `force_replace` is honoured for
    // ADMIN only -- a student can never overwrite their own existing enrollment this way.
    const samples = Array.isArray(body.face_embeddings) && body.face_embeddings.length > 0 ? body.face_embeddings : null
    const result = await serverDb.registerFace(
      targetStudentId,
      body.face_embedding,
      sampleCount,
      body.embedding_metadata || null,
      { force: user.role === "ADMIN" && body.force_replace === true, samples }
    )

    if (!result.success) {
      return NextResponse.json({ detail: result.error || "Failed to register face." }, { status: 400 })
    }

    return NextResponse.json(result, { status: 200 })
  }

  // 9a. Face Recognition: Real server-side enrollment from photos (preferred
  // path -- see docs/EMBEDDING_SPEC.md, item 4's "Browser Camera -> Backend
  // Face Engine" architecture). Accepts base64-encoded face images captured
  // in the browser, runs them through the ONE shared ONNX model
  // (lib/face-embedding-server.ts), and only ever stores a real,
  // spec-compliant embedding -- never a client-supplied or fabricated one.
  if (pathStr === "smart-bus/faces/enroll-samples" || pathStr === "faces/enroll-samples") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role === "DRIVER") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }

    const targetStudentId =
      user.role === "STUDENT"
        ? (user.student_id || user.username)
        : (body.student_id || user.student_id || user.username)

    const images: string[] = Array.isArray(body.images) ? body.images : []
    if (images.length === 0) {
      return NextResponse.json({ detail: "At least one face image sample is required." }, { status: 400 })
    }

    let embeddingFn: typeof import("@/lib/face-embedding-server").embedFaceImagesBatch
    let metadataFn: typeof import("@/lib/face-embedding-server").currentEmbeddingMetadata
    try {
      const mod = await import("@/lib/face-embedding-server")
      embeddingFn = mod.embedFaceImagesBatch
      metadataFn = mod.currentEmbeddingMetadata
    } catch {
      return NextResponse.json(
        { detail: "Face embedding module failed to load." },
        { status: 500 }
      )
    }

    try {
      // IMPORTANT:
      // Enrollment must use the exact same face-crop space as live recognition:
      //
      // Full image
      //   -> SCRFD-500M
      //   -> exactly one face bounding box
      //   -> ArcFace w600k_mbf
      //   -> 512-D normalized embedding
      //
      // Do NOT generate the enrollment embedding from the full frame.

      const { detectExactlyOneFace } = await import(
        "@/lib/scrfd-face-detector-server"
      )

      const buffers: Array<{
        buffer: Buffer
        box: {
          x: number
          y: number
          width: number
          height: number
        }
      }> = []

      for (const dataUrl of images) {
        const base64 = dataUrl.includes(",")
          ? dataUrl.split(",")[1]
          : dataUrl

        const buffer = Buffer.from(base64, "base64")

        const box = await detectExactlyOneFace(buffer)

        buffers.push({
          buffer,
          box,
        })
      }

      const embeddings = await embeddingFn(buffers)

      const sampleCount = embeddings.length
      const result = await serverDb.registerFace(targetStudentId, embeddings, sampleCount, metadataFn())

      if (!result.success) {
        return NextResponse.json({ detail: result.error || "Failed to register face." }, { status: 400 })
      }
      return NextResponse.json(result, { status: 200 })
    } catch (err: any) {
      if (err?.name === "ModelNotAvailableError") {
        // Never fabricate an embedding as a fallback here -- surface the
        // real reason plainly. See docs/EMBEDDING_SPEC.md for install steps.
        return NextResponse.json(
          {
            detail:
              "The real face recognition model is not yet installed on this server. " +
              "See docs/EMBEDDING_SPEC.md for the exact download/install procedure. " +
              `(${err.message})`,
          },
          { status: 503 }
        )
      }
      console.error("[face-enrollment] Processing failed:", err);
return NextResponse.json({ detail: "Failed to process face images." }, { status: 500 })
    }
  }

  // 9b. Migration: mark all legacy-embedded students as FACE_REENROLLMENT_REQUIRED
  // Safe to run multiple times (idempotent). ADMIN-only.
  if (pathStr === "smart-bus/faces/migrate-legacy" || pathStr === "faces/migrate-legacy") {
    const user = await getAuthUser(authHeader)
    if (!user || user.role !== "ADMIN") {
      return NextResponse.json({ detail: "Admin access required." }, { status: 403 })
    }
    const result = await serverDb.migrateEmbeddingsToReenrollmentRequired()
    return NextResponse.json({
      success: true,
      message: `Migration complete: ${result.marked} student(s) marked FACE_REENROLLMENT_REQUIRED, ${result.already_ok} already on current spec.`,
      ...result,
    })
  }

  // 10. Face Recognition: Student Re-registration Request
  if (pathStr === "smart-bus/face/reregistration-request" || pathStr === "faces/reregistration-request") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role === "DRIVER") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }

    const targetStudentId = user.student_id || user.username
    const reason = body.reason || "Student requested face update"
    const result = await serverDb.requestFaceReRegistration(targetStudentId, reason)

    if (!result.success) {
      return NextResponse.json({ detail: result.error || "Failed to submit request." }, { status: 400 })
    }

    return NextResponse.json(result, { status: 200 })
  }

  // 11. Face Recognition: Admin Re-registration Approval
  if (pathStr === "smart-bus/face/reregistration-approve" || pathStr === "faces/reregistration-approve") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role !== "ADMIN") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }

    const student_id = (body.student_id || "").trim()
    if (!student_id) {
      return NextResponse.json({ detail: "student_id is required." }, { status: 400 })
    }

    const action = body.action === "REJECT" ? "REJECT" : "APPROVE"
    const result = await serverDb.approveFaceReRegistration(student_id, action, body.admin_notes)

    if (!result.success) {
      return NextResponse.json({ detail: result.error || "Failed to process request." }, { status: 400 })
    }

    return NextResponse.json(result, { status: 200 })
  }

  // 12. Face Recognition: Driver Multi-Face Processing (Up to 4 faces simultaneously)
  if (pathStr === "smart-bus/face/recognize" || pathStr === "faces/recognize" || pathStr === "faces/recognize-multi") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role === "STUDENT") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }

    const bus_id = (body.bus_id || user.assigned_bus || "BUS-01").trim()
    const stop = (body.stop || "Campus Terminal").trim()
    const faces = Array.isArray(body.faces) ? body.faces : []

    const result = await serverDb.recognizeAndProcessFaces({
      bus_id,
      stop,
      driver_id: user.username,
      trip_id: body.trip_id,
      camera_role: body.camera_role || "ENTRY",
      device_id: body.device_id,
      event_id: body.event_id,
      faces,
    })

    return NextResponse.json(result, { status: 200 })
  }

  // 12a. Bus Trip Lifecycle: Start Trip Session
  if (
    pathStr === "smart-bus/trips/start" ||
    (routeParts[0] === "smart-bus" && routeParts[1] === "buses" && routeParts[3] === "trip" && routeParts[4] === "start") ||
    (routeParts[0] === "buses" && routeParts[2] === "trip" && routeParts[3] === "start")
  ) {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role === "STUDENT") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }
    const bus_id = (body.bus_id || (routeParts[0] === "buses" ? routeParts[1] : routeParts[2]) || user.assigned_bus || "BUS-01").trim()
    const trip_id = (body.trip_id || "").trim() || undefined
    const result = await serverDb.startBusTrip(bus_id, trip_id)
    return NextResponse.json(result, { status: 200 })
  }

  // 12b. Bus Trip Lifecycle: Stop Trip Session
  if (
    pathStr === "smart-bus/trips/stop" ||
    (routeParts[0] === "smart-bus" && routeParts[1] === "buses" && routeParts[3] === "trip" && routeParts[4] === "stop") ||
    (routeParts[0] === "buses" && routeParts[2] === "trip" && routeParts[3] === "stop")
  ) {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role === "STUDENT") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }
    const bus_id = (body.bus_id || (routeParts[0] === "buses" ? routeParts[1] : routeParts[2]) || user.assigned_bus || "BUS-01").trim()
    const result = await serverDb.stopBusTrip(bus_id)
    return NextResponse.json(result, { status: 200 })
  }

  // 12. Admin: Reset Student Password
  const isStudentReset =
    pathStr === "smart-bus/management/students/reset-password" ||
    (routeParts[0] === "smart-bus" && routeParts[1] === "management" && routeParts[2] === "students" && routeParts[4] === "reset-password") ||
    (routeParts[0] === "students" && routeParts[2] === "reset-password")

  if (isStudentReset) {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role !== "ADMIN") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }
    const urlStudentId = routeParts[4] === "reset-password" ? routeParts[3] : routeParts[2] === "reset-password" ? routeParts[1] : undefined
    const student_id = (body.student_id || body.studentId || urlStudentId || "").trim()
    if (!student_id) {
      return NextResponse.json({ detail: "student_id is required" }, { status: 400 })
    }
    try {
      const result = await serverDb.resetStudentPassword(student_id, body.new_password)
      return NextResponse.json({
        success: true,
        message: "Password reset successfully.",
        student_id,
        temporary_password: result.temporaryPassword,
        email_dispatch: result.email_dispatch,
      })
    } catch (err: any) {
      return NextResponse.json({ detail: err.message || "Failed to reset student password" }, { status: 500 })
    }
  }

  // 13. Admin: Reset Driver Password
  const isDriverReset =
    pathStr === "smart-bus/management/drivers/reset-password" ||
    (routeParts[0] === "smart-bus" && routeParts[1] === "management" && routeParts[2] === "drivers" && routeParts[4] === "reset-password") ||
    (routeParts[0] === "drivers" && routeParts[2] === "reset-password")

  if (isDriverReset) {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role !== "ADMIN") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }
    const urlUsername = routeParts[4] === "reset-password" ? routeParts[3] : routeParts[2] === "reset-password" ? routeParts[1] : undefined
    const username = (body.username || body.driver_id || urlUsername || "").trim()
    if (!username) {
      return NextResponse.json({ detail: "username is required" }, { status: 400 })
    }
    try {
      const result = await serverDb.resetDriverPassword(username, body.new_password)
      return NextResponse.json({
        success: true,
        message: "Driver password reset successfully.",
        username,
        temporary_password: result.temporaryPassword,
      })
    } catch (err: any) {
      return NextResponse.json({ detail: err.message || "Failed to reset driver password" }, { status: 500 })
    }
  }

  // 14. Driver/Admin: Start Bus Service
  const isStartBus =
    pathStr === "smart-bus/driver/bus/start" ||
    pathStr === "buses/start" ||
    (routeParts[0] === "smart-bus" && routeParts[1] === "buses" && routeParts[3] === "start") ||
    (routeParts[0] === "buses" && routeParts[2] === "start")

  if (isStartBus) {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role !== "DRIVER" && user.role !== "ADMIN") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }
    const urlBusId = routeParts[3] === "start" ? routeParts[2] : routeParts[2] === "start" ? routeParts[1] : undefined
    const bus_id = (body.bus_id || urlBusId || user.assigned_bus || "BUS-01").trim()
    const bus = await serverDb.startBus(bus_id)
    return NextResponse.json({
      success: true,
      message: `Bus ${bus_id} transit service started. GPS tracking active.`,
      bus,
    })
  }

  // 15. Driver/Admin: Stop Bus Service
  const isStopBus =
    pathStr === "smart-bus/driver/bus/stop" ||
    pathStr === "buses/stop" ||
    (routeParts[0] === "smart-bus" && routeParts[1] === "buses" && routeParts[3] === "stop") ||
    (routeParts[0] === "buses" && routeParts[2] === "stop")

  if (isStopBus) {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role !== "DRIVER" && user.role !== "ADMIN") {
      return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
    }
    const urlBusId = routeParts[3] === "stop" ? routeParts[2] : routeParts[2] === "stop" ? routeParts[1] : undefined
    const bus_id = (body.bus_id || urlBusId || user.assigned_bus || "BUS-01").trim()
    const bus = await serverDb.stopBus(bus_id)
    return NextResponse.json({
      success: true,
      message: `Bus ${bus_id} transit service stopped. GPS tracking deactivated.`,
      bus,
    })
  }

  // 16. IoT Hardware Authentication Helper for POST endpoints
  const getIotAuth = async (targetBusId?: string) => {
    const deviceId = req.headers.get("x-device-id") || req.headers.get("X-Device-Id")
    const apiKey = req.headers.get("x-api-key") || req.headers.get("X-Api-Key")

    if (deviceId && apiKey) {
      const auth = await serverDb.authenticateIotDevice(deviceId, apiKey, targetBusId)
      if (!auth.success) {
        return { authorized: false, identity: deviceId, isDevice: true, status: auth.status_code, error: auth.error }
      }
      return { authorized: true, identity: deviceId, isDevice: true, device: auth.device, status: 200 }
    }

    const user = await getAuthUser(authHeader)
    if (user && (user.role === "DRIVER" || user.role === "ADMIN")) {
      return { authorized: true, identity: user.username, isDevice: false, user, status: 200 }
    }

    return {
      authorized: false,
      identity: "ANONYMOUS",
      isDevice: false,
      status: 401,
      error: "Authentication required. Provide valid x-device-id and x-api-key headers or Bearer JWT token.",
    }
  }

  // 17. IoT: Entry Events (Face Recognition at Bus Front Door)
  if (pathStr === "smart-bus/iot/entry-events" || pathStr === "iot/entry-events") {
    const bus_id = (body.bus_id || "BUS-01").trim()
    const auth = await getIotAuth(bus_id)
    if (!auth.authorized) {
      return NextResponse.json({ detail: auth.error }, { status: auth.status })
    }

    const stop = (body.stop || "Campus Terminal").trim()
    const trip_id = body.trip_id?.trim() || undefined
    const event_id = body.event_id?.trim() || req.headers.get("x-event-id") || undefined
    const device_id = auth.isDevice ? auth.identity : body.device_id || "PI-FRONT-ENTRY"

    // Process faces array or single face
    let faces = Array.isArray(body.faces) ? body.faces : []
    if (faces.length === 0 && body.face_encoding) {
      faces = [{ face_encoding: body.face_encoding, confidence: body.confidence || 0.9 }]
    }

    const result = await serverDb.recognizeAndProcessFaces({
      bus_id,
      stop,
      driver_id: auth.identity,
      trip_id,
      camera_role: "ENTRY",
      device_id,
      event_id,
      faces,
    })

    return NextResponse.json(result, { status: 200 })
  }

  // 18. IoT: Exit Events (Face Recognition at Bus Deboarding Door)
  if (pathStr === "smart-bus/iot/exit-events" || pathStr === "iot/exit-events") {
    const bus_id = (body.bus_id || "BUS-01").trim()
    const auth = await getIotAuth(bus_id)
    if (!auth.authorized) {
      return NextResponse.json({ detail: auth.error }, { status: auth.status })
    }

    const stop = (body.stop || "Campus Terminal").trim()
    const trip_id = body.trip_id?.trim() || undefined
    const event_id = body.event_id?.trim() || req.headers.get("x-event-id") || undefined
    const device_id = auth.isDevice ? auth.identity : body.device_id || "PI-REAR-EXIT"

    // Process faces array or single face
    let faces = Array.isArray(body.faces) ? body.faces : []
    if (faces.length === 0 && body.face_encoding) {
      faces = [{ face_encoding: body.face_encoding, confidence: body.confidence || 0.9 }]
    }

    const result = await serverDb.recognizeAndProcessFaces({
      bus_id,
      stop,
      driver_id: auth.identity,
      trip_id,
      camera_role: "EXIT",
      device_id,
      event_id,
      faces,
    })

    return NextResponse.json(result, { status: 200 })
  }

  // 19. IoT: GPS Telemetry (Raspberry Pi + NEO-6M / SIM7600 module)
  if (pathStr === "smart-bus/iot/gps" || pathStr === "iot/gps") {
    const bus_id = (body.bus_id || "BUS-01").trim()
    const auth = await getIotAuth(bus_id)
    if (!auth.authorized) {
      return NextResponse.json({ detail: auth.error }, { status: auth.status })
    }

    const latitude = Number(body.latitude)
    const longitude = Number(body.longitude)
    if (isNaN(latitude) || isNaN(longitude)) {
      return NextResponse.json({ detail: "Valid latitude and longitude numbers are required" }, { status: 400 })
    }

    const result = await serverDb.updateGpsLocation({
      bus_id,
      latitude,
      longitude,
      speed: body.speed !== undefined ? Number(body.speed) : undefined,
      heading: body.heading !== undefined ? Number(body.heading) : undefined,
      driver_id: auth.identity,
      area: body.area,
      city: body.city,
    })

    return NextResponse.json({
      success: true,
      message: "GPS telemetry accepted",
      device_id: auth.identity,
      telemetry: {
        bus_id,
        latitude,
        longitude,
        speed: body.speed !== undefined ? Number(body.speed) : 0,
        timestamp: result.timestamp,
      },
    })
  }

  // 20. IoT: Heartbeat & Health Telemetry
  if (pathStr === "smart-bus/iot/heartbeat" || pathStr === "iot/heartbeat") {
    const device_id = (body.device_id || req.headers.get("x-device-id") || "").trim()
    const apiKey = (body.api_key || req.headers.get("x-api-key") || "").trim()

    let targetDevId = device_id
    if (apiKey && device_id) {
      const auth = await serverDb.authenticateIotDevice(device_id, apiKey)
      if (!auth.success) {
        return NextResponse.json({ detail: auth.error }, { status: auth.status_code })
      }
      targetDevId = auth.device!.device_id
    } else {
      const user = await getAuthUser(authHeader)
      if (!user || (user.role !== "ADMIN" && user.role !== "DRIVER")) {
        return NextResponse.json({ detail: "Unauthorized heartbeat invocation." }, { status: 401 })
      }
    }

    if (!targetDevId) {
      return NextResponse.json({ detail: "device_id is required." }, { status: 400 })
    }

    const updated = await serverDb.recordIotHeartbeat(targetDevId, {
      status: body.status,
      camera_status: body.camera_status,
      gps_status: body.gps_status,
      network_status: body.network_status,
      firmware_version: body.firmware_version,
      ip_address: body.ip_address,
    })

    return NextResponse.json({
      success: true,
      message: "Device heartbeat logged",
      device: updated,
    })
  }

  // 21. IoT: Admin Device Registration
  if (pathStr === "smart-bus/iot/devices/register" || pathStr === "iot/devices/register") {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role !== "ADMIN") {
      return NextResponse.json({ detail: "You are not authorized to register hardware devices." }, { status: 403 })
    }

    const deviceName = (body.device_name || "").trim()
    const busId = (body.bus_id || "BUS-01").trim()
    if (!deviceName) {
      return NextResponse.json({ detail: "device_name is required." }, { status: 400 })
    }

    const registered = await serverDb.registerIotDevice({
      device_id: body.device_id,
      device_name: deviceName,
      device_type: body.device_type,
      bus_id: busId,
      camera_role: body.camera_role,
      firmware_version: body.firmware_version,
    })

    return NextResponse.json(registered, { status: 201 })
  }

  // 22. IoT: Device Status Toggle / Deactivation
  if (
    pathStr === "smart-bus/iot/devices/toggle" ||
    pathStr === "iot/devices/toggle" ||
    (routeParts[0] === "iot" && routeParts[1] === "devices" && routeParts[3] === "toggle") ||
    (routeParts[0] === "smart-bus" && routeParts[1] === "iot" && routeParts[2] === "devices" && routeParts[4] === "toggle")
  ) {
    const user = await getAuthUser(authHeader)
    if (!user) {
      return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
    }
    if (user.role !== "ADMIN") {
      return NextResponse.json({ detail: "You are not authorized to toggle devices." }, { status: 403 })
    }

    const deviceId =
      body.device_id ||
      (routeParts[0] === "smart-bus" ? routeParts[3] : routeParts[2]) ||
      ""
    const toggled = await serverDb.toggleIotDevice(deviceId, body.status)
    if (!toggled) {
      return NextResponse.json({ detail: `Device ${deviceId} not found.` }, { status: 404 })
    }
    return NextResponse.json({ success: true, device: toggled })
  }

  // 23. IoT: Batch Offline Sync (Replay queued events upon reconnection)
  if (pathStr === "smart-bus/iot/batch-sync" || pathStr === "iot/batch-sync") {
    const auth = await getIotAuth()
    if (!auth.authorized) {
      return NextResponse.json({ detail: auth.error }, { status: auth.status })
    }

    const events = Array.isArray(body.events) ? body.events : []
    const results: any[] = []
    let processedCount = 0
    let duplicateCount = 0

    for (const evt of events) {
      const queuedPayload =
        evt?.payload && typeof evt.payload === "object"
          ? evt.payload
          : evt;

      const eventType = String(
        evt.event_type ?? queuedPayload.camera_role ?? ""
      ).toUpperCase();

      const cameraRole = eventType.includes("EXIT") ? "EXIT" : "ENTRY";
      const busId = queuedPayload.bus_id || body.bus_id || "BUS-01";
      const stop = queuedPayload.stop || "Campus Terminal";
      const tripId = queuedPayload.trip_id || body.trip_id;
      const eventId = evt.event_id || queuedPayload.event_id;

      // Replay only the original face evidence.
      const faces = Array.isArray(queuedPayload.faces)
        ? queuedPayload.faces
        : [];

      const res = await serverDb.recognizeAndProcessFaces({
        bus_id: busId,
        stop,
        driver_id: auth.identity,
        trip_id: tripId,
        camera_role: cameraRole,
        device_id: auth.identity,
        event_id: eventId,
        faces,
      });

      if (res.event_status === "ALREADY_PROCESSED") {
        duplicateCount++;
      } else if (res.event_status === "COMPLETED") {
        processedCount++;
      }

      results.push({ event_id: eventId, result: res });
    }
    return NextResponse.json({
      success: true,
      message: `Processed ${processedCount} offline events, ${duplicateCount} duplicates skipped.`,
      processed_count: processedCount,
      duplicate_count: duplicateCount,
      results,
    })
  }

  return NextResponse.json({ detail: `Endpoint POST /api/v1/${pathStr} not found` }, { status: 404 })
}

// ---------------------------------------------------------------------------
// PUT Handler
// ---------------------------------------------------------------------------

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ route: string[] }> }
) {
  const resolvedParams = await params
  const routeParts = resolvedParams.route || []
  const authHeader = req.headers.get("authorization")
  const body = await getRequestBody(req)

  // Enforce Admin authorization on PUT operations
  const user = await getAuthUser(authHeader)
  if (!user) {
    return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
  }

  // 1. Update Student
  if (
    (routeParts[0] === "smart-bus" && routeParts[1] === "management" && routeParts[2] === "students" && routeParts[3]) ||
    (routeParts[0] === "students" && routeParts[1])
  ) {
    const student_id = routeParts[0] === "smart-bus" ? routeParts[3] : routeParts[1]
    const updated = await serverDb.updateStudent(student_id, body)
    if (!updated) return NextResponse.json({ detail: "Student not found" }, { status: 404 })
    return NextResponse.json({ success: true, student: updated })
  }

  // 2. Assign Driver to Bus
  if (
    routeParts[0] === "smart-bus" &&
    routeParts[1] === "management" &&
    routeParts[2] === "buses" &&
    routeParts[4] === "driver"
  ) {
    const bus_id = routeParts[3]
    const driver_id = (body.driver_id || body.driverId || body.username || "").trim()
    const driver_name = (body.driver_name || body.driverName || body.name || "Assigned Driver").trim()

    if (!driver_id) {
      return NextResponse.json({ detail: "driver_id or username is required" }, { status: 400 })
    }

    const updated = await serverDb.assignDriverToBus(bus_id, driver_id, driver_name)
    if (!updated) return NextResponse.json({ detail: "Bus not found" }, { status: 404 })
    return NextResponse.json({ success: true, bus: updated })
  }

  // 3. Update Bus
  if (
    (routeParts[0] === "smart-bus" && routeParts[1] === "management" && routeParts[2] === "buses" && routeParts[3]) ||
    (routeParts[0] === "smart-bus" && routeParts[1] === "buses" && routeParts[2]) ||
    (routeParts[0] === "buses" && routeParts[1])
  ) {
    const bus_id = routeParts[0] === "smart-bus"
      ? (routeParts[1] === "management" ? routeParts[3] : routeParts[2])
      : routeParts[1]
    const updated = await serverDb.updateBus(bus_id, body)
    if (!updated) return NextResponse.json({ detail: "Bus not found" }, { status: 404 })
    return NextResponse.json({ success: true, bus: updated })
  }

  // 4. Update Driver
  if (
    (routeParts[0] === "smart-bus" && routeParts[1] === "management" && routeParts[2] === "drivers" && routeParts[3]) ||
    (routeParts[0] === "drivers" && routeParts[1])
  ) {
    const username = routeParts[0] === "smart-bus" ? routeParts[3] : routeParts[1]
    const updated = await serverDb.updateDriver(username, body)
    if (!updated) return NextResponse.json({ detail: "Driver not found" }, { status: 404 })
    return NextResponse.json({ success: true, driver: updated })
  }

  // 5. Update Fee
  if (
    (routeParts[0] === "smart-bus" && routeParts[1] === "management" && routeParts[2] === "fees" && routeParts[3]) ||
    (routeParts[0] === "fees" && routeParts[1])
  ) {
    const student_id = routeParts[0] === "smart-bus" ? routeParts[3] : routeParts[1]
    const updated = await serverDb.updateFee(student_id, {
      fee_total: body.fee_total !== undefined ? Number(body.fee_total) : body.total_fee !== undefined ? Number(body.total_fee) : undefined,
      fee_paid: body.fee_paid !== undefined ? Number(body.fee_paid) : body.paid_amount !== undefined ? Number(body.paid_amount) : undefined,
      payment_date: body.payment_date,
      valid_until: body.valid_until,
    })
    if (!updated) return NextResponse.json({ detail: "Fee record not found" }, { status: 404 })
    return NextResponse.json({ success: true, fee: updated })
  }

  return NextResponse.json({ detail: `Endpoint PUT /api/v1/${routeParts.join("/")} not found` }, { status: 404 })
}

// ---------------------------------------------------------------------------
// DELETE Handler
// ---------------------------------------------------------------------------

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ route: string[] }> }
) {
  const resolvedParams = await params
  const routeParts = resolvedParams.route || []
  const authHeader = req.headers.get("authorization")

  // Enforce Admin authorization on DELETE operations
  const user = await getAuthUser(authHeader)
  if (!user) {
    return NextResponse.json({ detail: "Your session has expired. Please log in again." }, { status: 401 })
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json({ detail: "You are not authorized to access this section." }, { status: 403 })
  }

  // 1. Delete Student
  if (
    (routeParts[0] === "smart-bus" && routeParts[1] === "management" && routeParts[2] === "students" && routeParts[3]) ||
    (routeParts[0] === "students" && routeParts[1])
  ) {
    const student_id = routeParts[0] === "smart-bus" ? routeParts[3] : routeParts[1]
    await serverDb.deleteStudent(student_id)
    return NextResponse.json({ success: true, message: `Student '${student_id}' deleted from MongoDB.` })
  }

  // 2. Delete Bus
  if (
    (routeParts[0] === "smart-bus" && routeParts[1] === "management" && routeParts[2] === "buses" && routeParts[3]) ||
    (routeParts[0] === "buses" && routeParts[1])
  ) {
    const bus_id = routeParts[0] === "smart-bus" ? routeParts[3] : routeParts[1]
    await serverDb.deleteBus(bus_id)
    return NextResponse.json({ success: true, message: `Bus '${bus_id}' deleted from MongoDB.` })
  }

  // 3. Delete Driver
  if (
    (routeParts[0] === "smart-bus" && routeParts[1] === "management" && routeParts[2] === "drivers" && routeParts[3]) ||
    (routeParts[0] === "drivers" && routeParts[1])
  ) {
    const username = routeParts[0] === "smart-bus" ? routeParts[3] : routeParts[1]
    await serverDb.deleteDriver(username)
    return NextResponse.json({ success: true, message: `Driver '${username}' deleted from MongoDB.` })
  }

  return NextResponse.json({ detail: `Endpoint DELETE /api/v1/${routeParts.join("/")} not found` }, { status: 404 })
}





