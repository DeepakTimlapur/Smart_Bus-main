import { MongoClient, Db, Collection } from "mongodb"
import bcrypt from "bcryptjs"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import { generateCanonicalFaceEmbedding } from "./face-recognition"

export function hashDeviceApiKey(key: string): string {
  return crypto.createHash("sha256").update(key.trim()).digest("hex")
}

export interface UserDoc {
  username: string
  name: string
  email: string
  password_hash: string
  role: "ADMIN" | "DRIVER" | "STUDENT"
  assigned_bus?: string | null
  student_id?: string | null
  department?: string | null
  phone?: string | null
  account_status?: string
  created_at: string
  updated_at: string
}

export interface StudentDoc {
  student_id: string
  name: string
  email: string
  phone: string
  department: string
  year: string
  semester: string
  bus_id: string
  pickup_location: string
  fee_total: number
  fee_paid: number
  fee_pending: number
  fee_status: "PAID" | "PARTIAL" | "PENDING"
  fee_valid_until: string
  account_status: "ACTIVE" | "SUSPENDED"
  is_boarded?: boolean
  // Face Recognition fields
  face_registered: boolean
  face_embedding?: number[] | null
  face_embeddings?: number[][] | null // Multiple reference enrollment embeddings
  face_registered_at?: string | null
  face_sample_count?: number
  face_reregistration_requested?: boolean
  face_reregistration_request_date?: string | null
  face_reregistration_status?: "NONE" | "PENDING" | "APPROVED" | "REJECTED"
  // Embedding provenance metadata (see docs/EMBEDDING_SPEC.md). Any
  // face_embedding NOT carrying metadata matching the current spec's
  // model_version is legacy/incompatible and must be excluded from
  // matching -- see face_enrollment_status below and
  // docs/FACE_RECOGNITION.md, "Migration".
  face_embedding_metadata?: {
    model_name: string
    model_version: string
    embedding_dimension: number
    preprocessing_version: string
    alignment_version: string
    embedding_normalization: string
    created_at: string
  } | null
  // "FACE_REENROLLMENT_REQUIRED" for any student whose face_embedding was
  // produced before the real-model migration (or lacks matching metadata).
  // Never silently matched against; the student must re-enroll through the
  // real-model enrollment flow. See docs/FACE_RECOGNITION.md, "Migration".
  face_enrollment_status?: "OK" | "FACE_REENROLLMENT_REQUIRED" | "NOT_ENROLLED"
  created_at: string
  updated_at: string
}

