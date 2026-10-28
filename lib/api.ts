const API_URL = ""

// =========================================================
// TOKEN & SESSION MANAGEMENT
// =========================================================

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null
  return (
    localStorage.getItem("smart_bus_access_token") ||
    localStorage.getItem("token") ||
    localStorage.getItem("access_token") ||
    null
  )
}

export function getStoredUser(): CurrentUser | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem("smart_bus_user")
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && parsed.username && parsed.role) {
        return {
          username: parsed.username,
          role: parsed.role,
          name: parsed.name || parsed.username,
          full_name: parsed.full_name || parsed.name || parsed.username,
          assigned_bus: parsed.assigned_bus || null,
          student_id: parsed.student_id || null,
        }
      }
    }
  } catch {
    // Ignore JSON error
  }
  const username = localStorage.getItem("username")
  const role = (localStorage.getItem("role") || localStorage.getItem("user_role")) as any
  if (username && role) {
    return {
      username,
      role,
      name: localStorage.getItem("name") || username,
      full_name: localStorage.getItem("name") || username,
    }
  }
  return null
}

export function setAuthSession(data: {
  access_token: string
  role: string
  username: string
  name?: string | null
  assigned_bus?: string | null
  student_id?: string | null
}) {
  if (typeof window === "undefined") return
  localStorage.setItem("smart_bus_access_token", data.access_token)
  localStorage.setItem("token", data.access_token)
  localStorage.setItem("access_token", data.access_token)
  localStorage.setItem("role", data.role)
  localStorage.setItem("user_role", data.role)
  localStorage.setItem("username", data.username)
  localStorage.setItem(
    "smart_bus_user",
    JSON.stringify({
      username: data.username,
      role: data.role,
      name: data.name || data.username,
      assigned_bus: data.assigned_bus,
      student_id: data.student_id,
    })
  )
  try {
    document.cookie = `smart_bus_role=${encodeURIComponent(data.role)}; path=/; max-age=604800; SameSite=Lax`
  } catch {
    // Ignore cookie write errors if in restricted environment
  }
}

export function clearAuthSession() {
  if (typeof window === "undefined") return
  localStorage.removeItem("smart_bus_access_token")
  localStorage.removeItem("smart_bus_user")
  localStorage.removeItem("token")
  localStorage.removeItem("access_token")
  localStorage.removeItem("username")
  localStorage.removeItem("role")
  localStorage.removeItem("user_role")
  try {
    document.cookie = "smart_bus_role=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT"
  } catch {
    // Ignore cookie write errors
  }
}

// =========================================================
// GENERIC API REQUEST
// =========================================================

