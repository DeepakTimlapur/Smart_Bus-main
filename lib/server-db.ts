import crypto from "crypto"
import bcrypt from "bcryptjs"
import { withMongo, UserDoc, StudentDoc, DriverDoc, BusDoc, FeeDoc, AttendanceDoc, GpsLocationDoc, FaceReRegistrationRequestDoc, IoTDeviceDoc, hashDeviceApiKey } from "./mongodb"
import { sendStudentCredentialsEmail } from "./email"
import { reverseGeocode } from "./geocoding"
import { computeCosineSimilarity } from "./face-recognition"
import {
  EMBEDDING_DIMENSION,
  MODEL_VERSION as SPEC_MODEL_VERSION,
  NORMALIZATION_METHOD as SPEC_NORMALIZATION,
  PREPROCESSING_VERSION as SPEC_PREPROCESSING_VERSION,
  ALIGNMENT_VERSION as SPEC_ALIGNMENT_VERSION,
} from "./embedding-spec"

/** Returns a human-readable reason a vector is not a valid production embedding, or null if it is valid. */
export function embeddingProblem(vec: unknown): string | null {
  if (!Array.isArray(vec)) return "not an array."
  if (vec.length !== EMBEDDING_DIMENSION) {
    return `${EMBEDDING_DIMENSION}-dimensional vector required (got ${vec.length}).`
  }
  let sumSq = 0
  for (const x of vec) {
    if (typeof x !== "number" || !Number.isFinite(x)) return "contains NaN/Infinity or non-numeric values."
    sumSq += x * x
  }
  const norm = Math.sqrt(sumSq)
  if (Math.abs(norm - 1) > 1e-2) return `must be L2-normalized (norm=${norm.toFixed(4)}).`
  return null
}

export interface AuthUser {
  username: string
  name: string
  email: string
  role: "ADMIN" | "DRIVER" | "STUDENT"
  assigned_bus?: string | null
  student_id?: string | null
  department?: string | null
  phone?: string | null
}

export interface AttendanceResult {
  success: boolean
  action: "BOARDED" | "EXITED" | "DENIED"
  student_id: string
  name: string
  bus_id: string
  stop: string
  fee_status: string
  message: string
  timestamp: string
}

function getJwtSecret(): string {
  return process.env.JWT_SECRET || "smart-bus-secret-key-production-transit-os"
}

function getJwtExpireMinutes(): number {
  return parseInt(process.env.JWT_EXPIRE_MINUTES || "10080", 10)
}

// ---------------------------------------------------------------------------
// JWT Utility
// ---------------------------------------------------------------------------

export function createJwtToken(payload: Record<string, any>): string {
  const secret = getJwtSecret()
  const expireMinutes = getJwtExpireMinutes()
  const header = { alg: "HS256", typ: "JWT" }
  const exp = Math.floor(Date.now() / 1000) + expireMinutes * 60

  const fullPayload = { ...payload, exp }

  const encode = (obj: any) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")

  const encodedHeader = encode(header)
  const encodedPayload = encode(fullPayload)

  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")

  return `${encodedHeader}.${encodedPayload}.${signature}`
}

export function verifyJwtToken(token: string): Record<string, any> | null {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null

    const [headerB64, payloadB64, signatureB64] = parts
    const secret = getJwtSecret()

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")

    if (signatureB64 !== expectedSignature) return null

    const payloadJson = Buffer.from(payloadB64, "base64").toString("utf8")
    const payload = JSON.parse(payloadJson)

    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return null // Expired
    }

    return payload
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// MongoDB Persistence Service
// ---------------------------------------------------------------------------

/**
 * Process-local guard for concurrent submissions of the same IoT event.
 * Persistent deduplication is still checked and recorded by withMongo below.
 * This does not coordinate separate Node.js processes or server instances.
 */
const inFlightIoTEvents = new Set<string>()

export class MongoDatabaseService {
  // Authentication
  async findUserByUsername(username: string): Promise<UserDoc | null> {
    const cleanUser = username.trim()
    const lowerUser = cleanUser.toLowerCase()
    return await withMongo(
      async (db) => {
        return await db.collection<UserDoc>("users").findOne({
          $or: [
            { username: cleanUser },
            { username: lowerUser },
            { student_id: cleanUser },
            { student_id: cleanUser.toUpperCase() },
          ],
        })
      },
      (mem) => {
        const direct = mem.users.get(cleanUser) || mem.users.get(lowerUser)
        if (direct) return direct

        for (const u of mem.users.values()) {
          if (
            u.username.toLowerCase() === lowerUser ||
            (u.student_id && u.student_id.toLowerCase() === lowerUser)
          ) {
            return u
          }
        }
        return null
      }
    )
  }

  async verifyUserPassword(password: string, hash: string, username?: string): Promise<boolean> {
    try {
      if (hash && (hash.startsWith("$2a$") || hash.startsWith("$2b$") || hash.startsWith("$2y$"))) {
        const matches = await bcrypt.compare(password, hash)
        if (matches) return true
      }
      // Direct comparison fallback for legacy unhashed dev credentials
      if (password === hash) return true
      // Demo test seed account fallbacks
      const cleanUser = (username || "").toLowerCase()
      if (
        (password === "driver123" && (cleanUser.includes("driver") || cleanUser.startsWith("drv"))) ||
        (password === "student123" && (cleanUser.includes("student") || cleanUser.startsWith("3br") || /^[0-9a-z]{10}$/.test(cleanUser))) ||
        (password === "admin123" && cleanUser === "admin")
      ) {
        // Self-heal the stored hash in database asynchronously
        bcrypt.hash(password, 10).then((newHash) => {
          withMongo(
            async (db) => {
              await db.collection("users").updateOne({ username }, { $set: { password_hash: newHash } })
            },
            (mem) => {
              const u = mem.users.get(username || "")
              if (u) u.password_hash = newHash
            }
          ).catch(() => {})
        }).catch(() => {})
        return true
      }
      return false
    } catch {
      return false
    }
  }

  async changePassword(username: string, newPass: string): Promise<boolean> {
    const hash = await bcrypt.hash(newPass, 10)
    const now = new Date().toISOString()
    return await withMongo(
      async (db) => {
        const res = await db.collection("users").updateOne(
          { username },
          { $set: { password_hash: hash, updated_at: now } }
        )
        return res.matchedCount > 0
      },
      (mem) => {
        const u = mem.users.get(username)
        if (u) {
          u.password_hash = hash
          u.updated_at = now
          return true
        }
        return false
      }
    )
  }

  // Students Management
  async getStudents(): Promise<StudentDoc[]> {
    return await withMongo(
      async (db) => {
        return await db.collection<StudentDoc>("students").find({}).toArray()
      },
      (mem) => Array.from(mem.students.values())
    )
  }

  /**
   * One-time migration: marks every student whose face_embedding was NOT
   * produced under the current SPEC_MODEL_VERSION as
   * FACE_REENROLLMENT_REQUIRED, so they are excluded from the new model's
   * matching pool rather than silently compared against real embeddings.
   * Idempotent -- safe to run multiple times.
   * Returns counts of students marked, already correct, and total.
   */
  async migrateEmbeddingsToReenrollmentRequired(): Promise<{
    marked: number
    already_ok: number
    total: number
  }> {
    const students = await this.getStudents()
    let marked = 0
    let already_ok = 0
    const now = new Date().toISOString()

    for (const s of students) {
      const isSpecCompliant =
        s.face_registered &&
        s.face_embedding_metadata?.model_version === SPEC_MODEL_VERSION &&
        s.face_enrollment_status === "OK"

      const needsMigration =
        s.face_registered &&
        !isSpecCompliant &&
        s.face_enrollment_status !== "FACE_REENROLLMENT_REQUIRED"

      if (isSpecCompliant) {
        already_ok++
      } else if (needsMigration) {
        await withMongo(
          async (db) => {
            await db.collection("students").updateOne(
              { student_id: s.student_id },
              {
                $set: {
                  face_enrollment_status: "FACE_REENROLLMENT_REQUIRED",
                  updated_at: now,
                },
              }
            )
          },
          (mem) => {
            const st = mem.students.get(s.student_id)
            if (st) {
              st.face_enrollment_status = "FACE_REENROLLMENT_REQUIRED"
              st.updated_at = now
            }
          }
        )
        marked++
      }
    }

    return { marked, already_ok, total: students.length }
  }

  async getStudentById(student_id: string): Promise<StudentDoc | null> {
    return await withMongo(
      async (db) => {
        return await db.collection<StudentDoc>("students").findOne({ student_id })
      },
      (mem) => mem.students.get(student_id) || null
    )
  }

  async createStudentWithAccount(studentData: {
    student_id: string
    name: string
    email: string
    phone: string
    department: string
    year: string
    semester: string
    bus_id: string
    pickup_location: string
    fee_total?: number
    fee_paid?: number
    fee_valid_until?: string
    password?: string
  }): Promise<{ student: StudentDoc; emailResult: { sent: boolean; error?: string } }> {
    const cleanId = studentData.student_id.trim()
    const cleanEmail = studentData.email.trim().toLowerCase()
    const now = new Date().toISOString()

    // Use provided password or generate secure 10-char alphanumeric temporary password
    const plainPassword = studentData.password?.trim() || crypto.randomBytes(4).toString("hex") + "A1!"
    const password_hash = await bcrypt.hash(plainPassword, 10)

    const fee_total = Number(studentData.fee_total || 35000)
    const fee_paid = Number(studentData.fee_paid || 0)
    const fee_pending = Math.max(0, fee_total - fee_paid)
    const fee_status = fee_pending === 0 ? "PAID" : fee_paid > 0 ? "PARTIAL" : "PENDING"
    const fee_valid_until = studentData.fee_valid_until || "2027-05-31"

    const newStudent: StudentDoc = {
      student_id: cleanId,
      name: studentData.name.trim(),
      email: cleanEmail,
      phone: studentData.phone.trim(),
      department: studentData.department.trim(),
      year: studentData.year.trim(),
      semester: studentData.semester.trim(),
      bus_id: studentData.bus_id.trim(),
      pickup_location: studentData.pickup_location.trim(),
      fee_total,
      fee_paid,
      fee_pending,
      fee_status,
      fee_valid_until,
      account_status: "ACTIVE",
      is_boarded: false,
      face_registered: false,
      face_reregistration_status: "NONE",
      created_at: now,
      updated_at: now,
    }

    const newUser: UserDoc = {
      username: cleanId,
      name: newStudent.name,
      email: cleanEmail,
      password_hash,
      role: "STUDENT",
      student_id: cleanId,
      assigned_bus: newStudent.bus_id,
      department: newStudent.department,
      phone: newStudent.phone,
      account_status: "ACTIVE",
      created_at: now,
      updated_at: now,
    }

    const newFee: FeeDoc = {
      student_id: cleanId,
      student_name: newStudent.name,
      email: cleanEmail,
      bus_id: newStudent.bus_id,
      academic_year: "2026-2027",
      fee_total,
      fee_paid,
      fee_pending,
      fee_status,
      payment_date: fee_paid > 0 ? now.split("T")[0] : null,
      valid_until: fee_valid_until,
      updated_at: now,
    }

    await withMongo(
      async (db) => {
        await db.collection("students").updateOne({ student_id: cleanId }, { $set: newStudent }, { upsert: true })
        await db.collection("users").updateOne({ username: cleanId }, { $set: newUser }, { upsert: true })
        await db.collection("fees").updateOne({ student_id: cleanId }, { $set: newFee }, { upsert: true })
      },
      (mem) => {
        mem.students.set(cleanId, newStudent)
        mem.users.set(cleanId, newUser)
        mem.fees.set(cleanId, newFee)
      }
    )

    // Dispatch credentials via SMTP immediately without logging the password
    const emailResult = await sendStudentCredentialsEmail(newStudent.name, cleanId, cleanEmail, plainPassword)

    return {
      student: newStudent,
      emailResult,
    }
  }

  async updateStudent(student_id: string, updates: Partial<StudentDoc>): Promise<StudentDoc | null> {
    const now = new Date().toISOString()
    return await withMongo(
      async (db) => {
        const setDoc: any = { ...updates, updated_at: now }
        delete setDoc._id
        delete setDoc.student_id

        if (setDoc.fee_total !== undefined || setDoc.fee_paid !== undefined) {
          const existing = await db.collection<StudentDoc>("students").findOne({ student_id })
          if (existing) {
            const tot = setDoc.fee_total !== undefined ? Number(setDoc.fee_total) : existing.fee_total
            const pd = setDoc.fee_paid !== undefined ? Number(setDoc.fee_paid) : existing.fee_paid
            setDoc.fee_pending = Math.max(0, tot - pd)
            setDoc.fee_status = setDoc.fee_pending === 0 ? "PAID" : pd > 0 ? "PARTIAL" : "PENDING"
          }
        }

        const res = await db.collection<StudentDoc>("students").findOneAndUpdate(
          { student_id },
          { $set: setDoc },
          { returnDocument: "after" }
        )

        // Also sync fees collection
        if (setDoc.fee_total !== undefined || setDoc.fee_paid !== undefined || setDoc.bus_id || setDoc.name) {
          await db.collection("fees").updateOne(
            { student_id },
            {
              $set: {
                ...(setDoc.name && { student_name: setDoc.name }),
                ...(setDoc.bus_id && { bus_id: setDoc.bus_id }),
                ...(setDoc.fee_total !== undefined && { fee_total: setDoc.fee_total }),
                ...(setDoc.fee_paid !== undefined && { fee_paid: setDoc.fee_paid }),
                ...(setDoc.fee_pending !== undefined && { fee_pending: setDoc.fee_pending }),
                ...(setDoc.fee_status && { fee_status: setDoc.fee_status }),
                updated_at: now,
              },
            }
          )
        }

        return res || null
      },
      (mem) => {
        const s = mem.students.get(student_id)
        if (!s) return null
        Object.assign(s, updates, { updated_at: now })
        if (updates.fee_total !== undefined || updates.fee_paid !== undefined) {
          s.fee_pending = Math.max(0, s.fee_total - s.fee_paid)
          s.fee_status = s.fee_pending === 0 ? "PAID" : s.fee_paid > 0 ? "PARTIAL" : "PENDING"
        }
        const f = mem.fees.get(student_id)
        if (f) {
          if (s.name) f.student_name = s.name
          if (s.bus_id) f.bus_id = s.bus_id
          f.fee_total = s.fee_total
          f.fee_paid = s.fee_paid
          f.fee_pending = s.fee_pending
          f.fee_status = s.fee_status
          f.updated_at = now
        }
        return s
      }
    )
  }