export interface FaceReRegistrationRequestDoc {
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

export interface DriverDoc {
  username: string
  name: string
  email: string
  phone: string
  license_number: string
  assigned_bus: string | null
  account_status: "ACTIVE" | "INACTIVE"
  created_at: string
  updated_at: string
}

export interface BusDoc {
  bus_id: string
  bus_number: string
  bus_name: string
  registration_number: string
  plate_number: string
  route: string
  stops: string[]
  capacity: number
  passengers: number
  driver_id: string | null
  driver_name: string | null
  status: "ACTIVE" | "IN_TRANSIT" | "MAINTENANCE" | "INACTIVE"
  gps_device_id?: string
  latitude: number
  longitude: number
  speed: number
  heading: number
  area: string
  city: string
  state: string
  country: string
  assigned_students?: string[]
  current_trip_id?: string | null
  trip_active?: boolean
  last_gps_time: string
  created_at: string
  updated_at: string
}

export interface FeeDoc {
  student_id: string
  student_name: string
  email: string
  bus_id: string
  academic_year: string
  fee_total: number
  fee_paid: number
  fee_pending: number
  fee_status: "PAID" | "PARTIAL" | "PENDING"
  payment_date: string | null
  valid_until: string | null
  updated_at: string
}

export interface AttendanceDoc {
  student_id: string
  name: string
  bus_id: string
  route: string
  driver: string
  driver_id?: string
  trip_id?: string
  idempotency_key?: string
  event_id?: string
  device_id?: string
  camera_role?: "ENTRY" | "EXIT"
  plate_number: string
  stop: string
  fee_status: string
  event_type: "BOARDED" | "EXITED" | "DENIED" | "ENTRY" | "EXIT"
  status: "BOARDED" | "EXITED" | "DENIED" | "ENTRY" | "EXIT"
  passenger_state?: "NOT_BOARDED" | "BOARDED" | "EXITED"
  entry_time?: string
  entry_address?: string
  exit_time?: string
  exit_address?: string
  date: string
  time: string
  timestamp: string
  latitude?: number
  longitude?: number
  address?: string
  recognition_status?: string
  recognition_result?: string
  confidence?: number
  face_quality?: string
  liveness_status?: string
}

export interface IoTDeviceDoc {
  device_id: string
  device_name: string
  device_type: "RASPBERRY_PI" | "GPS" | "ENTRY_CAMERA" | "EXIT_CAMERA"
  bus_id: string
  camera_role?: "ENTRY" | "EXIT"
  api_key_hash: string
  status: "ONLINE" | "OFFLINE" | "DEACTIVATED"
  last_seen: string
  firmware_version?: string
  camera_status?: "ACTIVE" | "IDLE" | "ERROR"
  gps_status?: "FIX_ACQUIRED" | "SEARCHING" | "ERROR"
  network_status?: "WIFI" | "CELLULAR" | "ETHERNET" | "DISCONNECTED"
  ip_address?: string
  created_at: string
  updated_at: string
}

export interface GpsLocationDoc {
  busId: string
  bus_id?: string
  latitude: number
  longitude: number
  speed: number
  heading: number
  route: string
  driverId?: string | null
  driver_id?: string | null
  area?: string
  city?: string
  state?: string
  country?: string
  timestamp: string
}

// Next.js MongoDB client reuse singleton pattern
declare global {
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined
}

const DEFAULT_DB = process.env.MONGODB_DB || "smart_bus_db"

function getMongoUri(): string {
  return process.env.MONGODB_URI || "mongodb://localhost:27017"
}

let lastMongoFailTime = 0
const MONGO_COOLDOWN_MS = 60000

export async function getMongoClientPromise(): Promise<MongoClient> {
  const now = Date.now()
  if (now - lastMongoFailTime < MONGO_COOLDOWN_MS) {
    throw new Error("MongoDB connection cooling down after recent network failure")
  }

  const uri = getMongoUri()
  if (global._mongoClientPromise) {
    return global._mongoClientPromise
  }

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 2000,
    connectTimeoutMS: 3000,
  })

  try {
    global._mongoClientPromise = client.connect()
    const connected = await global._mongoClientPromise
    lastMongoFailTime = 0
    return connected
  } catch (err) {
    lastMongoFailTime = Date.now()
    global._mongoClientPromise = undefined
    throw err
  }
}

// Memory fallback store for environments where MongoDB is temporarily offline or unconfigured
class MemoryDataStore {
  users: Map<string, UserDoc> = new Map()
  students: Map<string, StudentDoc> = new Map()
  drivers: Map<string, DriverDoc> = new Map()
  buses: Map<string, BusDoc> = new Map()
  fees: Map<string, FeeDoc> = new Map()
  attendance: AttendanceDoc[] = []
  gpsLocations: GpsLocationDoc[] = []
  faceRequests: Map<string, FaceReRegistrationRequestDoc> = new Map()
  devices: Map<string, IoTDeviceDoc> = new Map()
  boardedTripKeys: Set<string> = new Set()
  exitedTripKeys: Set<string> = new Set()
  processedEventIds: Set<string> = new Set()
  initialized = false