export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getStoredToken()

  const headers = new Headers(options.headers)

  if (
    options.body &&
    !(options.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json")
  }

  if (token) {
    headers.set("Authorization", `Bearer ${token}`)
  }

  let response: Response
  try {
    response = await fetch(`${API_URL}${endpoint}`, {
      ...options,
      headers,
    })
  } catch (error) {
    console.error("[API FETCH ERROR]", {
      url: `${API_URL}${endpoint}`,
      error,
    })
    throw error instanceof Error
      ? error
      : new Error("Unable to connect to the server.")
  }

  // -------------------------------------------------------
  // AUTHENTICATION EXPIRED / INVALID (401)
  // -------------------------------------------------------

  if (response.status === 401) {
    clearAuthSession()
    throw new Error("Your session has expired. Please log in again.")
  }

  // -------------------------------------------------------
  // UNAUTHORIZED ROLE ACCESS (403)
  // -------------------------------------------------------

  if (response.status === 403) {
    throw new Error("You are not authorized to access this section.")
  }

  // -------------------------------------------------------
  // API ERROR
  // -------------------------------------------------------

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`

    try {
      const errorData = await response.json()

      if (typeof errorData.detail === "string") {
        message = errorData.detail
      } else if (typeof errorData.message === "string") {
        message = errorData.message
      }
    } catch {
      // Ignore JSON parsing errors.
    }

    throw new Error(message)
  }

  return response.json()
}

// =========================================================
// AUTHENTICATION
// =========================================================

export interface LoginResponse {
  access_token: string
  token_type: string
  role: string
  username: string
  name?: string | null
  assigned_bus?: string | null
  student_id?: string | null
}

export interface CurrentUser {
  username: string
  role: "ADMIN" | "DRIVER" | "STUDENT"
  reference_id?: string | null
  full_name?: string | null
  name?: string | null
  email?: string | null
  phone?: string | null
  department?: string | null
  student_id?: string | null
  assigned_bus?: string | null
}

// =========================================================
// LOGIN
// =========================================================

export async function login(
  username: string,
  password: string
): Promise<LoginResponse> {
  const body = new URLSearchParams()
  body.append("username", username.trim())
  body.append("password", password)

  let response: Response
  try {
    response = await fetch(`${API_URL}/api/v1/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    })
  } catch (error) {
    console.error("[API FETCH ERROR]", {
      url: `${API_URL}/api/v1/auth/login`,
      error,
    })
    throw error instanceof Error
      ? error
      : new Error("Unable to connect to the server.")
  }

  if (!response.ok) {
    let message = "Invalid username or password"

    try {
      const data = await response.json()
      if (typeof data.detail === "string") {
        message = data.detail
      }
    } catch {
      // Ignore parsing errors.
    }

    throw new Error(message)
  }

  const data: LoginResponse = await response.json()
  setAuthSession(data)
  return data
}


// =========================================================
// CURRENT USER
// =========================================================

export async function getCurrentUser(): Promise<CurrentUser> {
  return apiRequest<CurrentUser>(
    "/api/v1/auth/me"
  )
}


// =========================================================
// SMART BUS OVERVIEW
// =========================================================

export interface Overview {
  total_buses: number

  total_students: number

  active_passengers: number

  boarded_events: number

  exited_events: number

  emergency_events: number
}


export async function getOverview(): Promise<Overview> {
  return apiRequest<Overview>(
    "/api/v1/smart-bus/overview"
  )
}

export async function getDashboard(): Promise<any> {
  return apiRequest<any>(
    "/api/v1/dashboard"
  )
}

export async function getMyFee(): Promise<{
  student_id: string
  academic_year: string
  total_fee: number
  paid_amount: number
  pending_amount: number
  status: "PAID" | "PARTIAL" | "PENDING"
  payment_date?: string
  valid_until?: string
} | null> {
  try {
    return await apiRequest("/api/v1/fees/my-fee")
  } catch {
    return null
  }
}


// =========================================================
// BUS
// =========================================================

export interface Bus {
  bus_id: string

  bus_name?: string

  plate_number?: string

  capacity?: number

  current_passengers?: number

  available_seats?: number

  status?: string

  driver_name?: string

  route?: string

  stops?: string[]

  assigned_students?: string[]

  area?: string

  city?: string

  state?: string

  country?: string

  latitude?: number

  longitude?: number

  gps?: {
    latitude?: number
    longitude?: number
    speed?: number
    heading?: number
    area?: string
    city?: string
    state?: string
    country?: string
    timestamp?: string
  }
}


export async function getBuses(): Promise<Bus[]> {
  const response =
    await apiRequest<{
      buses?: Bus[]
    }>(
      "/api/v1/smart-bus/buses"
    )

  return response.buses ?? []
}


export async function getBus(
  busId: string
): Promise<Bus> {
  return apiRequest<Bus>(
    `/api/v1/smart-bus/buses/${encodeURIComponent(
      busId
    )}`
  )
}


// =========================================================
// PASSENGERS
// =========================================================

export interface Passenger {
  student_id?: string

  name?: string

  bus_id?: string

  stop?: string

  status?: string

  timestamp?: string
}


export async function getPassengers(): Promise<Passenger[]> {
  const response =
    await apiRequest<{
      passengers?: Passenger[]
    }>(
      "/api/v1/smart-bus/passengers"
    )

  return response.passengers ?? []
}