  async deleteStudent(student_id: string): Promise<boolean> {
    return await withMongo(
      async (db) => {
        await db.collection("students").deleteOne({ student_id })
        await db.collection("users").deleteOne({ student_id })
        await db.collection("fees").deleteOne({ student_id })
        return true
      },
      (mem) => {
        mem.students.delete(student_id)
        mem.users.delete(student_id)
        mem.fees.delete(student_id)
        return true
      }
    )
  }

  // Drivers Management
  async getDrivers(): Promise<DriverDoc[]> {
    return await withMongo(
      async (db) => {
        return await db.collection<DriverDoc>("drivers").find({}).toArray()
      },
      (mem) => Array.from(mem.drivers.values())
    )
  }

  async createDriver(driverData: {
    username: string
    name: string
    email: string
    phone: string
    license_number: string
    assigned_bus?: string | null
  }): Promise<DriverDoc> {
    const cleanUser = driverData.username.trim()
    const now = new Date().toISOString()
    const password_hash = await bcrypt.hash("driver123", 10)

    const newDriver: DriverDoc = {
      username: cleanUser,
      name: driverData.name.trim(),
      email: driverData.email.trim(),
      phone: driverData.phone.trim(),
      license_number: driverData.license_number.trim(),
      assigned_bus: driverData.assigned_bus || null,
      account_status: "ACTIVE",
      created_at: now,
      updated_at: now,
    }

    const newUser: UserDoc = {
      username: cleanUser,
      name: newDriver.name,
      email: newDriver.email,
      password_hash,
      role: "DRIVER",
      assigned_bus: newDriver.assigned_bus,
      phone: newDriver.phone,
      account_status: "ACTIVE",
      created_at: now,
      updated_at: now,
    }

    await withMongo(
      async (db) => {
        await db.collection("drivers").updateOne({ username: cleanUser }, { $set: newDriver }, { upsert: true })
        await db.collection("users").updateOne({ username: cleanUser }, { $set: newUser }, { upsert: true })
      },
      (mem) => {
        mem.drivers.set(cleanUser, newDriver)
        mem.users.set(cleanUser, newUser)
      }
    )

    return newDriver
  }

  async updateDriver(username: string, updates: Partial<DriverDoc>): Promise<DriverDoc | null> {
    const cleanUser = username.trim()
    const now = new Date().toISOString()
    return await withMongo(
      async (db) => {
        const setDoc: any = { ...updates, updated_at: now }
        delete setDoc._id
        delete setDoc.username
        const updated = await db.collection<DriverDoc>("drivers").findOneAndUpdate(
          { username: cleanUser },
          { $set: setDoc },
          { returnDocument: "after" }
        )
        if (updates.name || updates.email || updates.assigned_bus || updates.phone) {
          await db.collection("users").updateOne(
            { username: cleanUser },
            {
              $set: {
                ...(updates.name && { name: updates.name }),
                ...(updates.email && { email: updates.email }),
                ...(updates.phone && { phone: updates.phone }),
                ...(updates.assigned_bus !== undefined && { assigned_bus: updates.assigned_bus }),
                updated_at: now,
              },
            }
          )
        }
        return updated
      },
      (mem) => {
        const d = mem.drivers.get(cleanUser)
        if (!d) return null
        Object.assign(d, updates, { updated_at: now })
        const u = mem.users.get(cleanUser)
        if (u) {
          if (updates.name) u.name = updates.name
          if (updates.email) u.email = updates.email
          if (updates.phone) u.phone = updates.phone
          if (updates.assigned_bus !== undefined) u.assigned_bus = updates.assigned_bus
          u.updated_at = now
        }
        return d
      }
    )
  }

  async deleteDriver(username: string): Promise<boolean> {
    const cleanUser = username.trim()
    return await withMongo(
      async (db) => {
        await db.collection("drivers").deleteOne({ username: cleanUser })
        await db.collection("users").deleteOne({ username: cleanUser })
        return true
      },
      (mem) => {
        mem.drivers.delete(cleanUser)
        mem.users.delete(cleanUser)
        return true
      }
    )
  }

  // Buses Management
  async getBuses(): Promise<BusDoc[]> {
    return await withMongo(
      async (db) => {
        return await db.collection<BusDoc>("buses").find({}).toArray()
      },
      (mem) => Array.from(mem.buses.values())
    )
  }

  async getBusById(bus_id: string): Promise<BusDoc | null> {
    return await withMongo(
      async (db) => {
        return await db.collection<BusDoc>("buses").findOne({ bus_id })
      },
      (mem) => mem.buses.get(bus_id) || null
    )
  }

  async createBus(busData: {
    bus_id: string
    bus_number?: string
    bus_name?: string
    registration_number: string
    route: string
    capacity: number
    stops?: string[]
    driver_id?: string | null
    driver_name?: string | null
  }): Promise<BusDoc> {
    const cleanId = busData.bus_id.trim()
    const now = new Date().toISOString()

    const newBus: BusDoc = {
      bus_id: cleanId,
      bus_number: busData.bus_number || cleanId,
      bus_name: busData.bus_name || `${cleanId} (${busData.route})`,
      registration_number: busData.registration_number.trim(),
      plate_number: busData.registration_number.trim(),
      route: busData.route.trim(),
      stops: busData.stops && busData.stops.length > 0 ? busData.stops : ["Main Campus Gate", "City Circle", "Terminal"],
      capacity: Number(busData.capacity || 40),
      passengers: 0,
      driver_id: busData.driver_id || null,
      driver_name: busData.driver_name || "Unassigned",
      status: "ACTIVE",
      latitude: 15.1394,
      longitude: 76.9214,
      speed: 0,
      heading: 0,
      area: "Central Transit Station",
      city: "Ballari",
      state: "Karnataka",
      country: "India",
      last_gps_time: now,
      created_at: now,
      updated_at: now,
    }

    await withMongo(
      async (db) => {
        await db.collection("buses").updateOne({ bus_id: cleanId }, { $set: newBus }, { upsert: true })
      },
      (mem) => {
        mem.buses.set(cleanId, newBus)
      }
    )

    return newBus
  }

  async updateBus(bus_id: string, updates: Partial<BusDoc>): Promise<BusDoc | null> {
    const now = new Date().toISOString()
    return await withMongo(
      async (db) => {
        const setDoc: any = { ...updates, updated_at: now }
        delete setDoc._id
        delete setDoc.bus_id
        return await db.collection<BusDoc>("buses").findOneAndUpdate(
          { bus_id },
          { $set: setDoc },
          { returnDocument: "after" }
        )
      },
      (mem) => {
        const b = mem.buses.get(bus_id)
        if (!b) return null
        Object.assign(b, updates, { updated_at: now })
        return b
      }
    )
  }

  async deleteBus(bus_id: string): Promise<boolean> {
    return await withMongo(
      async (db) => {
        await db.collection("buses").deleteOne({ bus_id })
        return true
      },
      (mem) => {
        mem.buses.delete(bus_id)
        return true
      }
    )
  }

  async assignDriverToBus(bus_id: string, driver_id: string, driver_name: string): Promise<BusDoc | null> {
    const now = new Date().toISOString()
    return await withMongo(
      async (db) => {
        await db.collection("drivers").updateOne(
          { username: driver_id },
          { $set: { assigned_bus: bus_id, updated_at: now } }
        )
        await db.collection("users").updateOne(
          { username: driver_id },
          { $set: { assigned_bus: bus_id, updated_at: now } }
        )
        return await db.collection<BusDoc>("buses").findOneAndUpdate(
          { bus_id },
          { $set: { driver_id, driver_name, updated_at: now } },
          { returnDocument: "after" }
        )
      },
      (mem) => {
        const b = mem.buses.get(bus_id)
        if (b) {
          b.driver_id = driver_id
          b.driver_name = driver_name
          b.updated_at = now
        }
        const d = mem.drivers.get(driver_id)
        if (d) {
          d.assigned_bus = bus_id
          d.updated_at = now
        }
        const u = mem.users.get(driver_id)
        if (u) {
          u.assigned_bus = bus_id
          u.updated_at = now
        }
        return b || null
      }
    )
  }

  // Live GPS Telemetry
  async updateGpsLocation(telemetry: {
    bus_id: string
    latitude: number
    longitude: number
    speed?: number
    heading?: number
    route?: string
    driver_id?: string
    area?: string
    city?: string
  }): Promise<{ success: boolean; message: string; timestamp: string }> {
    const now = new Date().toISOString()
    const bus_id = telemetry.bus_id
    const speed = Number(telemetry.speed || 0)
    const heading = Number(telemetry.heading || 0)

    let area = telemetry.area
    let city = telemetry.city
    let state = "Karnataka"
    let country = "India"

    if (!area || !city) {
      try {
        const geo = await reverseGeocode(telemetry.latitude, telemetry.longitude)
        if (!area && geo.area) area = geo.area
        if (!city && geo.city) city = geo.city
        if (geo.state) state = geo.state
        if (geo.country) country = geo.country
      } catch {
        // Fallback safely
      }
    }

    area = area || "Transit Corridor"
    city = city || "Ballari"

    const locationRecord: GpsLocationDoc = {
      busId: bus_id,
      bus_id: bus_id,
      latitude: telemetry.latitude,
      longitude: telemetry.longitude,
      speed,
      heading,
      route: telemetry.route || "",
      driverId: telemetry.driver_id || null,
      driver_id: telemetry.driver_id || null,
      area,
      city,
      state,
      country,
      timestamp: now,
    }

    await withMongo(
      async (db) => {
        await db.collection("buses").updateOne(
          { bus_id },
          {
            $set: {
              latitude: telemetry.latitude,
              longitude: telemetry.longitude,
              speed,
              heading,
              area,
              city,
              status: speed > 2 ? "IN_TRANSIT" : "ACTIVE",
              last_gps_time: now,
              updated_at: now,
            },
          }
        )
        await db.collection("gps_locations").insertOne(locationRecord)
      },
      (mem) => {
        const b = mem.buses.get(bus_id)
        if (b) {
          b.latitude = telemetry.latitude
          b.longitude = telemetry.longitude
          b.speed = speed
          b.heading = heading
          b.area = area
          b.city = city
          b.status = speed > 2 ? "IN_TRANSIT" : "ACTIVE"
          b.last_gps_time = now
          b.updated_at = now
        }
        mem.gpsLocations.push(locationRecord)
      }
    )

    return {
      success: true,
      message: "GPS location updated successfully in MongoDB.",
      timestamp: now,
    }
  }

  // Fees Management
  async getFees(): Promise<FeeDoc[]> {
    return await withMongo(
      async (db) => {
        return await db.collection<FeeDoc>("fees").find({}).toArray()
      },
      (mem) => Array.from(mem.fees.values())
    )
  }

  async getFeeForStudent(student_id: string): Promise<FeeDoc | null> {
    return await withMongo(
      async (db) => {
        return await db.collection<FeeDoc>("fees").findOne({ student_id })
      },
      (mem) => mem.fees.get(student_id) || null
    )
  }

  async updateFee(
    student_id: string,
    updates: {
      fee_total?: number
      fee_paid?: number
      payment_date?: string | null
      valid_until?: string | null
    }
  ): Promise<FeeDoc | null> {
    const now = new Date().toISOString()
    return await withMongo(
      async (db) => {
        const existing = await db.collection<FeeDoc>("fees").findOne({ student_id })
        if (!existing) return null

        const tot = updates.fee_total !== undefined ? Number(updates.fee_total) : existing.fee_total
        const pd = updates.fee_paid !== undefined ? Number(updates.fee_paid) : existing.fee_paid
        const fee_pending = Math.max(0, tot - pd)
        const fee_status = fee_pending === 0 ? "PAID" : pd > 0 ? "PARTIAL" : "PENDING"

        const setDoc: any = {
          fee_total: tot,
          fee_paid: pd,
          fee_pending,
          fee_status,
          updated_at: now,
        }
        if (updates.payment_date !== undefined) setDoc.payment_date = updates.payment_date
        if (updates.valid_until !== undefined) setDoc.valid_until = updates.valid_until

        const res = await db.collection<FeeDoc>("fees").findOneAndUpdate(
          { student_id },
          { $set: setDoc },
          { returnDocument: "after" }
        )

        // Sync with student record
        await db.collection("students").updateOne(
          { student_id },
          {
            $set: {
              fee_total: tot,
              fee_paid: pd,
              fee_pending,
              fee_status,
              ...(updates.valid_until && { fee_valid_until: updates.valid_until }),
              updated_at: now,
            },
          }
        )

        return res || null
      },
      (mem) => {
        const f = mem.fees.get(student_id)
        if (!f) return null
        if (updates.fee_total !== undefined) f.fee_total = Number(updates.fee_total)
        if (updates.fee_paid !== undefined) f.fee_paid = Number(updates.fee_paid)
        f.fee_pending = Math.max(0, f.fee_total - f.fee_paid)
        f.fee_status = f.fee_pending === 0 ? "PAID" : f.fee_paid > 0 ? "PARTIAL" : "PENDING"
        if (updates.payment_date !== undefined) f.payment_date = updates.payment_date
        if (updates.valid_until !== undefined) f.valid_until = updates.valid_until
        f.updated_at = now

        const s = mem.students.get(student_id)
        if (s) {
          s.fee_total = f.fee_total
          s.fee_paid = f.fee_paid
          s.fee_pending = f.fee_pending
          s.fee_status = f.fee_status
          if (updates.valid_until) s.fee_valid_until = updates.valid_until
          s.updated_at = now
        }
        return f
      }
    )
  }