  async seed() {
    if (this.initialized) return
    const seedPassword = process.env.SMARTBUS_SEED_PASSWORD || crypto.randomBytes(32).toString("hex")
    const initialUsers: UserDoc[] = [
      {
        username: "admin",
        name: "Transit Administrator",
        email: "admin@smartbus.transit.org",
        password_hash: await bcrypt.hash(seedPassword, 10),
        role: "ADMIN",
        assigned_bus: null,
        student_id: null,
        department: "Operations",
        phone: "+91 80000 00001",
        account_status: "ACTIVE",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        username: "driver1",
        name: "Morgan Driver",
        email: "driver1@smartbus.transit.org",
        password_hash: await bcrypt.hash(seedPassword, 10),
        role: "DRIVER",
        assigned_bus: "BUS-01",
        phone: "+91 00000 00000",
        account_status: "ACTIVE",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        username: "driver2",
        name: "Riley Driver",
        email: "driver2@smartbus.transit.org",
        password_hash: await bcrypt.hash(seedPassword, 10),
        role: "DRIVER",
        assigned_bus: "BUS-03",
        phone: "+91 00000 00000",
        account_status: "ACTIVE",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        username: "student1",
        name: "Alex Morgan",
        email: "alex.morgan@example.com",
        password_hash: await bcrypt.hash(seedPassword, 10),
        role: "STUDENT",
        student_id: "STU-DEMO-001",
        assigned_bus: "BUS-01",
        department: "Computer Science & Engineering",
        phone: "+91 00000 00000",
        account_status: "ACTIVE",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        username: "STU-DEMO-001",
        name: "Alex Morgan",
        email: "alex.morgan@example.com",
        password_hash: await bcrypt.hash(seedPassword, 10),
        role: "STUDENT",
        student_id: "STU-DEMO-001",
        assigned_bus: "BUS-01",
        department: "Computer Science & Engineering",
        phone: "+91 00000 00000",
        account_status: "ACTIVE",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        username: "STU-DEMO-002",
        name: "Taylor Reed",
        email: "taylor.reed@example.com",
        password_hash: await bcrypt.hash(seedPassword, 10),
        role: "STUDENT",
        student_id: "STU-DEMO-002",
        assigned_bus: "BUS-03",
        department: "Electronics & Communication",
        phone: "+91 00000 00000",
        account_status: "ACTIVE",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        username: "STU-DEMO-003",
        name: "Jordan Lee",
        email: "jordan.lee@example.com",
        password_hash: await bcrypt.hash(seedPassword, 10),
        role: "STUDENT",
        student_id: "STU-DEMO-003",
        assigned_bus: "BUS-01",
        department: "Mechanical Engineering",
        phone: "+91 00000 00000",
        account_status: "ACTIVE",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        username: "STU-DEMO-004",
        name: "Casey Patel",
        email: "casey.patel@example.com",
        password_hash: await bcrypt.hash(seedPassword, 10),
        role: "STUDENT",
        student_id: "STU-DEMO-004",
        assigned_bus: "BUS-01",
        department: "Computer Science & Engineering",
        phone: "+91 00000 00000",
        account_status: "ACTIVE",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]
    for (const u of initialUsers) {
      this.users.set(u.username, u)
    }

    const initialStudents: StudentDoc[] = [
      {
        student_id: "STU-DEMO-001",
        name: "Alex Morgan",
        email: "alex.morgan@example.com",
        phone: "+91 00000 00000",
        department: "Computer Science & Engineering",
        year: "2nd Year",
        semester: "4th Sem",
        bus_id: "BUS-01",
        pickup_location: "Main Campus Gate",
        fee_total: 35000,
        fee_paid: 35000,
        fee_pending: 0,
        fee_status: "PAID",
        fee_valid_until: "2027-05-31",
        account_status: "ACTIVE",
        is_boarded: false,
        face_registered: false,
        face_embedding: null,
        face_registered_at: null,
        face_reregistration_status: "NONE",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        student_id: "STU-DEMO-002",
        name: "Taylor Reed",
        email: "taylor.reed@example.com",
        phone: "+91 00000 00000",
        department: "Electronics & Communication",
        year: "3rd Year",
        semester: "6th Sem",
        bus_id: "BUS-01",
        pickup_location: "City Centre Circle",
        fee_total: 38000,
        fee_paid: 38000,
        fee_pending: 0,
        fee_status: "PAID",
        fee_valid_until: "2027-05-31",
        account_status: "ACTIVE",
        is_boarded: false,
        face_registered: true,
        // MIGRATION: this seed embedding was generated by generateCanonicalFaceEmbedding
        // (seeded-random, not from a real face) and is EXCLUDED from recognition matching.
        // face_enrollment_status: "FACE_REENROLLMENT_REQUIRED" marks it as such.
        // The student must re-enroll via the real ONNX model before they will be recognized.
        face_embedding: generateCanonicalFaceEmbedding("STU-DEMO-002"),
        face_enrollment_status: "FACE_REENROLLMENT_REQUIRED" as const,
        face_registered_at: new Date(Date.now() - 86400000 * 2).toISOString(),
        face_reregistration_status: "NONE",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        student_id: "STU-DEMO-003",
        name: "Jordan Lee",
        email: "jordan.lee@example.com",
        phone: "+91 00000 00000",
        department: "Mechanical Engineering",
        year: "1st Year",
        semester: "2nd Sem",
        bus_id: "BUS-01",
        pickup_location: "Railway Colony Circle",
        fee_total: 32000,
        fee_paid: 0,
        fee_pending: 32000,
        fee_status: "PENDING",
        fee_valid_until: "2026-01-01", // expired pass
        account_status: "ACTIVE",
        is_boarded: false,
        face_registered: true,
        face_embedding: generateCanonicalFaceEmbedding("STU-DEMO-003"),
        face_enrollment_status: "FACE_REENROLLMENT_REQUIRED" as const,
        face_registered_at: new Date(Date.now() - 86400000 * 3).toISOString(),
        face_reregistration_status: "NONE",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        student_id: "STU-DEMO-004",
        name: "Casey Patel",
        email: "casey.patel@example.com",
        phone: "+91 00000 00000",
        department: "Computer Science & Engineering",
        year: "2nd Year",
        semester: "3rd Sem",
        bus_id: "BUS-01",
        pickup_location: "DC Office",
        fee_total: 35000,
        fee_paid: 35000,
        fee_pending: 0,
        fee_status: "PAID",
        fee_valid_until: "2027-05-31",
        account_status: "ACTIVE",
        is_boarded: false,
        face_registered: true,
        face_embedding: generateCanonicalFaceEmbedding("STU-DEMO-004"),
        face_enrollment_status: "FACE_REENROLLMENT_REQUIRED" as const,
        face_registered_at: new Date(Date.now() - 86400000 * 4).toISOString(),
        face_reregistration_status: "NONE",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]
    for (const s of initialStudents) {
      this.students.set(s.student_id, s)
    }

    const initialDrivers: DriverDoc[] = [
      {
        username: "driver1",
        name: "Morgan Driver",
        email: "driver1@smartbus.transit.org",
        phone: "+91 00000 00000",
        license_number: "KA-34-DL-98211",
        assigned_bus: "BUS-01",
        account_status: "ACTIVE",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        username: "driver2",
        name: "Riley Driver",
        email: "driver2@smartbus.transit.org",
        phone: "+91 00000 00000",
        license_number: "KA-34-DL-77402",
        assigned_bus: "BUS-03",
        account_status: "ACTIVE",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]
    for (const d of initialDrivers) {
      this.drivers.set(d.username, d)
    }

    const initialBuses: BusDoc[] = [
      {
        bus_id: "BUS-01",
        bus_number: "BUS-01",
        bus_name: "BUS-01 (Route A — Cantonment to Main Campus)",
        registration_number: "DEMO-BUS-01",
        plate_number: "DEMO-BUS-01",
        route: "Route A (Cantonment to Main Campus)",
        stops: ["Main Campus Gate", "City Circle", "Bus Terminal"],
        capacity: 40,
        passengers: 28,
        driver_id: "driver1",
        driver_name: "Morgan Driver",
        status: "IN_TRANSIT",
        latitude: 15.1394,
        longitude: 76.9214,
        speed: 36.2,
        heading: 85,
        area: "Ballari Cantonment",
        city: "Ballari",
        state: "Karnataka",
        country: "India",
        last_gps_time: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        bus_id: "BUS-03",
        bus_number: "BUS-03",
        bus_name: "BUS-03 (Route B — Gandhi Nagar to Siruguppa Rd)",
        registration_number: "DEMO-BUS-03",
        plate_number: "DEMO-BUS-03",
        route: "Route B (Gandhi Nagar - Siruguppa Rd)",
        stops: ["Main Campus Gate", "DC Office", "Siruguppa Cross"],
        capacity: 35,
        passengers: 18,
        driver_id: "driver2",
        driver_name: "Riley Driver",
        status: "ACTIVE",
        latitude: 15.148,
        longitude: 76.928,
        speed: 22.0,
        heading: 120,
        area: "Gandhi Nagar",
        city: "Ballari",
        state: "Karnataka",
        country: "India",
        last_gps_time: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        bus_id: "BUS-07",
        bus_number: "BUS-07",
        bus_name: "BUS-07 (Route C — Railway Station to Campus Hub)",
        registration_number: "DEMO-BUS-07",
        plate_number: "DEMO-BUS-07",
        route: "Route C (Railway Station to Campus Hub)",
        stops: ["Railway Colony", "City Center", "Campus Hub"],
        capacity: 30,
        passengers: 12,
        driver_id: null,
        driver_name: "Unassigned",
        status: "ACTIVE",
        latitude: 15.125,
        longitude: 76.915,
        speed: 0,
        heading: 0,
        area: "Railway Colony",
        city: "Ballari",
        state: "Karnataka",
        country: "India",
        last_gps_time: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]
    for (const b of initialBuses) {
      this.buses.set(b.bus_id, b)
    }

    const initialFees: FeeDoc[] = [
      {
        student_id: "STU-DEMO-001",
        student_name: "Alex Morgan",
        email: "alex.morgan@example.com",
        bus_id: "BUS-01",
        academic_year: "2026-2027",
        fee_total: 35000,
        fee_paid: 35000,
        fee_pending: 0,
        fee_status: "PAID",
        payment_date: "2026-08-15",
        valid_until: "2027-05-31",
        updated_at: new Date().toISOString(),
      },
      {
        student_id: "STU-DEMO-002",
        student_name: "Taylor Reed",
        email: "taylor.reed@example.com",
        bus_id: "BUS-03",
        academic_year: "2026-2027",
        fee_total: 38000,
        fee_paid: 20000,
        fee_pending: 18000,
        fee_status: "PARTIAL",
        payment_date: "2026-08-20",
        valid_until: "2027-05-31",
        updated_at: new Date().toISOString(),
      },
      {
        student_id: "STU-DEMO-003",
        student_name: "Jordan Lee",
        email: "jordan.lee@example.com",
        bus_id: "BUS-01",
        academic_year: "2026-2027",
        fee_total: 32000,
        fee_paid: 0,
        fee_pending: 32000,
        fee_status: "PENDING",
        payment_date: null,
        valid_until: "2026-01-01",
        updated_at: new Date().toISOString(),
      },
      {
        student_id: "STU-DEMO-004",
        student_name: "Casey Patel",
        email: "casey.patel@example.com",
        bus_id: "BUS-01",
        academic_year: "2026-2027",
        fee_total: 35000,
        fee_paid: 35000,
        fee_pending: 0,
        fee_status: "PAID",
        payment_date: "2026-08-10",
        valid_until: "2027-05-31",
        updated_at: new Date().toISOString(),
      },
    ]
    for (const f of initialFees) {
      this.fees.set(f.student_id, f)
    }

    this.attendance = [
      {
        student_id: "STU-DEMO-001",
        name: "Alex Morgan",
        bus_id: "BUS-01",
        route: "Route A (Cantonment to Main Campus)",
        driver: "Morgan Driver",
        plate_number: "DEMO-BUS-01",
        stop: "Main Campus Gate",
        fee_status: "PAID",
        event_type: "BOARDED",
        status: "BOARDED",
        date: "2026-09-17",
        time: "08:15 AM",
        timestamp: new Date().toISOString(),
      },
      {
        student_id: "STU-DEMO-002",
        name: "Taylor Reed",
        bus_id: "BUS-03",
        route: "Route B (Gandhi Nagar - Siruguppa Rd)",
        driver: "Riley Driver",
        plate_number: "DEMO-BUS-03",
        stop: "City Centre Circle",
        fee_status: "PARTIAL",
        event_type: "BOARDED",
        status: "BOARDED",
        date: "2026-09-17",
        time: "08:22 AM",
        timestamp: new Date().toISOString(),
      },
    ]

    const nowIso = new Date().toISOString()

    this.initialized = true
    this.saveToDisk()
  }

  saveToDisk() {
    try {
      const dataDir = path.join(process.cwd(), "data")
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true })
      }
      const dataFilePath = path.join(dataDir, "transit_db.json")
      const payload = {
        users: Array.from(this.users.entries()),
        students: Array.from(this.students.entries()),
        drivers: Array.from(this.drivers.entries()),
        buses: Array.from(this.buses.entries()),
        fees: Array.from(this.fees.entries()),
        devices: Array.from(this.devices.entries()),
        attendance: this.attendance,
        gpsLocations: this.gpsLocations,
        faceRequests: Array.from(this.faceRequests.entries()),
        boardedTripKeys: Array.from(this.boardedTripKeys),
        exitedTripKeys: Array.from(this.exitedTripKeys),
        processedEventIds: Array.from(this.processedEventIds),
        savedAt: new Date().toISOString(),
      }
      fs.writeFileSync(dataFilePath, JSON.stringify(payload, null, 2), "utf8")
    } catch (err) {
      console.error("[LocalStore] Failed to persist data to disk:", err)
      throw new Error(
        "Local persistence failed. The operation cannot be considered durable.",
        { cause: err }
      )
    }
  }

  loadFromDisk(): boolean {
    try {
      const dataFilePath = path.join(process.cwd(), "data", "transit_db.json")
      if (!fs.existsSync(dataFilePath)) return false
      const raw = fs.readFileSync(dataFilePath, "utf8")
      const parsed = JSON.parse(raw)
      if (!parsed || !parsed.users) return false

      this.users = new Map(parsed.users)
      this.students = new Map(parsed.students)
      this.drivers = new Map(parsed.drivers)
      this.buses = new Map(parsed.buses)
      this.fees = new Map(parsed.fees)
      if (parsed.devices) {
        this.devices = new Map(parsed.devices)
      }
      if (Array.isArray(parsed.processedEventIds)) {
        this.processedEventIds = new Set(
          parsed.processedEventIds.filter(
            (id: unknown): id is string => typeof id === "string"
          )
        )
      }

      if (Array.isArray(parsed.boardedTripKeys)) {
        this.boardedTripKeys = new Set(
          parsed.boardedTripKeys.filter(
            (key: unknown): key is string => typeof key === "string"
          )
        )
      }

      if (Array.isArray(parsed.exitedTripKeys)) {
        this.exitedTripKeys = new Set(
          parsed.exitedTripKeys.filter(
            (key: unknown): key is string => typeof key === "string"
          )
        )
      }

      // IoT devices must be registered explicitly; no default API keys.
            this.initialized = true
      return true
    } catch (err) {
      console.error("[LocalStore] Failed to load persisted data:", err)
      throw new Error(
        "Local persistence could not be loaded. Refusing to initialize fresh data.",
        { cause: err }
      )
    }
  }
}

const memoryFallback = new MemoryDataStore()

// Atlas is intentionally never seeded or mutated during connection setup.
// Schema/index creation and any migration must be an explicit operator action.

async function ensureLocalFallbackInitialized() {
  if (memoryFallback.initialized) return

  const loaded = memoryFallback.loadFromDisk()
  if (!loaded) await memoryFallback.seed()
}

// Use Atlas when configured. The local store is only selected before any
// connection attempt, so authentication/network failures cannot be reported
// as successful local writes.
export async function withMongo<T>(
  action: (db: Db) => Promise<T>,
  fallbackAction: (store: MemoryDataStore) => Promise<T> | T
): Promise<T> {
  const uri = process.env.MONGODB_URI?.trim()
  if (!uri) {
    await ensureLocalFallbackInitialized()
    const result = await fallbackAction(memoryFallback)
    memoryFallback.saveToDisk()
    return result
  }

  const client = await getMongoClientPromise()
  const db = client.db(DEFAULT_DB)
  return await action(db)
}

export { memoryFallback }