// =========================================================
// ATTENDANCE
// =========================================================

export interface Attendance {
  student_id?: string

  name?: string

  bus_id?: string

  plate_number?: string

  stop?: string

  fee_status?: string

  date?: string

  time?: string

  status?: string
}


export async function getAttendance(): Promise<Attendance[]> {
  const data =
    await apiRequest<{
      attendance: Attendance[]

      count: number
    }>(
      "/api/v1/smart-bus/attendance"
    )

  return data.attendance ?? []
}


// =========================================================
// EMERGENCIES
// =========================================================

export interface Emergency {
  bus_id?: string

  driver?: string

  type?: string

  message?: string

  status?: string

  timestamp?: string
}


export async function getEmergencies(): Promise<Emergency[]> {
  const response =
    await apiRequest<{
      emergencies?: Emergency[]
    }>(
      "/api/v1/smart-bus/emergencies"
    )

  return response.emergencies ?? []
}


// =========================================================
// BUS ENTRY & ATTENDANCE (Non-QR: Camera / Vision / RFID / Terminal)
// =========================================================

export interface AttendanceEventResult {
  success: boolean
  action: "BOARDED" | "EXITED" | "DENIED" | "UNKNOWN"
  student_id?: string
  name?: string
  bus_id?: string
  stop?: string
  fee_status?: string
  message: string
  timestamp?: string
}

export type QRScanResult = AttendanceEventResult

export async function recordAttendanceEvent(
  studentId: string,
  busId: string,
  stop?: string,
  eventType?: "BOARDED" | "EXITED" | "AUTO" | "DENIED"
): Promise<AttendanceEventResult> {
  return apiRequest<AttendanceEventResult>(
    "/api/v1/smart-bus/entry-events",
    {
      method: "POST",
      body: JSON.stringify({
        student_id: studentId,
        bus_id: busId,
        stop: stop || "",
        event_type: eventType || "AUTO",
      }),
    }
  )
}

// Backwards-compatible alias for existing callers
export async function scanQr(
  studentId: string,
  busId: string,
  stop?: string
): Promise<AttendanceEventResult> {
  return recordAttendanceEvent(studentId, busId, stop)
}


// =========================================================
// GPS
// =========================================================

export interface GPSLocation {
  success: boolean

  available: boolean

  assigned?: boolean

  bus_id: string

  latitude?: number

  longitude?: number

  speed?: number | null

  heading?: number | null

  area?: string

  city?: string

  state?: string

  country?: string

  timestamp?: string

  updated_at?: string

  message?: string
}


// =========================================================
// UPDATE BUS GPS
// =========================================================

export async function updateBusGPS(
  busId: string,
  latitude: number,
  longitude: number,
  speed?: number | null,
  heading?: number | null
): Promise<GPSLocation> {
  return apiRequest<GPSLocation>(
    "/api/v1/smart-bus/gps",
    {
      method: "POST",

      body: JSON.stringify({
        bus_id:
          busId,

        latitude:
          latitude,

        longitude:
          longitude,

        speed:
          speed,

        heading:
          heading,

        timestamp:
          new Date().toISOString(),
      }),
    }
  )
}


// =========================================================
// GET SPECIFIC BUS LOCATION
// =========================================================

export async function getBusLocation(
  busId: string
): Promise<GPSLocation> {
  return apiRequest<GPSLocation>(
    `/api/v1/smart-bus/buses/${encodeURIComponent(
      busId
    )}/location`
  )
}


// =========================================================
// GET MY ASSIGNED BUS LOCATION
// =========================================================

export async function getMyBusLocation(): Promise<GPSLocation> {
  return apiRequest<GPSLocation>(
    "/api/v1/smart-bus/my-bus/location"
  )
}


// =========================================================
// BUS MANAGEMENT
// ADMIN
// =========================================================

export interface ManagedBus {
  bus_id: string

  bus_name: string