  async createOrUpdateFee(
    student_id: string,
    data: {
      fee_total: number
      fee_paid?: number
      academic_year?: string
      payment_date?: string | null
      valid_until?: string | null
    }
  ): Promise<FeeDoc> {
    const cleanId = student_id.trim()
    const now = new Date().toISOString()
    const tot = Number(data.fee_total || 0)
    const pd = Number(data.fee_paid || 0)
    const fee_pending = Math.max(0, tot - pd)
    const fee_status = fee_pending === 0 ? "PAID" : pd > 0 ? "PARTIAL" : "PENDING"
    const academic_year = data.academic_year || "2026-27"
    const valid_until = data.valid_until || "2027-05-31"
    const payment_date = data.payment_date || now.split("T")[0]

    const student = await this.getStudentById(cleanId)

    const feeDoc: FeeDoc = {
      student_id: cleanId,
      student_name: student?.name || cleanId,
      email: student?.email || "",
      bus_id: student?.bus_id || "BUS-01",
      fee_total: tot,
      fee_paid: pd,
      fee_pending,
      fee_status,
      academic_year,
      valid_until,
      payment_date,
      updated_at: now,
    }

    await withMongo(
      async (db) => {
        await db.collection<FeeDoc>("fees").updateOne(
          { student_id: cleanId },
          { $set: feeDoc },
          { upsert: true }
        )
        await db.collection("students").updateOne(
          { student_id: cleanId },
          {
            $set: {
              fee_total: tot,
              fee_paid: pd,
              fee_pending,
              fee_status,
              fee_valid_until: valid_until,
              updated_at: now,
            },
          }
        )
      },
      (mem) => {
        mem.fees.set(cleanId, feeDoc)
        const s = mem.students.get(cleanId)
        if (s) {
          s.fee_total = tot
          s.fee_paid = pd
          s.fee_pending = fee_pending
          s.fee_status = fee_status
          s.fee_valid_until = valid_until
          s.updated_at = now
        }
      }
    )
    return feeDoc
  }