  plate_number: string

  capacity: number

  stops: string[]

  current_passengers: number

  available_seats: number

  route?: string

  status?: string

  driver: {
    username: string

    full_name: string
  } | null
}


export interface ManagedDriver {
  username: string
  full_name: string
  name?: string
  email?: string
  phone?: string
  license_number?: string
  assigned_bus?: string | null
  status?: string
}


// =========================================================
// GET MANAGED BUSES
// =========================================================

export async function getManagedBuses(): Promise<ManagedBus[]> {
  const data =
    await apiRequest<{
      buses: ManagedBus[]

      count: number
    }>(
      "/api/v1/smart-bus/management/buses"
    )

  return data.buses ?? []
}


// =========================================================
// GET MANAGED DRIVERS
// =========================================================

export async function getManagedDrivers(): Promise<ManagedDriver[]> {
  const data =
    await apiRequest<{
      drivers: ManagedDriver[]

      count: number
    }>(
      "/api/v1/smart-bus/management/drivers"
    )

  return data.drivers ?? []
}


// =========================================================
// CREATE / UPDATE / DELETE DRIVER
// =========================================================

export async function createManagedDriver(data: {
  username: string
  name: string
  password?: string
  email?: string
  phone?: string
  license_number?: string
  assigned_bus?: string
}) {
  return apiRequest<{
    success: boolean
    driver: ManagedDriver
  }>(
    "/api/v1/smart-bus/management/drivers",
    {
      method: "POST",
      body: JSON.stringify(data),
    }
  )
}

export async function updateManagedDriver(
  username: string,
  data: {
    name?: string
    email?: string
    phone?: string
    license_number?: string
    assigned_bus?: string | null
  }
) {
  return apiRequest<{
    success: boolean
    driver: ManagedDriver
  }>(
    `/api/v1/smart-bus/management/drivers/${encodeURIComponent(username)}`,
    {
      method: "PUT",
      body: JSON.stringify(data),
    }
  )
}

export async function deleteManagedDriver(username: string) {
  return apiRequest<{
    success: boolean
    message: string
  }>(
    `/api/v1/smart-bus/management/drivers/${encodeURIComponent(username)}`,
    {
      method: "DELETE",
    }
  )
}


// =========================================================
// ASSIGN DRIVER TO BUS
// =========================================================

export async function assignDriverToBus(
  busId: string,
  username: string
) {
  return apiRequest<{
    success: boolean

    message: string

    bus_id: string

    driver: {
      username: string

      full_name: string
    }
  }>(
    `/api/v1/smart-bus/management/buses/${encodeURIComponent(
      busId
    )}/driver`,
    {
      method: "PUT",

      body: JSON.stringify({
        username,
      }),
    }
  )
}


// =========================================================
// UPDATE MANAGED BUS
// =========================================================

export async function updateManagedBus(
  busId: string,
  data: {
    bus_name?: string

    plate_number?: string

    capacity?: number

    stops?: string[]
  }
) {
  return apiRequest(
    `/api/v1/smart-bus/management/buses/${encodeURIComponent(
      busId
    )}`,
    {
      method: "PUT",

      body: JSON.stringify(
        data
      ),
    }
  )
}


// =========================================================
// CREATE MANAGED BUS
// =========================================================

export async function createManagedBus(
  data: {
    bus_id: string

    bus_name: string

    plate_number: string

    capacity: number

    stops: string[]
  }
) {
  return apiRequest(
    "/api/v1/smart-bus/management/buses",
    {
      method: "POST",

      body: JSON.stringify(
        data
      ),
    }
  )
}

export async function deleteManagedBus(busId: string) {
  return apiRequest<{
    success: boolean
    message: string
  }>(
    `/api/v1/smart-bus/management/buses/${encodeURIComponent(busId)}`,
    {
      method: "DELETE",
    }
  )
}


// =========================================================
// STUDENT MANAGEMENT
// ADMIN
// =========================================================

export interface ManagedStudent {
  student_id: string
  name: string
  email?: string | null
  phone?: string | null
  department?: string | null
  year?: string | null
  semester?: string | null
  assigned_bus?: string | null
  fee_status?: string | null
  fee_total?: number
  fee_paid?: number
  fee_pending?: number
  fee_valid_until?: string | null
  is_boarded: boolean
  face_registered?: boolean
  face_registered_at?: string | null
  face_reregistration_status?: "NONE" | "PENDING" | "APPROVED" | "REJECTED"
  face_samples_count?: number
}


// =========================================================
// GET MANAGED STUDENTS
// =========================================================

export async function getManagedStudents(): Promise<ManagedStudent[]> {
  const data =
    await apiRequest<{
      students: ManagedStudent[]

      count: number
    }>(
      "/api/v1/smart-bus/management/students"
    )

  return data.students ?? []
}


// =========================================================
// CREATE STUDENT
// =========================================================

export async function createManagedStudent(
  data: {
    student_id: string
    name: string
    email?: string
    phone?: string
    department?: string
    year?: string
    semester?: string
    assigned_bus?: string
    fee_total?: number
    fee_paid?: number
    fee_valid_until?: string
    password?: string
  }
) {
  return apiRequest<{
    success: boolean
    message: string
    student: ManagedStudent
    email_dispatch?: {
      sent: boolean
      recipient: string
      note?: string
    }
  }>(
    "/api/v1/smart-bus/management/students",
    {
      method: "POST",
      body: JSON.stringify(data),
    }
  )
}


// =========================================================
// UPDATE STUDENT
// =========================================================

export async function updateManagedStudent(
  studentId: string,
  data: {
    name?: string
    email?: string
    phone?: string
    assigned_bus?: string
    department?: string
    year?: string
    semester?: string
  }
) {
  return apiRequest<{
    success: boolean

    message: string

    student: ManagedStudent
  }>(
    `/api/v1/smart-bus/management/students/${encodeURIComponent(
      studentId
    )}`,
    {
      method: "PUT",

      body: JSON.stringify(
        data
      ),
    }
  )
}

export async function deleteManagedStudent(studentId: string) {
  return apiRequest<{
    success: boolean
    message: string
  }>(
    `/api/v1/smart-bus/management/students/${encodeURIComponent(studentId)}`,
    {
      method: "DELETE",
    }
  )
}


// =========================================================
// FEE MANAGEMENT
// ADMIN
// =========================================================

export interface ManagedFee {
  student_id: string

  student_name?: string | null

  academic_year: string

  total_fee: number

  paid_amount: number

  pending_amount: number

  status:
    | "PAID"
    | "PARTIAL"
    | "PENDING"

  last_payment_date?: string | null
}


// =========================================================
// GET FEES
// =========================================================

export async function getManagedFees(): Promise<ManagedFee[]> {
  const data =
    await apiRequest<{
      fees: ManagedFee[]

      count: number
    }>(
      "/api/v1/smart-bus/management/fees"
    )

  return data.fees ?? []
}


// =========================================================
// CREATE FEE
// =========================================================

export async function createManagedFee(
  data: {
    student_id: string

    academic_year: string

    total_fee: number

    paid_amount: number
  }
) {
  return apiRequest<{
    success: boolean

    message: string

    fee: ManagedFee
  }>(
    "/api/v1/smart-bus/management/fees",
    {
      method: "POST",

      body: JSON.stringify(
        data
      ),
    }
  )
}


// =========================================================
// UPDATE FEE
// =========================================================

export async function updateManagedFee(
  studentId: string,
  data: {
    academic_year?: string

    total_fee?: number

    paid_amount?: number
  }
) {
  return apiRequest<{
    success: boolean

    message: string

    fee: ManagedFee
  }>(
    `/api/v1/smart-bus/management/fees/${encodeURIComponent(
      studentId
    )}`,
    {
      method: "PUT",

      body: JSON.stringify(
        data
      ),
    }
  )
}