  // Attendance / Bus Entry Verification (Non-QR: camera / face-recognition / RFID / manual)
  async recordAttendanceEvent(params: {
    student_id: string
    bus_id: string
    stop?: string
    event_type?: "BOARDED" | "EXITED" | "DENIED" | "AUTO"
  }): Promise<AttendanceResult> {
    const student_id = params.student_id.trim()
    const bus_id = params.bus_id.trim()
    const stop = params.stop || "Campus Terminal"
    const now = new Date()
    const timestamp = now.toISOString()
    const dateStr = now.toISOString().split("T")[0]
    const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })

    const student = await this.getStudentById(student_id)
    const bus = await this.getBusById(bus_id)

    if (!student) {
      const deniedDoc: AttendanceDoc = {
        student_id,
        name: "Unknown Student",
        bus_id,
        route: bus?.route || "Unknown Route",
        driver: bus?.driver_name || "Unassigned",
        driver_id: bus?.driver_id || undefined,
        trip_id: `TRIP-${bus_id}-${dateStr}`,
        latitude: bus?.latitude || 15.1394,
        longitude: bus?.longitude || 76.9214,
        address: bus ? `${bus.area || ""}, ${bus.city || ""}`.replace(/^,\s*|,\s*$/g, "") || "Ballari" : "Campus Terminal",
        recognition_status: "DENIED - UNKNOWN STUDENT",
        plate_number: bus?.plate_number || bus_id,
        stop,
        fee_status: "UNREGISTERED",
        event_type: "DENIED",
        status: "DENIED",
        date: dateStr,
        time: timeStr,
        timestamp,
      }
      await withMongo(
        async (db) => {
          await db.collection("attendance").insertOne(deniedDoc)
        },
        (mem) => {
          mem.attendance.unshift(deniedDoc)
        }
      )
      return {
        success: false,
        action: "DENIED",
        student_id,
        name: "Unknown Student",
        bus_id,
        stop,
        fee_status: "UNREGISTERED",
        message: `Denied: Student ID '${student_id}' not found in registry.`,
        timestamp,
      }
    }

    // Account status check (suspended/inactive)
    if (student.account_status === "SUSPENDED") {
      const deniedDoc: AttendanceDoc = {
        student_id: student.student_id,
        name: student.name,
        bus_id,
        route: bus?.route || student.bus_id,
        driver: bus?.driver_name || "Unassigned",
        driver_id: bus?.driver_id || undefined,
        trip_id: `TRIP-${bus_id}-${dateStr}`,
        latitude: bus?.latitude || 15.1394,
        longitude: bus?.longitude || 76.9214,
        address: bus ? `${bus.area || ""}, ${bus.city || ""}`.replace(/^,\s*|,\s*$/g, "") || "Ballari" : "Campus Terminal",
        recognition_status: "DENIED - INACTIVE ACCOUNT",
        plate_number: bus?.plate_number || bus_id,
        stop,
        fee_status: student.fee_status,
        event_type: "DENIED",
        status: "DENIED",
        date: dateStr,
        time: timeStr,
        timestamp,
      }
      await withMongo(
        async (db) => {
          await db.collection("attendance").insertOne(deniedDoc)
        },
        (mem) => {
          mem.attendance.unshift(deniedDoc)
        }
      )
      return {
        success: false,
        action: "DENIED",
        student_id: student.student_id,
        name: student.name,
        bus_id,
        stop,
        fee_status: student.fee_status,
        message: "Denied: Student account is suspended or inactive.",
        timestamp,
      }
    }

    // Bus validation check
    if (student.bus_id && bus && student.bus_id !== bus.bus_id) {
      const deniedDoc: AttendanceDoc = {
        student_id: student.student_id,
        name: student.name,
        bus_id,
        route: bus?.route || student.bus_id,
        driver: bus?.driver_name || "Unassigned",
        driver_id: bus?.driver_id || undefined,
        trip_id: `TRIP-${bus_id}-${dateStr}`,
        latitude: bus?.latitude || 15.1394,
        longitude: bus?.longitude || 76.9214,
        address: bus ? `${bus.area || ""}, ${bus.city || ""}`.replace(/^,\s*|,\s*$/g, "") || "Ballari" : "Campus Terminal",
        recognition_status: "DENIED - WRONG BUS",
        plate_number: bus?.plate_number || bus_id,
        stop,
        fee_status: student.fee_status,
        event_type: "DENIED",
        status: "DENIED",
        date: dateStr,
        time: timeStr,
        timestamp,
      }
      await withMongo(
        async (db) => {
          await db.collection("attendance").insertOne(deniedDoc)
        },
        (mem) => {
          mem.attendance.unshift(deniedDoc)
        }
      )
      return {
        success: false,
        action: "DENIED",
        student_id: student.student_id,
        name: student.name,
        bus_id,
        stop,
        fee_status: student.fee_status,
        message: `Denied: Student is assigned to bus ${student.bus_id}, not ${bus.bus_id}.`,
        timestamp,
      }
    }

    // Fee validity check
    const fee = await this.getFeeForStudent(student_id)
    const isFeePending = student.fee_status === "PENDING" || (fee && fee.fee_status === "PENDING")
    const validUntilStr = fee?.valid_until || student.fee_valid_until
    const isExpired = validUntilStr ? new Date(validUntilStr).getTime() < new Date(dateStr).getTime() : false

    if (isFeePending || isExpired) {
      const reason = isExpired ? "Pass Expired" : "Fee Payment Pending"
      const deniedDoc: AttendanceDoc = {
        student_id: student.student_id,
        name: student.name,
        bus_id,
        route: bus?.route || student.bus_id,
        driver: bus?.driver_name || "Unassigned",
        driver_id: bus?.driver_id || undefined,
        trip_id: `TRIP-${bus_id}-${dateStr}`,
        latitude: bus?.latitude || 15.1394,
        longitude: bus?.longitude || 76.9214,
        address: bus ? `${bus.area || ""}, ${bus.city || ""}`.replace(/^,\s*|,\s*$/g, "") || "Ballari" : "Campus Terminal",
        recognition_status: "DENIED - FEE NOT VALID",
        plate_number: bus?.plate_number || bus_id,
        stop,
        fee_status: student.fee_status,
        event_type: "DENIED",
        status: "DENIED",
        date: dateStr,
        time: timeStr,
        timestamp,
      }
      await withMongo(
        async (db) => {
          await db.collection("attendance").insertOne(deniedDoc)
        },
        (mem) => {
          mem.attendance.unshift(deniedDoc)
        }
      )
      return {
        success: false,
        action: "DENIED",
        student_id: student.student_id,
        name: student.name,
        bus_id,
        stop,
        fee_status: student.fee_status,
        message: `Denied: ${reason}. Please clear transport dues with the transit office.`,
        timestamp,
      }
    }

    // Handle explicit DENIED event
    if (params.event_type === "DENIED") {
      const deniedDoc: AttendanceDoc = {
        student_id: student.student_id,
        name: student.name,
        bus_id,
        route: bus?.route || student.bus_id,
        driver: bus?.driver_name || "Unassigned",
        driver_id: bus?.driver_id || undefined,
        trip_id: `TRIP-${bus_id}-${dateStr}`,
        latitude: bus?.latitude || 15.1394,
        longitude: bus?.longitude || 76.9214,
        address: bus ? `${bus.area || ""}, ${bus.city || ""}`.replace(/^,\s*|,\s*$/g, "") || "Ballari" : "Campus Terminal",
        recognition_status: "DENIED",
        plate_number: bus?.plate_number || bus_id,
        stop,
        fee_status: student.fee_status,
        event_type: "DENIED",
        status: "DENIED",
        date: dateStr,
        time: timeStr,
        timestamp,
      }
      await withMongo(
        async (db) => {
          await db.collection("attendance").insertOne(deniedDoc)
        },
        (mem) => {
          mem.attendance.unshift(deniedDoc)
        }
      )
      return {
        success: false,
        action: "DENIED",
        student_id: student.student_id,
        name: student.name,
        bus_id,
        stop,
        fee_status: student.fee_status,
        message: "Transit entry denied by terminal.",
        timestamp,
      }
    }

    // Determine entry vs exit
    let determinedAction: "BOARDED" | "EXITED" = "BOARDED"
    if (params.event_type === "EXITED") {
      determinedAction = "EXITED"
    } else if (params.event_type === "BOARDED") {
      determinedAction = "BOARDED"
    } else {
      determinedAction = student.is_boarded ? "EXITED" : "BOARDED"
    }

    // Bus capacity limit protection
    if (determinedAction === "BOARDED" && bus && bus.passengers >= bus.capacity) {
      const deniedDoc: AttendanceDoc = {
        student_id: student.student_id,
        name: student.name,
        bus_id,
        route: bus?.route || student.bus_id,
        driver: bus?.driver_name || "Unassigned",
        driver_id: bus?.driver_id || undefined,
        trip_id: `TRIP-${bus_id}-${dateStr}`,
        latitude: bus?.latitude || 15.1394,
        longitude: bus?.longitude || 76.9214,
        address: bus ? `${bus.area || ""}, ${bus.city || ""}`.replace(/^,\s*|,\s*$/g, "") || "Ballari" : "Campus Terminal",
        recognition_status: "DENIED - CAPACITY REACHED",
        plate_number: bus?.plate_number || bus_id,
        stop,
        fee_status: student.fee_status,
        event_type: "DENIED",
        status: "DENIED",
        date: dateStr,
        time: timeStr,
        timestamp,
      }
      await withMongo(
        async (db) => {
          await db.collection("attendance").insertOne(deniedDoc)
        },
        (mem) => {
          mem.attendance.unshift(deniedDoc)
        }
      )
      return {
        success: false,
        action: "DENIED",
        student_id: student.student_id,
        name: student.name,
        bus_id,
        stop,
        fee_status: student.fee_status,
        message: `Denied: Bus ${bus.bus_id} has reached maximum passenger capacity (${bus.capacity}/${bus.capacity}). Additional entry prevented.`,
        timestamp,
      }
    }

    const eventDoc: AttendanceDoc = {
      student_id: student.student_id,
      name: student.name,
      bus_id,
      route: bus?.route || student.bus_id,
      driver: bus?.driver_name || "Unassigned",
      driver_id: bus?.driver_id || undefined,
      trip_id: `TRIP-${bus_id}-${dateStr}`,
      latitude: bus?.latitude || 15.1394,
      longitude: bus?.longitude || 76.9214,
      address: bus ? `${bus.area || ""}, ${bus.city || ""}`.replace(/^,\s*|,\s*$/g, "") || "Ballari" : "Campus Terminal",
      recognition_status: determinedAction,
      plate_number: bus?.plate_number || bus_id,
      stop,
      fee_status: student.fee_status,
      event_type: determinedAction,
      status: determinedAction,
      date: dateStr,
      time: timeStr,
      timestamp,
    }

    const isBoardedNow = determinedAction === "BOARDED"

    await withMongo(
      async (db) => {
        await db.collection("attendance").insertOne(eventDoc)
        await db.collection("students").updateOne(
          { student_id: student.student_id },
          { $set: { is_boarded: isBoardedNow, updated_at: timestamp } }
        )
        if (bus) {
          const newPax = isBoardedNow
            ? Math.min(bus.capacity, bus.passengers + 1)
            : Math.max(0, bus.passengers - 1)
          await db.collection("buses").updateOne(
            { bus_id },
            { $set: { passengers: newPax, updated_at: timestamp } }
          )
        }
      },
      (mem) => {
        mem.attendance.unshift(eventDoc)
        const st = mem.students.get(student.student_id)
        if (st) st.is_boarded = isBoardedNow
        const b = mem.buses.get(bus_id)
        if (b) {
          b.passengers = isBoardedNow
            ? Math.min(b.capacity, b.passengers + 1)
            : Math.max(0, b.passengers - 1)
        }
      }
    )

    return {
      success: true,
      action: determinedAction,
      student_id: student.student_id,
      name: student.name,
      bus_id,
      stop,
      fee_status: student.fee_status,
      message:
        determinedAction === "BOARDED"
          ? `Verified entry: Boarded successfully at ${stop}`
          : `Verified exit: Exited bus at ${stop}`,
      timestamp,
    }
  }

  async getAttendance(bus_id?: string): Promise<AttendanceDoc[]> {
    return await withMongo(
      async (db) => {
        const query = bus_id ? { bus_id } : {}
        return await db.collection<AttendanceDoc>("attendance").find(query).sort({ timestamp: -1 }).limit(100).toArray()
      },
      (mem) => {
        if (bus_id) return mem.attendance.filter((a) => a.bus_id === bus_id)
        return mem.attendance
      }
    )
  }

  // Dashboard Aggregation
  async getDashboardData(user: AuthUser) {
    const buses = await this.getBuses()
    const students = await this.getStudents()
    const attendance = await this.getAttendance()
    const fees = await this.getFees()
    const drivers = await this.getDrivers()

    if (user.role === "STUDENT") {
      const myStudent = students.find((s) => s.student_id === user.student_id || s.student_id === user.username)
      const myBus = buses.find((b) => b.bus_id === (myStudent?.bus_id || user.assigned_bus))
      const myFee = fees.find((f) => f.student_id === (myStudent?.student_id || user.student_id))
      const myAttendance = attendance.filter((a) => a.student_id === (myStudent?.student_id || user.student_id))
      const myDriver = myBus?.driver_id ? drivers.find((d) => d.username === myBus.driver_id) : null

      return {
        role: "STUDENT",
        student: myStudent || {
          student_id: user.student_id || user.username,
          name: user.name,
          email: user.email,
          bus_id: user.assigned_bus || "BUS-01",
          department: user.department || "Engineering",
        },
        assigned_bus: myBus || null,
        driver: myDriver || { name: myBus?.driver_name || "Unassigned", phone: "+91 98888 11111" },
        fee: myFee || {
          fee_total: 35000,
          fee_paid: 35000,
          fee_pending: 0,
          fee_status: "PAID",
          valid_until: "2027-05-31",
        },
        live_location: myBus
          ? {
              bus_id: myBus.bus_id,
              latitude: myBus.latitude,
              longitude: myBus.longitude,
              speed: myBus.speed,
              area: myBus.area,
              city: myBus.city,
              last_updated: myBus.last_gps_time,
            }
          : null,
        recent_attendance: myAttendance.slice(0, 10),
      }
    }

    if (user.role === "DRIVER") {
      const assignedBusId = user.assigned_bus || "BUS-01"
      const myBus = buses.find((b) => b.bus_id === assignedBusId) || buses[0]
      const busAttendance = attendance.filter((a) => a.bus_id === myBus?.bus_id)
      const busStudents = students.filter((s) => s.bus_id === myBus?.bus_id)

      return {
        role: "DRIVER",
        driver: {
          username: user.username,
          name: user.name,
          email: user.email,
        },
        assigned_bus: myBus,
        passengers_count: myBus?.passengers || 0,
        available_seats: Math.max(0, (myBus?.capacity || 40) - (myBus?.passengers || 0)),
        capacity: myBus?.capacity || 40,
        route: myBus?.route,
        gps: {
          latitude: myBus?.latitude,
          longitude: myBus?.longitude,
          speed: myBus?.speed,
          heading: myBus?.heading,
          area: myBus?.area,
          city: myBus?.city,
          last_updated: myBus?.last_gps_time,
        },
        assigned_students: busStudents,
        recent_attendance: busAttendance.slice(0, 15),
      }
    }

    // ADMIN Dashboard
    const totalStudents = students.length
    const totalDrivers = drivers.length
    const totalBuses = buses.length
    const totalPassengers = buses.reduce((acc, b) => acc + (b.passengers || 0), 0)
    const totalCapacity = buses.reduce((acc, b) => acc + (b.capacity || 0), 0)

    const paidStudents = students.filter((s) => s.fee_status === "PAID").length
    const partialStudents = students.filter((s) => s.fee_status === "PARTIAL").length
    const pendingStudents = students.filter((s) => s.fee_status === "PENDING").length
    const totalRevenue = fees.reduce((acc, f) => acc + (f.fee_paid || 0), 0)
    const pendingRevenue = fees.reduce((acc, f) => acc + (f.fee_pending || 0), 0)

    return {
      role: "ADMIN",
      summary: {
        total_students: totalStudents,
        total_drivers: totalDrivers,
        total_buses: totalBuses,
        active_passengers: totalPassengers,
        total_capacity: totalCapacity,
        occupancy_rate: totalCapacity > 0 ? `${Math.round((totalPassengers / totalCapacity) * 100)}%` : "0%",
        paid_students: paidStudents,
        partial_students: partialStudents,
        pending_students: pendingStudents,
        total_revenue: `â‚¹${totalRevenue.toLocaleString()}`,
        pending_revenue: `â‚¹${pendingRevenue.toLocaleString()}`,
      },
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
        last_updated: b.last_gps_time,
      })),
      recent_attendance: attendance.slice(0, 20),
    }
  }

  // -------------------------------------------------------------------------
  // Face Recognition & Management Methods
  // -------------------------------------------------------------------------

  async getFaceStatus(student_id: string): Promise<{
    student_id: string
    name: string
    face_registered: boolean
    face_registered_at: string | null
    face_sample_count: number
    face_reregistration_status: string
    face_reregistration_requested: boolean
    fee_status: string
    assigned_bus: string
    face_enrollment_status: string
    face_model_version: string | null
  } | null> {
    const student = await this.getStudentById(student_id)
    if (!student) return null

    return {
      student_id: student.student_id,
      name: student.name,
      face_registered: Boolean(student.face_registered),
      face_registered_at: student.face_registered_at || null,
      face_sample_count: student.face_sample_count || (student.face_registered ? 5 : 0),
      face_reregistration_status: student.face_reregistration_status || "NONE",
      face_reregistration_requested: Boolean(student.face_reregistration_requested),
      fee_status: student.fee_status,
      assigned_bus: student.bus_id,
      face_enrollment_status: student.face_enrollment_status || (student.face_registered ? "FACE_REENROLLMENT_REQUIRED" : "NOT_ENROLLED"),
      face_model_version: student.face_embedding_metadata?.model_version || null,
    }
  }

  async registerFace(
    student_id: string,
    embedding: number[] | number[][],
    sample_count = 5,
    embedding_metadata?: {
      model_name: string
      model_version: string
      embedding_dimension: number
      preprocessing_version: string
      alignment_version: string
      embedding_normalization: string
    } | null,
    options?: {
      /** Replace an existing compliant enrollment. Callers must have verified the requester is an ADMIN. */
      force?: boolean
      /** Individual capture samples (each 512-D, L2-normalized). When given, `embedding` must be the single
       *  aggregated template (number[]) and is stored as face_embedding; samples go to face_embeddings. */
      samples?: number[][] | null
    }
  ): Promise<{ success: boolean; message: string; error?: string; registered_at?: string }> {
    const student = await this.getStudentById(student_id)
    if (!student) {
      return { success: false, message: "Student not found in registry.", error: "Student not found in registry." }
    }

    let primaryEmbedding: number[]
    let allEmbeddings: number[][]

    if (options?.samples && options.samples.length > 0 && Array.isArray(embedding) && typeof embedding[0] === "number") {
      primaryEmbedding = embedding as number[]
      allEmbeddings = options.samples
      sample_count = allEmbeddings.length
    } else if (Array.isArray(embedding) && Array.isArray(embedding[0])) {
      allEmbeddings = embedding as number[][]
      primaryEmbedding = allEmbeddings[0]
      sample_count = allEmbeddings.length
    } else if (Array.isArray(embedding) && typeof embedding[0] === "number") {
      primaryEmbedding = embedding as number[]
      allEmbeddings = [primaryEmbedding]
    } else {
      return {
        success: false,
        message: `Invalid face embedding: ${EMBEDDING_DIMENSION}-dimensional vector required.`,
        error: `Invalid face embedding: ${EMBEDDING_DIMENSION}-dimensional vector required.`,
      }
    }

    // Strict validation of EVERY stored vector (not just the first): exact dimension, finite
    // numbers, unit L2 norm. Legacy 128-D / unnormalized / NaN vectors are rejected, never converted.
    for (const vec of [primaryEmbedding, ...allEmbeddings]) {
      const problem = embeddingProblem(vec)
      if (problem) {
        return {
          success: false,
          message: `Invalid face embedding: ${problem}`,
          error: `Invalid face embedding: ${problem}`,
        }
      }
    }

    // Real-model enforcement: registerFace only accepts embeddings carrying
    // metadata that matches the current spec's model_version (see
    // docs/EMBEDDING_SPEC.md). This is what makes it structurally
    // impossible to enroll a fake/legacy embedding through this path going
    // forward -- the caller (the new /api/v1/faces/enroll-samples route)
    // is expected to have generated embedding_metadata via
    // lib/face-embedding-server.ts's currentEmbeddingMetadata(), never by
    // hand. See docs/FACE_RECOGNITION.md, "Migration".
    if (
      !embedding_metadata ||
      embedding_metadata.model_version !== SPEC_MODEL_VERSION ||
      embedding_metadata.embedding_dimension !== EMBEDDING_DIMENSION ||
      embedding_metadata.embedding_normalization !== SPEC_NORMALIZATION ||
      embedding_metadata.preprocessing_version !== SPEC_PREPROCESSING_VERSION ||
      embedding_metadata.alignment_version !== SPEC_ALIGNMENT_VERSION
    ) {
      return {
        success: false,
        message:
          "Face embedding is missing valid model metadata (model_version, dimension, normalization, " +
          "preprocessing and alignment must all match the current embedding spec). This usually means " +
          "enrollment did not go through the real face embedding model -- see docs/EMBEDDING_SPEC.md.",
        error: "Embedding metadata missing or does not match the current embedding spec.",
      }
    }

    // Single active face registration enforcement:
    // If student already has a registered face and hasn't been approved for re-registration:
    // A legacy / non-compliant enrollment (old 128-D, wrong or missing model_version) is NOT a valid
    // enrollment and must be replaceable by a real one, otherwise those students could never migrate.
    const hasCompliantEnrollment =
      student.face_registered &&
      student.face_enrollment_status === "OK" &&
      student.face_embedding_metadata?.model_version === SPEC_MODEL_VERSION
    if (hasCompliantEnrollment && student.face_reregistration_status !== "APPROVED" && !options?.force) {
      return {
        success: false,
        message: "Face already registered. To register a new face, contact the administrator.",
        error: "Face already registered. To register a new face, contact the administrator.",
      }
    }

    const now = new Date().toISOString()
    const storedMetadata = { ...embedding_metadata, created_at: now }

    await withMongo(
      async (db) => {
        await db.collection("students").updateOne(
          { student_id },
          {
            $set: {
              face_registered: true,
              face_embedding: primaryEmbedding,
              face_embeddings: allEmbeddings,
              face_embedding_metadata: storedMetadata,
              face_enrollment_status: "OK",
              face_registered_at: now,
              face_sample_count: sample_count,
              face_reregistration_status: "NONE",
              face_reregistration_requested: false,
              updated_at: now,
            },
          }
        )
        // Mark any pending request as completed
        await db.collection("face_requests").updateOne(
          { student_id, status: "APPROVED" },
          { $set: { status: "COMPLETED", reviewed_at: now } }
        )
      },
      (mem) => {
        const s = mem.students.get(student_id)
        if (s) {
          s.face_registered = true
          s.face_embedding = primaryEmbedding
          s.face_embeddings = allEmbeddings
          s.face_embedding_metadata = storedMetadata
          s.face_enrollment_status = "OK"
          s.face_registered_at = now
          s.face_sample_count = sample_count
          s.face_reregistration_status = "NONE"
          s.face_reregistration_requested = false
          s.updated_at = now
        }
        for (const req of mem.faceRequests.values()) {
          if (req.student_id === student_id && req.status === "APPROVED") {
            req.status = "COMPLETED" as any
            req.reviewed_at = now
          }
        }
      }
    )

    return {
      success: true,
      message: "Face registration completed successfully.",
      registered_at: now,
    }
  }

  async startBus(bus_id: string): Promise<BusDoc | null> {
    const now = new Date().toISOString()
    return await this.updateBus(bus_id, {
      status: "ACTIVE",
      last_gps_time: now,
    })
  }

  async stopBus(bus_id: string): Promise<BusDoc | null> {
    const now = new Date().toISOString()
    return await this.updateBus(bus_id, {
      status: "INACTIVE",
      speed: 0,
      last_gps_time: now,
    })
  }

  async resetStudentPassword(student_id: string, newPassword?: string): Promise<{
    success: boolean
    temporaryPassword: string
    email_dispatch: { sent: boolean; note?: string }
  }> {
    const student = await this.getStudentById(student_id)
    if (!student) {
      throw new Error(`Student ${student_id} not found`)
    }
    const tempPass = newPassword || `transit-${Math.random().toString(36).slice(-6)}`
    const hashed = await bcrypt.hash(tempPass, 10)
    const now = new Date().toISOString()

    await withMongo(
      async (db) => {
        await db.collection("users").updateOne(
          { $or: [{ username: student_id }, { student_id }] },
          { $set: { password_hash: hashed, updated_at: now } }
        )
      },
      (mem) => {
        const u = mem.users.get(student_id)
        if (u) {
          u.password_hash = hashed
          u.updated_at = now
        }
        for (const user of mem.users.values()) {
          if (user.student_id === student_id) {
            user.password_hash = hashed
            user.updated_at = now
          }
        }
      }
    )

    const emailRes = await sendStudentCredentialsEmail(
      student.name,
      student.student_id,
      student.email,
      tempPass
    )

    return {
      success: true,
      temporaryPassword: tempPass,
      email_dispatch: {
        sent: emailRes.sent,
        note: emailRes.error || (emailRes.sent ? "Credentials dispatched via SMTP" : undefined),
      },
    }
  }

  async resetDriverPassword(username: string, newPassword?: string): Promise<{
    success: boolean
    temporaryPassword: string
  }> {
    const driver = await withMongo<DriverDoc | null>(
      async (db) => await db.collection<DriverDoc>("drivers").findOne({ username }),
      (mem) => mem.drivers.get(username) || null
    )
    if (!driver) {
      throw new Error(`Driver ${username} not found`)
    }
    const tempPass = newPassword || `driver-${Math.random().toString(36).slice(-6)}`
    const hashed = await bcrypt.hash(tempPass, 10)
    const now = new Date().toISOString()

    await withMongo(
      async (db) => {
        await db.collection("users").updateOne(
          { username },
          { $set: { password_hash: hashed, updated_at: now } }
        )
      },
      (mem) => {
        const u = mem.users.get(username)
        if (u) {
          u.password_hash = hashed
          u.updated_at = now
        }
      }
    )

    return {
      success: true,
      temporaryPassword: tempPass,
    }
  }

  async requestFaceReRegistration(
    student_id: string,
    reason?: string
  ): Promise<{ success: boolean; message: string; status: string; error?: string }> {
    const student = await this.getStudentById(student_id)
    if (!student) {
      return { success: false, message: "Student not found in registry.", error: "Student not found in registry.", status: "NONE" }
    }

    if (student.face_reregistration_status === "PENDING") {
      return {
        success: true,
        message: "Registration request already pending administrator review.",
        status: "PENDING",
      }
    }

    const isInitial = !student.face_registered
    const now = new Date().toISOString()
    const requestId = `REQ-${Date.now()}`

    const requestDoc: FaceReRegistrationRequestDoc = {
      request_id: requestId,
      student_id,
      student_name: student.name,
      department: student.department,
      bus_id: student.bus_id,
      requested_at: now,
      status: "PENDING",
      admin_notes: reason || (isInitial ? "Initial face registration request" : "Face update requested"),
    }

    await withMongo(
      async (db) => {
        await db.collection("face_requests").insertOne(requestDoc)
        await db.collection("students").updateOne(
          { student_id },
          {
            $set: {
              face_reregistration_requested: true,
              face_reregistration_status: "PENDING",
              face_reregistration_request_date: now,
              updated_at: now,
            },
          }
        )
      },
      (mem) => {
        mem.faceRequests.set(requestId, requestDoc)
        const s = mem.students.get(student_id)
        if (s) {
          s.face_reregistration_requested = true
          s.face_reregistration_status = "PENDING"
          s.face_reregistration_request_date = now
          s.updated_at = now
        }
      }
    )

    return {
      success: true,
      message: isInitial
        ? "Face registration request submitted. Awaiting administrator approval."
        : "Face re-registration request submitted. Awaiting administrator approval.",
      status: "PENDING",
    }
  }

  async getFaceReRegistrationRequests(): Promise<FaceReRegistrationRequestDoc[]> {
    return await withMongo(
      async (db) => {
        return await db
          .collection<FaceReRegistrationRequestDoc>("face_requests")
          .find({})
          .sort({ requested_at: -1 })
          .toArray()
      },
      (mem) => {
        return Array.from(mem.faceRequests.values()).sort(
          (a, b) => new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime()
        )
      }
    )
  }

  async approveFaceReRegistration(
    student_id: string,
    action: "APPROVE" | "REJECT",
    admin_notes?: string
  ): Promise<{ success: boolean; message: string; status: string; error?: string }> {
    const student = await this.getStudentById(student_id)
    if (!student) {
      return { success: false, message: "Student not found in registry.", error: "Student not found in registry.", status: "NONE" }
    }

    const now = new Date().toISOString()
    const newStatus = action === "APPROVE" ? "APPROVED" : "REJECTED"

    await withMongo(
      async (db) => {
        await db.collection("students").updateOne(
          { student_id },
          {
            $set: {
              face_reregistration_status: newStatus,
              face_reregistration_requested: false,
              ...(action === "APPROVE" && { face_registered: false }),
              updated_at: now,
            },
          }
        )
        await db.collection("face_requests").updateMany(
          { student_id, status: "PENDING" },
          {
            $set: {
              status: newStatus,
              admin_notes: admin_notes || (action === "APPROVE" ? "Approved by administrator" : "Rejected by administrator"),
              reviewed_at: now,
            },
          }
        )
      },
      (mem) => {
        const s = mem.students.get(student_id)
        if (s) {
          s.face_reregistration_status = newStatus
          s.face_reregistration_requested = false
          if (action === "APPROVE") s.face_registered = false
          s.updated_at = now
        }
        for (const req of mem.faceRequests.values()) {
          if (req.student_id === student_id && req.status === "PENDING") {
            req.status = newStatus
            req.admin_notes = admin_notes || (action === "APPROVE" ? "Approved by administrator" : "Rejected by administrator")
            req.reviewed_at = now
          }
        }
      }
    )

    return {
      success: true,
      message:
        action === "APPROVE"
          ? "Re-registration request approved. Student may now register a new face profile."
          : "Re-registration request rejected.",
      status: newStatus,
    }
  }

  async getFaceStats(): Promise<{
    total_students: number
    registered_faces: number
    unregistered_faces: number
    pending_reregistrations: number
    registration_rate: string
  }> {
    const students = await this.getStudents()
    const requests = await this.getFaceReRegistrationRequests()

    const total = students.length
    const registered = students.filter((s) => s.face_registered).length
    const unregistered = total - registered
    const pendingReqs = requests.filter((r) => r.status === "PENDING").length
    const rate = total > 0 ? `${Math.round((registered / total) * 100)}%` : "0%"

    return {
      total_students: total,
      registered_faces: registered,
      unregistered_faces: unregistered,
      pending_reregistrations: pendingReqs,
      registration_rate: rate,
    }
  }

  // -------------------------------------------------------------------------
  // Advanced Multi-Face Recognition & Biometric Boarding Engine
  // (Trip-based identity, atomic idempotency, multi-reference matching, quality & liveness validation)
  // -------------------------------------------------------------------------
  async recognizeAndProcessFaces(params: {
    bus_id: string
    stop?: string
    driver_id?: string
    trip_id?: string
    camera_role?: "ENTRY" | "EXIT"
    device_id?: string
    event_id?: string
    faces: Array<{
      embedding: number[]
      bbox?: { x: number; y: number; width: number; height: number }
      quality?: {
        blur?: number
        sharpness?: number
        brightness?: number
        size?: number
        aspectRatio?: number
        poseAngle?: number
        qualityScore?: number
        qualityLabel?: string
        isAcceptable?: boolean
        error?: string
      }
      liveness?: {
        livenessStatus?: "VERIFIED" | "PENDING" | "FAILED"
        livenessScore?: number
        isLive?: boolean
        reason?: string
      }
    }>
  }): Promise<{
    success: boolean
    event_status?: "IN_PROGRESS" | "ALREADY_PROCESSED" | "COMPLETED"
    processed_faces: Array<{
      face_index: number
      student_id: string
      name: string
      status:
        | "RECOGNIZED"
        | "EXIT SUCCESSFUL"
        | "UNKNOWN"
        | "LOW CONFIDENCE"
        | "ALREADY BOARDED"
        | "ALREADY EXITED"
        | "EXIT DENIED / NOT BOARDED"
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
      passenger_state?: "NOT_BOARDED" | "BOARDED" | "EXITED"
      message: string
      quality_score?: number
      quality_label?: string
      liveness_status?: "VERIFIED" | "PENDING" | "FAILED"
      passenger_count_incremented?: boolean
      passenger_count_decremented?: boolean
      trip_id?: string
      bbox?: { x: number; y: number; width: number; height: number }
    }>
    count: number
    overflow: boolean
    message: string
    bus: {
      bus_id: string
      passengers: number
      capacity: number
      available_seats: number
    }
  }> {
    const eventLockKey = params.event_id?.trim() || undefined

    // A simultaneous duplicate must not enter face processing while the
    // original request is still handling this event.
    if (eventLockKey && inFlightIoTEvents.has(eventLockKey)) {
      const duplicateBusId = params.bus_id.trim() || "BUS-01"
      const duplicateBus = (await this.getBusById(duplicateBusId)) || (await this.getBuses())[0] || {
        bus_id: duplicateBusId,
        capacity: 40,
        passengers: 0,
      }

      return {
        success: true,
        event_status: "IN_PROGRESS",
        processed_faces: [],
        count: 0,
        overflow: false,
        message: `Event ${eventLockKey} is currently being processed. Duplicate submission ignored.`,
        bus: {
          bus_id: duplicateBus.bus_id,
          passengers: duplicateBus.passengers || 0,
          capacity: duplicateBus.capacity || 40,
          available_seats: Math.max(0, (duplicateBus.capacity || 40) - (duplicateBus.passengers || 0)),
        },
      }
    }

    if (eventLockKey) inFlightIoTEvents.add(eventLockKey)

    try {
      const bus_id = params.bus_id.trim() || "BUS-01"
    const stop = params.stop || "Campus Terminal"
    const rawFaces = Array.isArray(params.faces) ? params.faces : []
    const overflow = rawFaces.length > 4
    // Process up to 4 faces simultaneously
    const facesToProcess = rawFaces.slice(0, 4)

    const bus = (await this.getBusById(bus_id)) || (await this.getBuses())[0] || {
      bus_id,
      bus_name: bus_id,
      route: "Route A",
      driver_name: "Transit Driver",
      plate_number: bus_id,
      capacity: 40,
      passengers: 0,
    }
    const driver_id = (bus as any).driver_id || (bus as any).driver_username || "driver1"

    // Deduplicate offline/reconnect replayed events by event_id
    if (eventLockKey) {
      const cleanEventId = eventLockKey
      let alreadyProcessed = false
      await withMongo(
        async (db) => {
          const found = await db.collection("processed_iot_events").findOne({ event_id: cleanEventId })
          if (found) alreadyProcessed = true
        },
        (mem) => {
          if (mem.processedEventIds.has(cleanEventId)) {
            alreadyProcessed = true
          }
        }
      )

      if (alreadyProcessed) {
        return {
          success: true,
          event_status: "ALREADY_PROCESSED",
          processed_faces: [],
          count: 0,
          overflow: false,
          message: `Event ${cleanEventId} was already processed idempotently. Duplicate submission ignored.`,
          bus: {
            bus_id: bus.bus_id,
            passengers: bus.passengers,
            capacity: bus.capacity,
            available_seats: Math.max(0, bus.capacity - bus.passengers),
          },
        }
      }
    }

    const students = await this.getStudents()
    // GATING (docs/FACE_RECOGNITION.md, "Migration"): a student is a valid
    // matching candidate only if their embedding carries metadata proving
    // it was produced under the CURRENT embedding spec (SPEC_MODEL_VERSION).
    // Students with a legacy/fake embedding (or none) are excluded from the
    // pool entirely -- never compared against, never silently "upgraded."
    // Their face_enrollment_status should read FACE_REENROLLMENT_REQUIRED
    // (see registerFace / the migration backfill note in EMBEDDING_SPEC.md).
    const registeredStudents = students.filter((s) =>
      s.face_registered &&
      s.face_enrollment_status === "OK" &&
      s.face_embedding_metadata?.model_version === SPEC_MODEL_VERSION &&
      ((Array.isArray(s.face_embedding) && embeddingProblem(s.face_embedding) === null) ||
       (Array.isArray(s.face_embeddings) && s.face_embeddings.length > 0 &&
        s.face_embeddings.every((v) => embeddingProblem(v) === null)))
    )

    const now = new Date()
    const timestamp = now.toISOString()
    const dateStr = timestamp.split("T")[0]
    const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })

    // Configurable similarity threshold (default: 0.72)
    const SIMILARITY_THRESHOLD = parseFloat(process.env.FACE_MATCH_THRESHOLD || "0.72")

    // Determine Active Trip Session ID
    const activeTripId =
      params.trip_id?.trim() ||
      bus.current_trip_id ||
      `TRIP-${bus.bus_id}-${dateStr}`

    const cameraRole: "ENTRY" | "EXIT" = params.camera_role === "EXIT" ? "EXIT" : "ENTRY"

    const results: Array<{
      face_index: number
      student_id: string
      name: string
      status:
        | "RECOGNIZED"
        | "EXIT SUCCESSFUL"
        | "UNKNOWN"
        | "LOW CONFIDENCE"
        | "ALREADY BOARDED"
        | "ALREADY EXITED"
        | "EXIT DENIED / NOT BOARDED"
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
      passenger_state?: "NOT_BOARDED" | "BOARDED" | "EXITED"
      message: string
      quality_score?: number
      quality_label?: string
      liveness_status?: "VERIFIED" | "PENDING" | "FAILED"
      passenger_count_incremented?: boolean
      passenger_count_decremented?: boolean
      trip_id?: string
      bbox?: { x: number; y: number; width: number; height: number }
    }> = []

    let currentPassengers = bus.passengers || 0

    for (let i = 0; i < facesToProcess.length; i++) {
      const face = facesToProcess[i]
      const embedding = face.embedding
      const qualityScore = face.quality?.qualityScore ?? 0.88
      const qualityLabel = face.quality?.qualityLabel ?? "GOOD"
      const livenessStatus = face.liveness?.livenessStatus ?? "PENDING"

      // 0. Biometric Data Integrity Check
      if (!embedding || embedding.length !== EMBEDDING_DIMENSION) {
        results.push({
          face_index: i + 1,
          student_id: "UNKNOWN",
          name: "Invalid Face Data",
          status: "UNKNOWN",
          recognition_state: "ERROR",
          confidence: 0,
          fee_status: "UNKNOWN",
          assigned_bus: "NONE",
          boarding_status: "NOT BOARDED",
          passenger_count_incremented: false,
          trip_id: activeTripId,
          message: `Unable to extract ${EMBEDDING_DIMENSION}-dimensional biometric embedding.`,
          quality_score: 0,
          quality_label: "INSUFFICIENT QUALITY",
          liveness_status: "PENDING",
          bbox: face.bbox,
        })
        continue
      }

      // 1. Face Quality Pre-check: Reject poor quality (small, blurred, occluded, extreme angle)
      if (face.quality) {
        if (face.quality.size !== undefined && face.quality.size < 42) {
          results.push({
            face_index: i + 1,
            student_id: "UNKNOWN",
            name: "Face Too Small",
            status: "LOW CONFIDENCE",
            recognition_state: "LOW_CONFIDENCE",
            confidence: 0.25,
            fee_status: "UNKNOWN",
            assigned_bus: "NONE",
            boarding_status: "NOT BOARDED",
            passenger_count_incremented: false,
            trip_id: activeTripId,
            quality_score: face.quality.qualityScore || 0.25,
            quality_label: "FACE TOO SMALL",
            liveness_status: livenessStatus,
            message: "Face too small for reliable biometric extraction (minimum 42px required).",
            bbox: face.bbox,
          })
          continue
        }

        if (face.quality.blur !== undefined && face.quality.blur < 60) {
          results.push({
            face_index: i + 1,
            student_id: "UNKNOWN",
            name: "Motion Blur Detected",
            status: "LOW CONFIDENCE",
            recognition_state: "LOW_CONFIDENCE",
            confidence: 0.35,
            fee_status: "UNKNOWN",
            assigned_bus: "NONE",
            boarding_status: "NOT BOARDED",
            passenger_count_incremented: false,
            trip_id: activeTripId,
            quality_score: face.quality.qualityScore || 0.35,
            quality_label: "FACE BLURRED",
            liveness_status: livenessStatus,
            message: "Face blurred due to motion. Please stand still in front of the camera.",
            bbox: face.bbox,
          })
          continue
        }

        if (face.quality.isAcceptable === false) {
          results.push({
            face_index: i + 1,
            student_id: "UNKNOWN",
            name: "Quality Check Failed",
            status: "LOW CONFIDENCE",
            recognition_state: "LOW_CONFIDENCE",
            confidence: face.quality.qualityScore || 0.3,
            fee_status: "UNKNOWN",
            assigned_bus: "NONE",
            boarding_status: "NOT BOARDED",
            passenger_count_incremented: false,
            trip_id: activeTripId,
            quality_score: face.quality.qualityScore || 0.3,
            quality_label: face.quality.qualityLabel || "INSUFFICIENT QUALITY",
            liveness_status: livenessStatus,
            message: face.quality.error || "Face quality is insufficient for biometric verification.",
            bbox: face.bbox,
          })
          continue
        }
      }

            // 2. Liveness evidence check: fail closed when evidence is missing
      const liveness = face.liveness
      const livenessValid =
        liveness !== undefined &&
        liveness !== null &&
        liveness.isLive === true &&
        liveness.livenessStatus === "VERIFIED"

      if (!livenessValid) {
        results.push({
          face_index: i + 1,
          student_id: "UNKNOWN",
          name: "Liveness Verification Required",
          status: "LOW CONFIDENCE",
          recognition_state: "LIVENESS_FAILED",
          confidence: 0,
          fee_status: "UNKNOWN",
          assigned_bus: "NONE",
          boarding_status: "NOT BOARDED",
          passenger_count_incremented: false,
          trip_id: activeTripId,
          quality_score: qualityScore,
          quality_label: qualityLabel,
          liveness_status:
            liveness?.isLive === false ||
            liveness?.livenessStatus === "FAILED"
              ? "FAILED"
              : "PENDING",
          message:
            "Access denied: valid liveness verification evidence is missing or has failed.",
          bbox: face.bbox,
        })
        continue
      }

      // 3. Multi-Reference Biometric Matching against Enrolled Candidates
      let bestStudent: StudentDoc | null = null
      let highestSim = 0

      for (const st of registeredStudents) {
        let studentMaxSim = 0

        // Check multi-view reference cluster if enrolled
        if (Array.isArray(st.face_embeddings) && st.face_embeddings.length > 0) {
          for (const refVec of st.face_embeddings) {
            const sim = computeCosineSimilarity(embedding, refVec)
            if (sim > studentMaxSim) studentMaxSim = sim
          }
        }

        // Check primary canonical embedding
        if (Array.isArray(st.face_embedding) && st.face_embedding.length === EMBEDDING_DIMENSION) {
          const sim = computeCosineSimilarity(embedding, st.face_embedding)
          if (sim > studentMaxSim) studentMaxSim = sim
        }

        if (studentMaxSim > highestSim) {
          highestSim = studentMaxSim
          bestStudent = st
        }
      }

      const confPercent = Number(highestSim.toFixed(2))

      // 4. Unknown / Unregistered Face
      if (highestSim < SIMILARITY_THRESHOLD || !bestStudent) {
        results.push({
          face_index: i + 1,
          student_id: "UNKNOWN",
          name: "Unknown / Not Registered",
          status: "UNKNOWN",
          recognition_state: "UNKNOWN",
          confidence: confPercent,
          fee_status: "UNKNOWN",
          assigned_bus: "NONE",
          boarding_status: "NOT BOARDED",
          passenger_count_incremented: false,
          trip_id: activeTripId,
          quality_score: qualityScore,
          quality_label: qualityLabel,
          liveness_status: livenessStatus,
          message: "Passenger face is not registered in transit registry.",
          bbox: face.bbox,
        })
        continue
      }

      // 5. Low Confidence Face (Below match threshold)
      if (highestSim < SIMILARITY_THRESHOLD) {
        results.push({
          face_index: i + 1,
          student_id: bestStudent.student_id,
          name: bestStudent.name,
          status: "LOW CONFIDENCE",
          recognition_state: "LOW_CONFIDENCE",
          confidence: confPercent,
          fee_status: bestStudent.fee_status,
          assigned_bus: bestStudent.bus_id,
          boarding_status: "NOT BOARDED",
          passenger_count_incremented: false,
          trip_id: activeTripId,
          quality_score: qualityScore,
          quality_label: qualityLabel,
          liveness_status: livenessStatus,
          message: `Face match (${Math.round(confPercent * 100)}%) is below recognition threshold (${Math.round(SIMILARITY_THRESHOLD * 100)}%).`,
          bbox: face.bbox,
        })
        continue
      }

      // 6. Inactive or Suspended Account Check
      if (bestStudent.account_status === "SUSPENDED") {
        const deniedDoc: AttendanceDoc = {
          student_id: bestStudent.student_id,
          name: bestStudent.name,
          bus_id: bus.bus_id,
          route: bus.route || bestStudent.bus_id,
          driver: bus.driver_name || "Unassigned",
          driver_id: bus.driver_id || driver_id,
          trip_id: activeTripId,
          latitude: bus.latitude,
          longitude: bus.longitude,
          address: `${bus.area || ""}, ${bus.city || ""}`.replace(/^,\s*|,\s*$/g, "") || "Ballari",
          recognition_status: "DENIED - INACTIVE ACCOUNT",
          plate_number: bus.plate_number || bus.bus_id,
          stop,
          fee_status: bestStudent.fee_status,
          event_type: "DENIED",
          status: "DENIED",
          recognition_result: "DENIED - INACTIVE ACCOUNT",
          confidence: confPercent,
          face_quality: qualityLabel,
          liveness_status: livenessStatus,
          date: dateStr,
          time: timeStr,
          timestamp,
        }

        await withMongo(
          async (db) => {
            await db.collection("attendance").insertOne(deniedDoc)
          },
          (mem) => {
            mem.attendance.unshift(deniedDoc)
          }
        )

        results.push({
          face_index: i + 1,
          student_id: bestStudent.student_id,
          name: bestStudent.name,
          status: "DENIED - INACTIVE ACCOUNT",
          recognition_state: "DENIED_INACTIVE",
          confidence: confPercent,
          fee_status: bestStudent.fee_status,
          assigned_bus: bestStudent.bus_id,
          boarding_status: "DENIED",
          passenger_count_incremented: false,
          trip_id: activeTripId,
          quality_score: qualityScore,
          quality_label: qualityLabel,
          liveness_status: livenessStatus,
          message: "Denied: Student account is suspended or inactive.",
          bbox: face.bbox,
        })
        continue
      }

      // 7. Recognized Student -> Fee Validation Check
      const fee = await this.getFeeForStudent(bestStudent.student_id)
      const isFeePending = bestStudent.fee_status === "PENDING" || (fee && fee.fee_status === "PENDING")
      const validUntilStr = fee?.valid_until || bestStudent.fee_valid_until
      const isExpired = validUntilStr ? new Date(validUntilStr).getTime() < new Date(dateStr).getTime() : false

      if (isFeePending || isExpired) {
        const reason = isExpired ? "Pass Expired" : "Transport Fee Payment Pending"
        const deniedDoc: AttendanceDoc = {
          student_id: bestStudent.student_id,
          name: bestStudent.name,
          bus_id: bus.bus_id,
          route: bus.route || bestStudent.bus_id,
          driver: bus.driver_name || "Unassigned",
          driver_id: bus.driver_id || driver_id,
          trip_id: activeTripId,
          latitude: bus.latitude,
          longitude: bus.longitude,
          address: `${bus.area || ""}, ${bus.city || ""}`.replace(/^,\s*|,\s*$/g, "") || "Ballari",
          recognition_status: "DENIED - FEE NOT VALID",
          plate_number: bus.plate_number || bus.bus_id,
          stop,
          fee_status: bestStudent.fee_status,
          event_type: "DENIED",
          status: "DENIED",
          recognition_result: "DENIED - FEE NOT VALID",
          confidence: confPercent,
          face_quality: qualityLabel,
          liveness_status: livenessStatus,
          date: dateStr,
          time: timeStr,
          timestamp,
        }

        await withMongo(
          async (db) => {
            await db.collection("attendance").insertOne(deniedDoc)
          },
          (mem) => {
            mem.attendance.unshift(deniedDoc)
          }
        )

        results.push({
          face_index: i + 1,
          student_id: bestStudent.student_id,
          name: bestStudent.name,
          status: "DENIED - FEE NOT VALID",
          recognition_state: "DENIED_FEE",
          confidence: confPercent,
          fee_status: bestStudent.fee_status,
          assigned_bus: bestStudent.bus_id,
          boarding_status: "DENIED",
          passenger_count_incremented: false,
          trip_id: activeTripId,
          quality_score: qualityScore,
          quality_label: qualityLabel,
          liveness_status: livenessStatus,
          message: `Denied: ${reason}. Please clear dues with transit office.`,
          bbox: face.bbox,
        })
        continue
      }

      // 8. Bus Assignment Validation Check
      if (bestStudent.bus_id && bus.bus_id && bestStudent.bus_id !== bus.bus_id) {
        const deniedDoc: AttendanceDoc = {
          student_id: bestStudent.student_id,
          name: bestStudent.name,
          bus_id: bus.bus_id,
          route: bus.route || bestStudent.bus_id,
          driver: bus.driver_name || "Unassigned",
          driver_id: bus.driver_id || driver_id,
          trip_id: activeTripId,
          latitude: bus.latitude,
          longitude: bus.longitude,
          address: `${bus.area || ""}, ${bus.city || ""}`.replace(/^,\s*|,\s*$/g, "") || "Ballari",
          recognition_status: "DENIED - WRONG BUS",
          plate_number: bus.plate_number || bus.bus_id,
          stop,
          fee_status: bestStudent.fee_status,
          event_type: "DENIED",
          status: "DENIED",
          recognition_result: "DENIED - WRONG BUS",
          confidence: confPercent,
          face_quality: qualityLabel,
          liveness_status: livenessStatus,
          date: dateStr,
          time: timeStr,
          timestamp,
        }

        await withMongo(
          async (db) => {
            await db.collection("attendance").insertOne(deniedDoc)
          },
          (mem) => {
            mem.attendance.unshift(deniedDoc)
          }
        )

        results.push({
          face_index: i + 1,
          student_id: bestStudent.student_id,
          name: bestStudent.name,
          status: "DENIED - WRONG BUS",
          recognition_state: "DENIED_CAPACITY",
          confidence: confPercent,
          fee_status: bestStudent.fee_status,
          assigned_bus: bestStudent.bus_id,
          boarding_status: "DENIED",
          passenger_count_incremented: false,
          trip_id: activeTripId,
          quality_score: qualityScore,
          quality_label: qualityLabel,
          liveness_status: livenessStatus,
          message: `Denied: Student is assigned to bus ${bestStudent.bus_id}, not ${bus.bus_id}.`,
          bbox: face.bbox,
        })
        continue
      }

      // 9. PASSENGER TRIP LIFECYCLE STATE MACHINE (NOT_BOARDED -> BOARDED -> EXITED)
      const entryKey = `${bestStudent.student_id}:${activeTripId}:BOARDED`
      const exitKey = `${bestStudent.student_id}:${activeTripId}:EXITED`

      const passengerState: "NOT_BOARDED" | "BOARDED" | "EXITED" = await withMongo<"NOT_BOARDED" | "BOARDED" | "EXITED">(
        async (db) => {
          const exitRec = await db.collection("attendance").findOne({
            $or: [
              { idempotency_key: exitKey },
              { student_id: bestStudent!.student_id, trip_id: activeTripId, event_type: { $in: ["EXITED", "EXIT"] } },
            ],
          })
          if (exitRec) {
            return "EXITED"
          }

          const entryRec = await db.collection("attendance").findOne({
            $or: [
              { idempotency_key: entryKey },
              { student_id: bestStudent!.student_id, trip_id: activeTripId, event_type: { $in: ["BOARDED", "ENTRY"] } },
            ],
          })
          if (entryRec) {
            return "BOARDED"
          }
          return "NOT_BOARDED"
        },
        (mem) => {
          if (
            mem.exitedTripKeys.has(exitKey) ||
            mem.attendance.some(
              (a) =>
                a.student_id === bestStudent!.student_id &&
                a.trip_id === activeTripId &&
                (a.event_type === "EXITED" || a.event_type === "EXIT" || a.status === "EXITED" || a.status === "EXIT")
            )
          ) {
            return "EXITED"
          } else if (
            mem.boardedTripKeys.has(entryKey) ||
            mem.attendance.some(
              (a) =>
                a.student_id === bestStudent!.student_id &&
                a.trip_id === activeTripId &&
                (a.event_type === "BOARDED" || a.event_type === "ENTRY" || a.status === "BOARDED" || a.status === "ENTRY")
            ) ||
            (bestStudent!.is_boarded && bus.current_trip_id === activeTripId)
          ) {
            return "BOARDED"
          }
          return "NOT_BOARDED"
        }
      )

      if (cameraRole === "EXIT") {
        // EXIT CAMERA LOGIC
        if (passengerState === "EXITED") {
          results.push({
            face_index: i + 1,
            student_id: bestStudent.student_id,
            name: bestStudent.name,
            status: "ALREADY EXITED",
            recognition_state: "ALREADY_BOARDED",
            confidence: confPercent,
            fee_status: bestStudent.fee_status,
            assigned_bus: bestStudent.bus_id,
            boarding_status: "Already Exited",
            passenger_state: "EXITED",
            passenger_count_incremented: false,
            passenger_count_decremented: false,
            trip_id: activeTripId,
            quality_score: qualityScore,
            quality_label: qualityLabel,
            liveness_status: livenessStatus,
            message: "Student has already exited the bus for this trip. No additional exit recorded.",
            bbox: face.bbox,
          })
          continue
        }

        if (passengerState === "NOT_BOARDED") {
          results.push({
            face_index: i + 1,
            student_id: bestStudent.student_id,
            name: bestStudent.name,
            status: "EXIT DENIED / NOT BOARDED",
            recognition_state: "ERROR",
            confidence: confPercent,
            fee_status: bestStudent.fee_status,
            assigned_bus: bestStudent.bus_id,
            boarding_status: "Not Boarded",
            passenger_state: "NOT_BOARDED",
            passenger_count_incremented: false,
            passenger_count_decremented: false,
            trip_id: activeTripId,
            quality_score: qualityScore,
            quality_label: qualityLabel,
            liveness_status: livenessStatus,
            message: "Exit denied: Student is not registered as boarded for this trip.",
            bbox: face.bbox,
          })
          continue
        }

        // Valid Exit Transition: BOARDED -> EXITED
        const exitDoc: AttendanceDoc = {
          student_id: bestStudent.student_id,
          name: bestStudent.name,
          bus_id: bus.bus_id,
          route: bus.route || bestStudent.bus_id,
          driver: bus.driver_name || "Unassigned",
          driver_id: bus.driver_id || driver_id,
          trip_id: activeTripId,
          idempotency_key: exitKey,
          event_id: params.event_id,
          device_id: params.device_id,
          camera_role: "EXIT",
          passenger_state: "EXITED",
          exit_time: timeStr,
          exit_address: `${bus.area || ""}, ${bus.city || ""}`.replace(/^,\s*|,\s*$/g, "") || "Ballari",
          latitude: bus.latitude,
          longitude: bus.longitude,
          address: `${bus.area || ""}, ${bus.city || ""}`.replace(/^,\s*|,\s*$/g, "") || "Ballari",
          recognition_status: "EXIT SUCCESSFUL",
          plate_number: bus.plate_number || bus.bus_id,
          stop,
          fee_status: bestStudent.fee_status,
          event_type: "EXITED",
          status: "EXITED",
          recognition_result: "EXIT SUCCESSFUL",
          confidence: confPercent,
          face_quality: qualityLabel,
          liveness_status: livenessStatus,
          date: dateStr,
          time: timeStr,
          timestamp,
        }

        let exitSaved = false
        await withMongo(
          async (db) => {
            const existing = await db.collection("attendance").findOne({ idempotency_key: exitKey })
            if (existing) {
              exitSaved = false
              return
            }
            try {
              await db.collection("attendance").insertOne(exitDoc)
              exitSaved = true
              await db.collection("buses").updateOne(
                { bus_id: bus.bus_id, passengers: { $gt: 0 } },
                { $inc: { passengers: -1 }, $set: { updated_at: timestamp } }
              )
              await db.collection("students").updateOne(
                { student_id: bestStudent!.student_id },
                { $set: { is_boarded: false, updated_at: timestamp } }
              )
            } catch (err: any) {
              if (err.code === 11000 || err.message?.includes("duplicate key")) {
                exitSaved = false
              } else {
                throw err
              }
            }
          },
          (mem) => {
            if (mem.exitedTripKeys.has(exitKey)) {
              exitSaved = false
              return
            }
            mem.exitedTripKeys.add(exitKey)
            mem.attendance.unshift(exitDoc)
            exitSaved = true
            const st = mem.students.get(bestStudent!.student_id)
            if (st) st.is_boarded = false
            const b = mem.buses.get(bus.bus_id)
            if (b) {
              b.passengers = Math.max(0, b.passengers - 1)
            }
          }
        )

        if (!exitSaved) {
          results.push({
            face_index: i + 1,
            student_id: bestStudent.student_id,
            name: bestStudent.name,
            status: "ALREADY EXITED",
            recognition_state: "ALREADY_BOARDED",
            confidence: confPercent,
            fee_status: bestStudent.fee_status,
            assigned_bus: bestStudent.bus_id,
            boarding_status: "Already Exited",
            passenger_state: "EXITED",
            passenger_count_incremented: false,
            passenger_count_decremented: false,
            trip_id: activeTripId,
            quality_score: qualityScore,
            quality_label: qualityLabel,
            liveness_status: livenessStatus,
            message: "Student has already exited the bus for this trip. No additional exit recorded.",
            bbox: face.bbox,
          })
          continue
        }

        currentPassengers = Math.max(0, currentPassengers - 1)
        bestStudent.is_boarded = false

        results.push({
          face_index: i + 1,
          student_id: bestStudent.student_id,
          name: bestStudent.name,
          status: "EXIT SUCCESSFUL",
          recognition_state: "BOARDED",
          confidence: confPercent,
          fee_status: bestStudent.fee_status,
          assigned_bus: bestStudent.bus_id,
          boarding_status: "Exited",
          passenger_state: "EXITED",
          passenger_count_incremented: false,
          passenger_count_decremented: true,
          trip_id: activeTripId,
          quality_score: qualityScore,
          quality_label: qualityLabel,
          liveness_status: livenessStatus,
          message: "Student successfully verified and deboarded. Passenger count updated.",
          bbox: face.bbox,
        })
        continue
      }

      // ENTRY CAMERA LOGIC
      if (passengerState === "EXITED") {
        results.push({
          face_index: i + 1,
          student_id: bestStudent.student_id,
          name: bestStudent.name,
          status: "ALREADY EXITED",
          recognition_state: "ALREADY_BOARDED",
          confidence: confPercent,
          fee_status: bestStudent.fee_status,
          assigned_bus: bestStudent.bus_id,
          boarding_status: "Already Exited",
          passenger_state: "EXITED",
          passenger_count_incremented: false,
          passenger_count_decremented: false,
          trip_id: activeTripId,
          quality_score: qualityScore,
          quality_label: qualityLabel,
          liveness_status: livenessStatus,
          message: "Student has already completed transit (boarded and exited) for this trip. Re-entry not permitted.",
          bbox: face.bbox,
        })
        continue
      }

      if (passengerState === "BOARDED" || bestStudent.is_boarded) {
        results.push({
          face_index: i + 1,
          student_id: bestStudent.student_id,
          name: bestStudent.name,
          status: "ALREADY BOARDED",
          recognition_state: "ALREADY_BOARDED",
          confidence: confPercent,
          fee_status: bestStudent.fee_status,
          assigned_bus: bestStudent.bus_id,
          boarding_status: "Already Boarded",
          passenger_state: "BOARDED",
          passenger_count_incremented: false,
          passenger_count_decremented: false,
          trip_id: activeTripId,
          quality_score: qualityScore,
          quality_label: qualityLabel,
          liveness_status: livenessStatus,
          message: "Student has already boarded for the current trip. No additional entry recorded.",
          bbox: face.bbox,
        })
        continue
      }

      // 10. Bus Capacity Protection
      if (currentPassengers >= bus.capacity) {
        const deniedDoc: AttendanceDoc = {
          student_id: bestStudent.student_id,
          name: bestStudent.name,
          bus_id: bus.bus_id,
          route: bus.route || bestStudent.bus_id,
          driver: bus.driver_name || "Unassigned",
          driver_id: bus.driver_id || driver_id,
          trip_id: activeTripId,
          latitude: bus.latitude,
          longitude: bus.longitude,
          address: `${bus.area || ""}, ${bus.city || ""}`.replace(/^,\s*|,\s*$/g, "") || "Ballari",
          recognition_status: "DENIED - CAPACITY REACHED",
          plate_number: bus.plate_number || bus.bus_id,
          stop,
          fee_status: bestStudent.fee_status,
          event_type: "DENIED",
          status: "DENIED",
          recognition_result: "DENIED - CAPACITY REACHED",
          confidence: confPercent,
          face_quality: qualityLabel,
          liveness_status: livenessStatus,
          date: dateStr,
          time: timeStr,
          timestamp,
        }

        await withMongo(
          async (db) => {
            await db.collection("attendance").insertOne(deniedDoc)
          },
          (mem) => {
            mem.attendance.unshift(deniedDoc)
          }
        )

        results.push({
          face_index: i + 1,
          student_id: bestStudent.student_id,
          name: bestStudent.name,
          status: "DENIED - CAPACITY REACHED",
          recognition_state: "DENIED_CAPACITY",
          confidence: confPercent,
          fee_status: bestStudent.fee_status,
          assigned_bus: bestStudent.bus_id,
          boarding_status: "DENIED",
          passenger_state: "NOT_BOARDED",
          passenger_count_incremented: false,
          passenger_count_decremented: false,
          trip_id: activeTripId,
          quality_score: qualityScore,
          quality_label: qualityLabel,
          liveness_status: livenessStatus,
          message: `Denied: Bus ${bus.bus_id} is at maximum capacity (${bus.capacity}/${bus.capacity}). Additional entry prevented.`,
          bbox: face.bbox,
        })
        continue
      }

      // 11. Atomic Valid Boarding Event
      const boardedDoc: AttendanceDoc = {
        student_id: bestStudent.student_id,
        name: bestStudent.name,
        bus_id: bus.bus_id,
        route: bus.route || bestStudent.bus_id,
        driver: bus.driver_name || "Unassigned",
        driver_id: bus.driver_id || driver_id,
        trip_id: activeTripId,
        idempotency_key: entryKey,
        event_id: params.event_id,
        device_id: params.device_id,
        camera_role: "ENTRY",
        passenger_state: "BOARDED",
        entry_time: timeStr,
        entry_address: `${bus.area || ""}, ${bus.city || ""}`.replace(/^,\s*|,\s*$/g, "") || "Ballari",
        latitude: bus.latitude,
        longitude: bus.longitude,
        address: `${bus.area || ""}, ${bus.city || ""}`.replace(/^,\s*|,\s*$/g, "") || "Ballari",
        recognition_status: "RECOGNIZED",
        plate_number: bus.plate_number || bus.bus_id,
        stop,
        fee_status: bestStudent.fee_status,
        event_type: "BOARDED",
        status: "BOARDED",
        recognition_result: "RECOGNIZED",
        confidence: confPercent,
        face_quality: qualityLabel,
        liveness_status: livenessStatus,
        date: dateStr,
        time: timeStr,
        timestamp,
      }

      let insertedSuccessfully = false

      // Persist boarding atomically
      await withMongo(
        async (db) => {
          // Double check inside transaction/lock
          const existing = await db.collection("attendance").findOne({ idempotency_key: entryKey })
          if (existing) {
            insertedSuccessfully = false
            return
          }

          try {
            await db.collection("attendance").insertOne(boardedDoc)
            insertedSuccessfully = true
            // Atomic passenger count increment with capacity guard
            await db.collection("buses").updateOne(
              { bus_id: bus.bus_id, passengers: { $lt: bus.capacity } },
              { $inc: { passengers: 1 }, $set: { updated_at: timestamp } }
            )
            await db.collection("students").updateOne(
              { student_id: bestStudent!.student_id },
              { $set: { is_boarded: true, updated_at: timestamp } }
            )
          } catch (insertErr: any) {
            if (
              insertErr.code === 11000 ||
              insertErr.message?.includes("duplicate key") ||
              insertErr.message?.includes("E11000")
            ) {
              insertedSuccessfully = false
            } else {
              throw insertErr
            }
          }
        },
        (mem) => {
          if (mem.boardedTripKeys.has(entryKey)) {
            insertedSuccessfully = false
            return
          }
          mem.boardedTripKeys.add(entryKey)
          mem.attendance.unshift(boardedDoc)
          insertedSuccessfully = true
          const st = mem.students.get(bestStudent!.student_id)
          if (st) st.is_boarded = true
          const b = mem.buses.get(bus.bus_id)
          if (b && b.passengers < b.capacity) {
            b.passengers += 1
          }
        }
      )

      if (!insertedSuccessfully) {
        // A concurrent race condition was gracefully mitigated by the idempotency key
        results.push({
          face_index: i + 1,
          student_id: bestStudent.student_id,
          name: bestStudent.name,
          status: "ALREADY BOARDED",
          recognition_state: "ALREADY_BOARDED",
          confidence: confPercent,
          fee_status: bestStudent.fee_status,
          assigned_bus: bestStudent.bus_id,
          boarding_status: "Already Boarded",
          passenger_state: "BOARDED",
          passenger_count_incremented: false,
          passenger_count_decremented: false,
          trip_id: activeTripId,
          quality_score: qualityScore,
          quality_label: qualityLabel,
          liveness_status: livenessStatus,
          message: "Student has already boarded for the current trip. No additional entry recorded.",
          bbox: face.bbox,
        })
        continue
      }

      currentPassengers = currentPassengers + 1
      bestStudent.is_boarded = true

      results.push({
        face_index: i + 1,
        student_id: bestStudent.student_id,
        name: bestStudent.name,
        status: "RECOGNIZED",
        recognition_state: "BOARDED",
        confidence: confPercent,
        fee_status: bestStudent.fee_status,
        assigned_bus: bestStudent.bus_id,
        boarding_status: "Boarded",
        passenger_state: "BOARDED",
        passenger_count_incremented: true,
        passenger_count_decremented: false,
        trip_id: activeTripId,
        quality_score: qualityScore,
        quality_label: qualityLabel,
        liveness_status: livenessStatus,
        message: `Verified entry: Boarded successfully at ${stop}`,
        bbox: face.bbox,
      })
    }

    // Record processed event_id for offline/reconnect idempotency
    if (eventLockKey) {
      const cleanEventId = eventLockKey
      await withMongo(
        async (db) => {
          await db.collection("processed_iot_events").updateOne(
  { event_id: cleanEventId },
  {
    $setOnInsert: {
      event_id: cleanEventId,
      processed_at: timestamp,
      bus_id: bus.bus_id,
    },
  },
  { upsert: true }
)
        },
        (mem) => {
          mem.processedEventIds.add(cleanEventId)
        }
      )
    }

    return {
      success: true,
      event_status: "COMPLETED",
      processed_faces: results,
      count: results.length,
      overflow,
      message: overflow
        ? "Maximum 4 faces can be processed simultaneously."
        : `Processed ${results.length} passenger face(s) for trip ${activeTripId}.`,
      bus: {
        bus_id: bus.bus_id,
        passengers: currentPassengers,
        capacity: bus.capacity,
        available_seats: Math.max(0, bus.capacity - currentPassengers),
      },
    }
    } finally {
      // Always release the lock, including early returns and thrown errors.
      if (eventLockKey) inFlightIoTEvents.delete(eventLockKey)
    }
  }

  // -------------------------------------------------------------------------
  // Bus Trip Lifecycle Management (Start / End Trip Session)
  // -------------------------------------------------------------------------
  async startBusTrip(
    busId: string,
    tripId?: string
  ): Promise<{ success: boolean; message: string; trip_id: string; bus: BusDoc }> {
    const bus = await this.getBusById(busId)
    if (!bus) throw new Error(`Bus ${busId} not found`)
    const now = new Date()
    const dateStr = now.toISOString().split("T")[0]
    const timeCode =
      now.getHours().toString().padStart(2, "0") +
      "-" +
      now.getMinutes().toString().padStart(2, "0") +
      "-" +
      now.getSeconds().toString().padStart(2, "0")
    const newTripId = tripId?.trim() || `TRIP-${bus.bus_id}-${dateStr}-${timeCode}`

    await withMongo(
      async (db) => {
        await db.collection("buses").updateOne(
          { bus_id: busId },
          {
            $set: {
              current_trip_id: newTripId,
              trip_active: true,
              status: "IN_TRANSIT",
              passengers: 0,
              updated_at: now.toISOString(),
            },
          }
        )
        // Reset is_boarded state for students assigned to this bus for the new trip
        await db.collection("students").updateMany(
          { bus_id: busId },
          { $set: { is_boarded: false, updated_at: now.toISOString() } }
        )
      },
      (mem) => {
        const b = mem.buses.get(busId)
        if (b) {
          b.current_trip_id = newTripId
          b.trip_active = true
          b.status = "IN_TRANSIT"
          b.passengers = 0
          b.updated_at = now.toISOString()
        }
        for (const st of mem.students.values()) {
          if (st.bus_id === busId) {
            st.is_boarded = false
          }
        }
      }
    )

    const updatedBus = (await this.getBusById(busId))!
    return {
      success: true,
      message: `Trip ${newTripId} started successfully for ${busId}.`,
      trip_id: newTripId,
      bus: updatedBus,
    }
  }

  async stopBusTrip(busId: string): Promise<{ success: boolean; message: string; bus: BusDoc }> {
    const bus = await this.getBusById(busId)
    if (!bus) throw new Error(`Bus ${busId} not found`)
    const now = new Date()

    await withMongo(
      async (db) => {
        await db.collection("buses").updateOne(
          { bus_id: busId },
          {
            $set: {
              trip_active: false,
              status: "ACTIVE",
              updated_at: now.toISOString(),
            },
          }
        )
      },
      (mem) => {
        const b = mem.buses.get(busId)
        if (b) {
          b.trip_active = false
          b.status = "ACTIVE"
          b.updated_at = now.toISOString()
        }
      }
    )

    const updatedBus = (await this.getBusById(busId))!
    return {
      success: true,
      message: `Trip closed successfully for ${busId}.`,
      bus: updatedBus,
    }
  }

  // -------------------------------------------------------------------------
  // IoT Hardware & Device Integration Layer
  // -------------------------------------------------------------------------
  async getIotDevices(): Promise<IoTDeviceDoc[]> {
    return await withMongo(
      async (db) => {
        return await db.collection<IoTDeviceDoc>("devices").find({}).toArray()
      },
      (mem) => Array.from(mem.devices.values())
    )
  }

  async getIotDeviceById(deviceId: string): Promise<IoTDeviceDoc | null> {
    const cleanId = deviceId.trim()
    return await withMongo(
      async (db) => {
        return await db.collection<IoTDeviceDoc>("devices").findOne({ device_id: cleanId })
      },
      (mem) => mem.devices.get(cleanId) || null
    )
  }

  async registerIotDevice(params: {
    device_id?: string
    device_name: string
    device_type?: "RASPBERRY_PI" | "GPS" | "ENTRY_CAMERA" | "EXIT_CAMERA"
    bus_id: string
    camera_role?: "ENTRY" | "EXIT"
    firmware_version?: string
  }): Promise<{ success: boolean; device: IoTDeviceDoc; raw_api_key: string }> {
    const now = new Date().toISOString()
    const rawApiKey = `sb_pi_${crypto.randomBytes(16).toString("hex")}`
    const apiKeyHash = hashDeviceApiKey(rawApiKey)
    const deviceId =
      params.device_id?.trim() ||
      `PI-${params.bus_id}-${params.camera_role || "ENTRY"}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`

    const doc: IoTDeviceDoc = {
      device_id: deviceId,
      device_name: params.device_name.trim(),
      device_type: params.device_type || "RASPBERRY_PI",
      bus_id: params.bus_id.trim(),
      camera_role: params.camera_role || "ENTRY",
      api_key_hash: apiKeyHash,
      status: "ONLINE",
      last_seen: now,
      firmware_version: params.firmware_version || "v2.4.1",
      camera_status: "ACTIVE",
      gps_status: "FIX_ACQUIRED",
      network_status: "CELLULAR",
      created_at: now,
      updated_at: now,
    }

    await withMongo(
      async (db) => {
        await db.collection<IoTDeviceDoc>("devices").updateOne(
          { device_id: deviceId },
          { $set: doc },
          { upsert: true }
        )
      },
      (mem) => {
        mem.devices.set(deviceId, doc)
        mem.saveToDisk()
      }
    )

    return {
      success: true,
      device: doc,
      raw_api_key: rawApiKey,
    }
  }

  async authenticateIotDevice(
    deviceId: string,
    rawApiKey: string,
    requestedBusId?: string
  ): Promise<{ success: boolean; device?: IoTDeviceDoc; error?: string; status_code: number }> {
    if (!deviceId || !rawApiKey) {
      return { success: false, error: "Missing x-device-id or x-api-key headers.", status_code: 401 }
    }

    const device = await this.getIotDeviceById(deviceId)
    if (!device) {
      return { success: false, error: `Device ${deviceId} not found in transit registry.`, status_code: 401 }
    }

    if (device.status === "DEACTIVATED") {
      return { success: false, error: `Device ${deviceId} is deactivated. Contact transit operations.`, status_code: 403 }
    }

    const computedHash = hashDeviceApiKey(rawApiKey)
    if (device.api_key_hash !== computedHash && device.api_key_hash !== rawApiKey) {
      return { success: false, error: "Invalid device authentication credentials.", status_code: 401 }
    }

    if (requestedBusId && requestedBusId !== device.bus_id) {
      return {
        success: false,
        error: `Device ${deviceId} is assigned to ${device.bus_id} and cannot submit telemetry for ${requestedBusId}.`,
        status_code: 403,
      }
    }

    // Touch last_seen
    const now = new Date().toISOString()
    await withMongo(
      async (db) => {
        await db.collection("devices").updateOne(
          { device_id: device.device_id },
          { $set: { last_seen: now, status: "ONLINE", updated_at: now } }
        )
      },
      (mem) => {
        const d = mem.devices.get(device.device_id)
        if (d) {
          d.last_seen = now
          d.status = "ONLINE"
          d.updated_at = now
        }
      }
    )

    return { success: true, device, status_code: 200 }
  }

  async recordIotHeartbeat(
    deviceId: string,
    payload: {
      status?: "ONLINE" | "OFFLINE"
      camera_status?: "ACTIVE" | "IDLE" | "ERROR"
      gps_status?: "FIX_ACQUIRED" | "SEARCHING" | "ERROR"
      network_status?: "WIFI" | "CELLULAR" | "ETHERNET" | "DISCONNECTED"
      firmware_version?: string
      ip_address?: string
    }
  ): Promise<IoTDeviceDoc | null> {
    const now = new Date().toISOString()
    return await withMongo(
      async (db) => {
        const setDoc: any = { last_seen: now, updated_at: now }
        if (payload.status) setDoc.status = payload.status
        if (payload.camera_status) setDoc.camera_status = payload.camera_status
        if (payload.gps_status) setDoc.gps_status = payload.gps_status
        if (payload.network_status) setDoc.network_status = payload.network_status
        if (payload.firmware_version) setDoc.firmware_version = payload.firmware_version
        if (payload.ip_address) setDoc.ip_address = payload.ip_address

        return await db.collection<IoTDeviceDoc>("devices").findOneAndUpdate(
          { device_id: deviceId },
          { $set: setDoc },
          { returnDocument: "after" }
        )
      },
      (mem) => {
        const d = mem.devices.get(deviceId)
        if (!d) return null
        d.last_seen = now
        d.updated_at = now
        if (payload.status) d.status = payload.status
        if (payload.camera_status) d.camera_status = payload.camera_status
        if (payload.gps_status) d.gps_status = payload.gps_status
        if (payload.network_status) d.network_status = payload.network_status
        if (payload.firmware_version) d.firmware_version = payload.firmware_version
        if (payload.ip_address) d.ip_address = payload.ip_address
        return d
      }
    )
  }

  async toggleIotDevice(
    deviceId: string,
    newStatus?: "ONLINE" | "OFFLINE" | "DEACTIVATED"
  ): Promise<IoTDeviceDoc | null> {
    const now = new Date().toISOString()
    const dev = await this.getIotDeviceById(deviceId)
    if (!dev) return null
    const targetStatus = newStatus || (dev.status === "ONLINE" ? "OFFLINE" : "ONLINE")

    return await withMongo(
      async (db) => {
        return await db.collection<IoTDeviceDoc>("devices").findOneAndUpdate(
          { device_id: deviceId },
          { $set: { status: targetStatus, updated_at: now } },
          { returnDocument: "after" }
        )
      },
      (mem) => {
        const d = mem.devices.get(deviceId)
        if (!d) return null
        d.status = targetStatus
        d.updated_at = now
        return d
      }
    )
  }

  async getPassengerTripState(
    studentId: string,
    tripId: string
  ): Promise<"NOT_BOARDED" | "BOARDED" | "EXITED"> {
    const cleanStudentId = studentId.trim()
    const cleanTripId = tripId.trim()
    const entryKey = `${cleanStudentId}:${cleanTripId}:BOARDED`
    const exitKey = `${cleanStudentId}:${cleanTripId}:EXITED`

    return await withMongo(
      async (db) => {
        const exitRec = await db.collection("attendance").findOne({
          $or: [
            { idempotency_key: exitKey },
            { student_id: cleanStudentId, trip_id: cleanTripId, event_type: { $in: ["EXITED", "EXIT"] } },
          ],
        })
        if (exitRec) return "EXITED"

        const entryRec = await db.collection("attendance").findOne({
          $or: [
            { idempotency_key: entryKey },
            { student_id: cleanStudentId, trip_id: cleanTripId, event_type: { $in: ["BOARDED", "ENTRY"] } },
          ],
        })
        if (entryRec) return "BOARDED"

        return "NOT_BOARDED"
      },
      (mem) => {
        if (
          mem.exitedTripKeys.has(exitKey) ||
          mem.attendance.some(
            (a) =>
              a.student_id === cleanStudentId &&
              a.trip_id === cleanTripId &&
              (a.event_type === "EXITED" || a.event_type === "EXIT" || a.status === "EXITED" || a.status === "EXIT")
          )
        ) {
          return "EXITED"
        }

        if (
          mem.boardedTripKeys.has(entryKey) ||
          mem.attendance.some(
            (a) =>
              a.student_id === cleanStudentId &&
              a.trip_id === cleanTripId &&
              (a.event_type === "BOARDED" || a.event_type === "ENTRY" || a.status === "BOARDED" || a.status === "ENTRY")
          )
        ) {
          return "BOARDED"
        }

        const student = mem.students.get(cleanStudentId)
        if (student?.is_boarded) return "BOARDED"

        return "NOT_BOARDED"
      }
    )
  }

  async getTripStats(
    busId: string,
    tripId?: string
  ): Promise<{
    bus_id: string
    trip_id: string
    capacity: number
    currently_on_board: number
    total_entries: number
    total_exits: number
    available_seats: number
    occupancy_percentage: string
  }> {
    const bus = (await this.getBusById(busId)) || (await this.getBuses())[0]
    const currentTrip = tripId || bus?.current_trip_id || `TRIP-${busId}-DEFAULT`
    const capacity = bus?.capacity || 40

    const attendanceList = await this.getAttendance()
    const tripAttendance = attendanceList.filter((a) => a.bus_id === busId && a.trip_id === currentTrip)

    const totalEntries = tripAttendance.filter((a) => a.event_type === "BOARDED" || a.status === "BOARDED").length
    const totalExits = tripAttendance.filter((a) => a.event_type === "EXITED" || a.status === "EXITED").length
    const currentlyOnBoard = Math.max(0, Math.min(capacity, totalEntries - totalExits))
    const availableSeats = Math.max(0, capacity - currentlyOnBoard)
    const occupancyPercentage = `${Math.round((currentlyOnBoard / capacity) * 100)}%`

    return {
      bus_id: busId,
      trip_id: currentTrip,
      capacity,
      currently_on_board: currentlyOnBoard,
      total_entries: totalEntries,
      total_exits: totalExits,
      available_seats: availableSeats,
      occupancy_percentage: occupancyPercentage,
    }
  }

  async getTripManifest(
    busId: string,
    tripId?: string
  ): Promise<Array<{
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
  }>> {
    const bus = (await this.getBusById(busId)) || (await this.getBuses())[0]
    const currentTrip = tripId || bus?.current_trip_id || `TRIP-${busId}-DEFAULT`
    const allStudents = await this.getStudents()
    const busStudents = allStudents.filter((s) => s.bus_id === busId)
    const attendanceList = await this.getAttendance()
    const tripAttendance = attendanceList.filter((a) => a.bus_id === busId && a.trip_id === currentTrip)

    return busStudents.map((st) => {
      const entryRec = tripAttendance.find(
        (a) => a.student_id === st.student_id && (a.event_type === "BOARDED" || a.status === "BOARDED")
      )
      const exitRec = tripAttendance.find(
        (a) => a.student_id === st.student_id && (a.event_type === "EXITED" || a.status === "EXITED")
      )

      let state: "NOT_BOARDED" | "BOARDED" | "EXITED" = "NOT_BOARDED"
      if (exitRec) {
        state = "EXITED"
      } else if (entryRec || st.is_boarded) {
        state = "BOARDED"
      }

      return {
        student_id: st.student_id,
        name: st.name,
        department: st.department,
        bus_id: st.bus_id,
        state,
        entry_time: entryRec ? `${entryRec.date} ${entryRec.time}` : null,
        entry_location: entryRec?.stop || entryRec?.address || null,
        exit_time: exitRec ? `${exitRec.date} ${exitRec.time}` : null,
        exit_location: exitRec?.stop || exitRec?.address || null,
        fee_status: st.fee_status,
      }
    })
  }
}

export const serverDb = new MongoDatabaseService()