// =========================================================
// FACE RECOGNITION & BIOMETRICS API
// =========================================================

export interface FaceStatusResponse {
  student_id: string
  name: string
  face_registered: boolean
  face_registered_at: string | null
  face_sample_count: number
  face_reregistration_status: "NONE" | "PENDING" | "APPROVED" | "REJECTED"
  face_reregistration_requested: boolean
  fee_status: string
  assigned_bus: string
}

export interface FaceRecognitionItem {
  face_index: number
  student_id: string
  name: string
  status:
    | "RECOGNIZED"
    | "UNKNOWN"
    | "LOW CONFIDENCE"
    | "ALREADY BOARDED"
    | "EXIT SUCCESSFUL"
    | "ALREADY EXITED"
    | "NOT BOARDED - CANNOT EXIT"
    | "DENIED - FEE NOT VALID"
    | "DENIED - INACTIVE ACCOUNT"
    | "DENIED - WRONG BUS"
    | "DENIED - CAPACITY REACHED"
  recognition_state?:
    | "DETECTING"
    | "QUALITY_CHECK"
    | "TRACKING"
    | "VERIFYING"
    | "VERIFIED"
    | "BOARDING"
    | "BOARDED"
    | "ALREADY_BOARDED"
    | "EXITING"
    | "EXITED"
    | "ALREADY_EXITED"
    | "UNKNOWN"
    | "LOW_CONFIDENCE"
    | "LIVENESS_FAILED"
    | "DENIED_FEE"
    | "DENIED_INACTIVE"
    | "DENIED_CAPACITY"
    | "ERROR"
  confidence: number
  fee_status: string
  assigned_bus: string
  boarding_status: string
  message: string
  quality_score?: number
  quality_label?: string
  liveness_status?: "VERIFIED" | "PENDING" | "FAILED"
  passenger_count_incremented?: boolean
  passenger_count_decremented?: boolean
  passenger_state?: "NOT_BOARDED" | "BOARDED" | "EXITED"
  camera_role?: "ENTRY" | "EXIT"
  trip_id?: string
  bbox?: { x: number; y: number; width: number; height: number }
}

export interface MultiFaceRecognitionResponse {
  success: boolean
  processed_faces: FaceRecognitionItem[]
  count: number
  overflow: boolean
  message: string
  bus: {
    bus_id: string
    passengers: number
    capacity: number
    available_seats: number
  }
}

export interface FaceReRegistrationRequestItem {
  request_id: string
  student_id: string
  student_name: string
  department: string
  bus_id: string
  requested_at: string
  status: "PENDING" | "APPROVED" | "REJECTED"
  admin_notes?: string
  reviewed_at?: string
}

export interface FaceStatsResponse {
  total_students: number
  registered_faces: number
  unregistered_faces: number
  pending_reregistrations: number
  registration_rate: string
}

export async function getFaceStatus(studentId?: string): Promise<FaceStatusResponse> {
  const query = studentId ? `?student_id=${encodeURIComponent(studentId)}` : ""
  return apiRequest<FaceStatusResponse>(`/api/v1/smart-bus/face/status${query}`)
}

export async function enrollStudentFaceSamples(
  imageDataUrls: string[]
): Promise<{ success: boolean; message: string; registered_at?: string }> {
  return apiRequest<{ success: boolean; message: string; registered_at?: string }>(
    "/api/v1/smart-bus/faces/enroll-samples",
    {
      method: "POST",
      body: JSON.stringify({ images: imageDataUrls }),
    }
  )
}

export async function registerStudentFace(
  embedding: number[],
  sampleCount = 5
): Promise<{ success: boolean; message: string; registered_at?: string }> {
  return apiRequest<{ success: boolean; message: string; registered_at?: string }>(
    "/api/v1/smart-bus/face/register",
    {
      method: "POST",
      body: JSON.stringify({ face_embedding: embedding, sample_count: sampleCount }),
    }
  )
}

export async function requestFaceReRegistration(
  reason?: string
): Promise<{ success: boolean; message: string; status: string }> {
  return apiRequest<{ success: boolean; message: string; status: string }>(
    "/api/v1/smart-bus/face/reregistration-request",
    {
      method: "POST",
      body: JSON.stringify({ reason }),
    }
  )
}

export async function getFaceReRegistrationRequests(): Promise<{
  requests: FaceReRegistrationRequestItem[]
  count: number
}> {
  return apiRequest<{ requests: FaceReRegistrationRequestItem[]; count: number }>(
    "/api/v1/smart-bus/face/reregistration-requests"
  )
}

export async function approveFaceReRegistration(
  studentId: string,
  action: "APPROVE" | "REJECT",
  adminNotes?: string
): Promise<{ success: boolean; message: string; status: string }> {
  return apiRequest<{ success: boolean; message: string; status: string }>(
    "/api/v1/smart-bus/face/reregistration-approve",
    {
      method: "POST",
      body: JSON.stringify({ student_id: studentId, action, admin_notes: adminNotes }),
    }
  )
}

export async function getFaceStats(): Promise<FaceStatsResponse> {
  return apiRequest<FaceStatsResponse>("/api/v1/smart-bus/face/stats")
}

export async function recognizeFacesBatch(
  busId: string,
  stop: string,
  faces: Array<{
    embedding: number[]
    bbox?: any
    quality?: any
    liveness?: any
  }>,
  tripId?: string,
  cameraRole?: "ENTRY" | "EXIT",
  deviceId?: string,
  eventId?: string
): Promise<MultiFaceRecognitionResponse> {
  return apiRequest<MultiFaceRecognitionResponse>("/api/v1/smart-bus/face/recognize", {
    method: "POST",
    body: JSON.stringify({
      bus_id: busId,
      stop,
      faces,
      trip_id: tripId,
      camera_role: cameraRole || "ENTRY",
      device_id: deviceId,
      event_id: eventId,
    }),
  })
}

export interface TripStatsResponse {
  bus_id: string
  trip_id: string
  capacity: number
  currently_on_board: number
  total_entries: number
  total_exits: number
  available_seats: number
  occupancy_percentage: string
}

export interface TripManifestItem {
  student_id: string
  name: string
  department: string
  bus_id: string
  state: "NOT_BOARDED" | "BOARDED" | "EXITED"
  entry_time: string | null
  entry_location: string | null
  exit_time: string | null
  exit_location: string | null
  fee_status: string
}

export interface IoTDevice {
  device_id: string
  device_name: string
  device_type: "RASPBERRY_PI" | "GPS" | "ENTRY_CAMERA" | "EXIT_CAMERA"
  bus_id: string
  camera_role?: "ENTRY" | "EXIT"
  status: "ONLINE" | "OFFLINE" | "DEACTIVATED"
  last_seen: string
  firmware_version: string
  camera_status?: "ACTIVE" | "IDLE" | "ERROR"
  gps_status?: "FIX_ACQUIRED" | "SEARCHING" | "ERROR"
  network_status?: "WIFI" | "CELLULAR" | "ETHERNET" | "DISCONNECTED"
  ip_address?: string
  created_at: string
  updated_at: string
}

export async function getTripStats(busId = "BUS-01", tripId?: string): Promise<TripStatsResponse> {
  const query = tripId ? `?trip_id=${encodeURIComponent(tripId)}` : ""
  return apiRequest<TripStatsResponse>(`/api/v1/smart-bus/trips/${encodeURIComponent(busId)}/stats${query}`)
}

export async function getTripManifest(
  busId = "BUS-01",
  tripId?: string
): Promise<{ bus_id: string; trip_id?: string; manifest: TripManifestItem[]; count: number }> {
  const query = tripId ? `?trip_id=${encodeURIComponent(tripId)}` : ""
  return apiRequest<{ bus_id: string; trip_id?: string; manifest: TripManifestItem[]; count: number }>(
    `/api/v1/smart-bus/trips/${encodeURIComponent(busId)}/manifest${query}`
  )
}

export async function getIotDevices(): Promise<{ devices: IoTDevice[]; count: number }> {
  return apiRequest<{ devices: IoTDevice[]; count: number }>("/api/v1/smart-bus/iot/devices")
}

export async function getIotDeviceById(deviceId: string): Promise<IoTDevice> {
  return apiRequest<IoTDevice>(`/api/v1/smart-bus/iot/devices/${encodeURIComponent(deviceId)}`)
}

export async function registerIotDevice(data: {
  device_id?: string
  device_name: string
  device_type?: "RASPBERRY_PI" | "GPS" | "ENTRY_CAMERA" | "EXIT_CAMERA"
  bus_id: string
  camera_role?: "ENTRY" | "EXIT"
  firmware_version?: string
}): Promise<{ success: boolean; device: IoTDevice; raw_api_key: string }> {
  return apiRequest<{ success: boolean; device: IoTDevice; raw_api_key: string }>(
    "/api/v1/smart-bus/iot/devices/register",
    {
      method: "POST",
      body: JSON.stringify(data),
    }
  )
}

export async function toggleIotDevice(
  deviceId: string,
  status?: "ONLINE" | "OFFLINE" | "DEACTIVATED"
): Promise<{ success: boolean; device: IoTDevice }> {
  return apiRequest<{ success: boolean; device: IoTDevice }>(
    `/api/v1/smart-bus/iot/devices/${encodeURIComponent(deviceId)}/toggle`,
    {
      method: "POST",
      body: JSON.stringify({ status }),
    }
  )
}

export async function startBusTrip(
  busId: string,
  tripId?: string
): Promise<{ success: boolean; message: string; trip_id: string; bus?: any }> {
  return apiRequest<{ success: boolean; message: string; trip_id: string; bus?: any }>(
    "/api/v1/smart-bus/trips/start",
    {
      method: "POST",
      body: JSON.stringify({ bus_id: busId, trip_id: tripId }),
    }
  )
}

export async function stopBusTrip(
  busId: string
): Promise<{ success: boolean; message: string; bus?: any }> {
  return apiRequest<{ success: boolean; message: string; bus?: any }>(
    "/api/v1/smart-bus/trips/stop",
    {
      method: "POST",
      body: JSON.stringify({ bus_id: busId }),
    }
  )
}

export async function startBus(busId?: string): Promise<{ success: boolean; message: string; bus?: any }> {
  return apiRequest<{ success: boolean; message: string; bus?: any }>("/api/v1/smart-bus/driver/bus/start", {
    method: "POST",
    body: JSON.stringify({ bus_id: busId }),
  })
}

export async function stopBus(busId?: string): Promise<{ success: boolean; message: string; bus?: any }> {
  return apiRequest<{ success: boolean; message: string; bus?: any }>("/api/v1/smart-bus/driver/bus/stop", {
    method: "POST",
    body: JSON.stringify({ bus_id: busId }),
  })
}

export async function resetStudentPassword(
  studentId: string,
  newPassword?: string
): Promise<{
  success: boolean
  message: string
  student_id: string
  temporary_password: string
  email_dispatch?: { sent: boolean; note?: string }
}> {
  return apiRequest<{
    success: boolean
    message: string
    student_id: string
    temporary_password: string
    email_dispatch?: { sent: boolean; note?: string }
  }>("/api/v1/smart-bus/management/students/reset-password", {
    method: "POST",
    body: JSON.stringify({ student_id: studentId, new_password: newPassword }),
  })
}

export async function resetDriverPassword(
  username: string,
  newPassword?: string
): Promise<{
  success: boolean
  message: string
  username: string
  temporary_password: string
}> {
  return apiRequest<{
    success: boolean
    message: string
    username: string
    temporary_password: string
  }>("/api/v1/smart-bus/management/drivers/reset-password", {
    method: "POST",
    body: JSON.stringify({ username, new_password: newPassword }),
  })
}







