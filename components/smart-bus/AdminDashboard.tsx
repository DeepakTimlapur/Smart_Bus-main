"use client"

import { useState, useMemo } from "react"
import {
  Bus as BusIcon,
  Users,
  UserCheck,
  CreditCard,
  Clock,
  MapPin,
  Search,
  Plus,
  Trash2,
  Edit2,
  RefreshCw,
  Phone,
  Mail,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  UserPlus,
  ShieldAlert,
  Gauge,
  Activity,
  Send,
  Radio,
  Key,
  Copy,
  Check,
} from "lucide-react"
import {
  type Overview,
  type Bus,
  type Attendance,
  type Emergency,
  type ManagedStudent,
  type ManagedDriver,
  type ManagedBus,
  type ManagedFee,
  createManagedStudent,
  updateManagedStudent,
  deleteManagedStudent,
  createManagedDriver,
  updateManagedDriver,
  deleteManagedDriver,
  createManagedBus,
  updateManagedBus,
  deleteManagedBus,
  assignDriverToBus,
  createManagedFee,
  updateManagedFee,
  resetStudentPassword,
  resetDriverPassword,
} from "@/lib/api"
import AdminFaceManagement from "./AdminFaceManagement"
import LiveMap, { type BusMapMarker } from "./LiveMap"
import { calculateDistanceMeters, formatDistance } from "@/lib/distance"

interface AdminDashboardProps {
  overview: Overview | null
  buses: Bus[]
  attendance: Attendance[]
  emergencies: Emergency[]
  managedStudents: ManagedStudent[]
  managedDrivers: ManagedDriver[]
  managedBuses: ManagedBus[]
  managedFees: ManagedFee[]
  onRefreshAll: () => Promise<void>
}

export default function AdminDashboard({
  overview,
  buses,
  attendance,
  emergencies,
  managedStudents,
  managedDrivers,
  managedBuses,
  managedFees,
  onRefreshAll,
}: AdminDashboardProps) {
  const [activeTab, setActiveTab] = useState<
    "overview" | "students" | "drivers" | "buses" | "fees" | "attendance" | "face-biometrics"
  >("overview")

  const [refreshing, setRefreshing] = useState(false)

  // Search states
  const [studentSearch, setStudentSearch] = useState("")
  const [driverSearch, setDriverSearch] = useState("")
  const [busSearch, setBusSearch] = useState("")
  const [feeSearch, setFeeSearch] = useState("")
  const [attendanceFilter, setAttendanceFilter] = useState("ALL")

  // Student Form Modal
  const [showStudentModal, setShowStudentModal] = useState(false)
  const [editingStudent, setEditingStudent] = useState<ManagedStudent | null>(null)
  const [studentFormId, setStudentFormId] = useState("")
  const [studentFormName, setStudentFormName] = useState("")
  const [studentFormEmail, setStudentFormEmail] = useState("")
  const [studentFormPhone, setStudentFormPhone] = useState("")
  const [studentFormDept, setStudentFormDept] = useState("Computer Science")
  const [studentFormYear, setStudentFormYear] = useState("1st Year")
  const [studentFormSemester, setStudentFormSemester] = useState("1")
  const [studentFormBus, setStudentFormBus] = useState("BUS-01")
  const [studentFormFeeTotal, setStudentFormFeeTotal] = useState("35000")
  const [studentFormFeePaid, setStudentFormFeePaid] = useState("35000")
  const [studentFormPassword, setStudentFormPassword] = useState("student123")
  const [studentModalLoading, setStudentModalLoading] = useState(false)
  const [studentEmailNotice, setStudentEmailNotice] = useState<string | null>(null)

  // Driver Form Modal
  const [showDriverModal, setShowDriverModal] = useState(false)
  const [editingDriver, setEditingDriver] = useState<ManagedDriver | null>(null)
  const [driverFormUsername, setDriverFormUsername] = useState("")
  const [driverFormName, setDriverFormName] = useState("")
  const [driverFormEmail, setDriverFormEmail] = useState("")
  const [driverFormPhone, setDriverFormPhone] = useState("")
  const [driverFormLicense, setDriverFormLicense] = useState("")
  const [driverFormBus, setDriverFormBus] = useState("BUS-01")
  const [driverFormPassword, setDriverFormPassword] = useState("driver123")
  const [driverModalLoading, setDriverModalLoading] = useState(false)

  // Bus Form Modal
  const [showBusModal, setShowBusModal] = useState(false)
  const [editingBus, setEditingBus] = useState<ManagedBus | null>(null)
  const [busFormId, setBusFormId] = useState("")
  const [busFormName, setBusFormName] = useState("")
  const [busFormPlate, setBusFormPlate] = useState("")
  const [busFormRoute, setBusFormRoute] = useState("")
  const [busFormCapacity, setBusFormCapacity] = useState("40")
  const [busModalLoading, setBusModalLoading] = useState(false)

  // Assign Driver Modal
  const [assignBusTarget, setAssignBusTarget] = useState<ManagedBus | null>(null)
  const [selectedDriverToAssign, setSelectedDriverToAssign] = useState("")
  const [assignModalLoading, setAssignModalLoading] = useState(false)

  // Fee Form Modal
  const [showFeeModal, setShowFeeModal] = useState(false)
  const [editingFee, setEditingFee] = useState<ManagedFee | null>(null)
  const [feeFormStudentId, setFeeFormStudentId] = useState("")
  const [feeFormYear, setFeeFormYear] = useState("2026-27")
  const [feeFormTotal, setFeeFormTotal] = useState("35000")
  const [feeFormPaid, setFeeFormPaid] = useState("35000")
  const [feeModalLoading, setFeeModalLoading] = useState(false)

  // Password Reset Notice Modal
  const [passwordResetNotice, setPasswordResetNotice] = useState<{
    target: string
    role: "STUDENT" | "DRIVER"
    temporaryPassword: string
    emailNote?: string
  } | null>(null)
  const [resetLoadingTarget, setResetLoadingTarget] = useState<string | null>(null)
  const [copiedPass, setCopiedPass] = useState(false)

  const handleResetStudentPassword = async (studentId: string) => {
    setResetLoadingTarget(studentId)
    try {
      const res = await resetStudentPassword(studentId)
      setPasswordResetNotice({
        target: studentId,
        role: "STUDENT",
        temporaryPassword: res.temporary_password,
        emailNote:
          res.email_dispatch?.note ||
          (res.email_dispatch?.sent
            ? "Credentials dispatched via SMTP email."
            : "Email service is not configured."),
      })
    } catch (err: any) {
      alert(err?.detail || err?.message || "Failed to reset student password.")
    } finally {
      setResetLoadingTarget(null)
    }
  }

  const handleResetDriverPassword = async (username: string) => {
    setResetLoadingTarget(username)
    try {
      const res = await resetDriverPassword(username)
      setPasswordResetNotice({
        target: username,
        role: "DRIVER",
        temporaryPassword: res.temporary_password,
        emailNote: "Driver login credentials updated successfully in database.",
      })
    } catch (err: any) {
      alert(err?.detail || err?.message || "Failed to reset driver password.")
    } finally {
      setResetLoadingTarget(null)
    }
  }

  const handleManualRefresh = async () => {
    setRefreshing(true)
    try {
      await onRefreshAll()
    } finally {
      setRefreshing(false)
    }
  }

  // --- Student Handlers ---
  const openCreateStudent = () => {
    setEditingStudent(null)
    setStudentFormId(`3BR23CS${Math.floor(100 + Math.random() * 900)}`)
    setStudentFormName("")
    setStudentFormEmail("")
    setStudentFormPhone("+91 9")
    setStudentFormDept("Computer Science")
    setStudentFormYear("1st Year")
    setStudentFormSemester("1")
    setStudentFormBus(managedBuses[0]?.bus_id || "BUS-01")
    setStudentFormFeeTotal("35000")
    setStudentFormFeePaid("35000")
    setStudentFormPassword("student123")
    setStudentEmailNotice(null)
    setShowStudentModal(true)
  }

  const openEditStudent = (st: ManagedStudent) => {
    setEditingStudent(st)
    setStudentFormId(st.student_id)
    setStudentFormName(st.name)
    setStudentFormEmail(st.email || "")
    setStudentFormPhone(st.phone || "")
    setStudentFormDept(st.department || "Computer Science")
    setStudentFormYear(st.year || "1st Year")
    setStudentFormBus(st.assigned_bus || "BUS-01")
    setStudentFormFeeTotal(String(st.fee_total || 35000))
    setStudentFormFeePaid(String(st.fee_paid || 0))
    setStudentEmailNotice(null)
    setShowStudentModal(true)
  }

  const handleSaveStudent = async () => {
    if (!studentFormId.trim() || !studentFormName.trim() || !studentFormEmail.trim()) {
      alert("Student ID, Name, and Email are required.")
      return
    }

    setStudentModalLoading(true)
    try {
      if (editingStudent) {
        await updateManagedStudent(editingStudent.student_id, {
          name: studentFormName,
          email: studentFormEmail,
          phone: studentFormPhone,
          assigned_bus: studentFormBus,
          department: studentFormDept,
          year: studentFormYear,
          semester: studentFormSemester,
        })
      } else {
        const res = await createManagedStudent({
          student_id: studentFormId,
          name: studentFormName,
          email: studentFormEmail,
          phone: studentFormPhone,
          department: studentFormDept,
          year: studentFormYear,
          assigned_bus: studentFormBus,
          fee_total: Number(studentFormFeeTotal) || 35000,
          fee_paid: Number(studentFormFeePaid) || 0,
          fee_valid_until: "2027-05-31",
          password: studentFormPassword,
        })
        if (res.email_dispatch?.sent) {
          setStudentEmailNotice(`Credentials successfully dispatched to ${studentFormEmail} via SMTP.`)
        }
      }
      await onRefreshAll()
      setShowStudentModal(false)
    } catch (err: any) {
      alert(err?.message || "Failed to save student.")
    } finally {
      setStudentModalLoading(false)
    }
  }

  const handleDeleteStudent = async (studentId: string) => {
    if (!confirm(`Are you sure you want to delete student ${studentId}?`)) return
    try {
      await deleteManagedStudent(studentId)
      await onRefreshAll()
    } catch (err: any) {
      alert(err?.message || "Failed to delete student.")
    }
  }

  // --- Driver Handlers ---
  const openCreateDriver = () => {
    setEditingDriver(null)
    setDriverFormUsername(`driver_${Math.floor(10 + Math.random() * 90)}`)
    setDriverFormName("")
    setDriverFormEmail("")
    setDriverFormPhone("+91 9")
    setDriverFormLicense("DL-KA34-2024-")
    setDriverFormBus(managedBuses[0]?.bus_id || "BUS-01")
    setDriverFormPassword("driver123")
    setShowDriverModal(true)
  }

  const openEditDriver = (dr: ManagedDriver) => {
    setEditingDriver(dr)
    setDriverFormUsername(dr.username)
    setDriverFormName(dr.full_name || dr.name || "")
    setDriverFormEmail(dr.email || "")
    setDriverFormPhone(dr.phone || "")
    setDriverFormLicense(dr.license_number || "")
    setDriverFormBus(dr.assigned_bus || "")
    setShowDriverModal(true)
  }

  const handleSaveDriver = async () => {
    if (!driverFormUsername.trim() || !driverFormName.trim()) {
      alert("Username and Driver Name are required.")
      return
    }

    setDriverModalLoading(true)
    try {
      if (editingDriver) {
        await updateManagedDriver(editingDriver.username, {
          name: driverFormName,
          email: driverFormEmail,
          phone: driverFormPhone,
          license_number: driverFormLicense,
          assigned_bus: driverFormBus || null,
        })
      } else {
        await createManagedDriver({
          username: driverFormUsername,
          name: driverFormName,
          email: driverFormEmail,
          phone: driverFormPhone,
          license_number: driverFormLicense,
          assigned_bus: driverFormBus || undefined,
          password: driverFormPassword,
        })
      }
      await onRefreshAll()
      setShowDriverModal(false)
    } catch (err: any) {
      alert(err?.message || "Failed to save driver.")
    } finally {
      setDriverModalLoading(false)
    }
  }

  const handleDeleteDriver = async (username: string) => {
    if (!confirm(`Are you sure you want to delete driver ${username}?`)) return
    try {
      await deleteManagedDriver(username)
      await onRefreshAll()
    } catch (err: any) {
      alert(err?.message || "Failed to delete driver.")
    }
  }

  // --- Bus Handlers ---
  const openCreateBus = () => {
    setEditingBus(null)
    const nextIdx = managedBuses.length + 1
    const nextId = `BUS-${nextIdx < 10 ? "0" + nextIdx : nextIdx}`
    setBusFormId(nextId)
    setBusFormName(`Unit ${nextId}`)
    setBusFormPlate(`KA-34-E-${1000 + nextIdx}`)
    setBusFormRoute("Campus Transit Loop")
    setBusFormCapacity("40")
    setShowBusModal(true)
  }

  const openEditBus = (b: ManagedBus) => {
    setEditingBus(b)
    setBusFormId(b.bus_id)
    setBusFormName(b.bus_name)
    setBusFormPlate(b.plate_number)
    setBusFormCapacity(String(b.capacity))
    setShowBusModal(true)
  }

  const handleSaveBus = async () => {
    if (!busFormId.trim() || !busFormPlate.trim()) {
      alert("Bus ID and Plate Number are required.")
      return
    }

    setBusModalLoading(true)
    try {
      if (editingBus) {
        await updateManagedBus(editingBus.bus_id, {
          bus_name: busFormName,
          plate_number: busFormPlate,
          capacity: Number(busFormCapacity) || 40,
        })
      } else {
        await createManagedBus({
          bus_id: busFormId,
          bus_name: busFormName,
          plate_number: busFormPlate,
          capacity: Number(busFormCapacity) || 40,
          stops: ["Main Campus Gate", "City Circle", "Terminal"],
        })
      }
      await onRefreshAll()
      setShowBusModal(false)
    } catch (err: any) {
      alert(err?.message || "Failed to save bus unit.")
    } finally {
      setBusModalLoading(false)
    }
  }

  const handleDeleteBus = async (busId: string) => {
    if (!confirm(`Are you sure you want to delete bus ${busId}?`)) return
    try {
      await deleteManagedBus(busId)
      await onRefreshAll()
    } catch (err: any) {
      alert(err?.message || "Failed to delete bus.")
    }
  }

  const openAssignDriver = (bus: ManagedBus) => {
    setAssignBusTarget(bus)
    setSelectedDriverToAssign(bus.driver?.username || managedDrivers[0]?.username || "")
  }

  const handleAssignDriver = async () => {
    if (!assignBusTarget || !selectedDriverToAssign) return
    setAssignModalLoading(true)
    try {
      await assignDriverToBus(assignBusTarget.bus_id, selectedDriverToAssign)
      await onRefreshAll()
      setAssignBusTarget(null)
    } catch (err: any) {
      alert(err?.message || "Failed to assign driver.")
    } finally {
      setAssignModalLoading(false)
    }
  }

  // --- Fee Handlers ---
  const openCreateFee = () => {
    setEditingFee(null)
    setFeeFormStudentId(managedStudents[0]?.student_id || "")
    setFeeFormYear("2026-27")
    setFeeFormTotal("35000")
    setFeeFormPaid("35000")
    setShowFeeModal(true)
  }

  const openEditFee = (f: ManagedFee) => {
    setEditingFee(f)
    setFeeFormStudentId(f.student_id)
    setFeeFormYear(f.academic_year)
    setFeeFormTotal(String(f.total_fee))
    setFeeFormPaid(String(f.paid_amount))
    setShowFeeModal(true)
  }

  const handleSaveFee = async () => {
    if (!feeFormStudentId.trim()) {
      alert("Student ID is required.")
      return
    }

    const tot = Number(feeFormTotal) || 0
    const pd = Number(feeFormPaid) || 0
    if (pd > tot) {
      alert("Paid amount cannot exceed total fee.")
      return
    }

    setFeeModalLoading(true)
    try {
      if (editingFee) {
        await updateManagedFee(editingFee.student_id, {
          academic_year: feeFormYear,
          total_fee: tot,
          paid_amount: pd,
        })
      } else {
        await createManagedFee({
          student_id: feeFormStudentId,
          academic_year: feeFormYear,
          total_fee: tot,
          paid_amount: pd,
        })
      }
      await onRefreshAll()
      setShowFeeModal(false)
    } catch (err: any) {
      alert(err?.message || "Failed to save fee record.")
    } finally {
      setFeeModalLoading(false)
    }
  }

  // Filtered lists
  const filteredStudents = useMemo(() => {
    const q = studentSearch.toLowerCase().trim()
    if (!q) return managedStudents
    return managedStudents.filter(
      (s) =>
        s.student_id.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        (s.email && s.email.toLowerCase().includes(q)) ||
        (s.assigned_bus && s.assigned_bus.toLowerCase().includes(q))
    )
  }, [managedStudents, studentSearch])

  const filteredDrivers = useMemo(() => {
    const q = driverSearch.toLowerCase().trim()
    if (!q) return managedDrivers
    return managedDrivers.filter(
      (d) =>
        d.username.toLowerCase().includes(q) ||
        d.full_name.toLowerCase().includes(q) ||
        (d.email && d.email.toLowerCase().includes(q)) ||
        (d.license_number && d.license_number.toLowerCase().includes(q))
    )
  }, [managedDrivers, driverSearch])

  const filteredBuses = useMemo(() => {
    const q = busSearch.toLowerCase().trim()
    if (!q) return managedBuses
    return managedBuses.filter(
      (b) =>
        b.bus_id.toLowerCase().includes(q) ||
        b.plate_number.toLowerCase().includes(q) ||
        b.bus_name.toLowerCase().includes(q)
    )
  }, [managedBuses, busSearch])

  const filteredFees = useMemo(() => {
    const q = feeSearch.toLowerCase().trim()
    if (!q) return managedFees
    return managedFees.filter(
      (f) =>
        f.student_id.toLowerCase().includes(q) ||
        (f.student_name && f.student_name.toLowerCase().includes(q)) ||
        f.status.toLowerCase().includes(q)
    )
  }, [managedFees, feeSearch])

  const filteredAttendance = useMemo(() => {
    if (attendanceFilter === "ALL") return attendance
    return attendance.filter((a) => (a.status || a.fee_status) === attendanceFilter)
  }, [attendance, attendanceFilter])

  // Aggregate Stats
  const totalBuses = managedBuses.length
  const totalStudents = managedStudents.length
  const totalDrivers = managedDrivers.length
  const activePassengers = managedBuses.reduce((sum, b) => sum + (b.current_passengers || 0), 0)
  const totalCapacity = managedBuses.reduce((sum, b) => sum + (b.capacity || 40), 0)
  const occupancyPercent = totalCapacity > 0 ? Math.round((activePassengers / totalCapacity) * 100) : 0
  const totalCollected = managedFees.reduce((sum, f) => sum + (f.paid_amount || 0), 0)
  const totalPending = managedFees.reduce((sum, f) => sum + (f.pending_amount || 0), 0)

  // Admin reference location
  const [adminReference, setAdminReference] = useState<{
    latitude: number
    longitude: number
  } | null>(null)
  const [adminLocationError, setAdminLocationError] = useState("")
  const [referenceLatitude, setReferenceLatitude] = useState("")
  const [referenceLongitude, setReferenceLongitude] = useState("")

  const useAdminCurrentLocation = () => {
    if (!navigator.geolocation) {
      setAdminLocationError("Browser location is not supported.")
      return
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setAdminReference({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        })
        setReferenceLatitude(String(position.coords.latitude))
        setReferenceLongitude(String(position.coords.longitude))
        setAdminLocationError("")
      },
      (error) => {
        setAdminLocationError(
          error.code === error.PERMISSION_DENIED
            ? "Location permission denied. Enter coordinates manually."
            : "Could not obtain location. Enter coordinates manually."
        )
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    )
  }

  const applyManualReference = () => {
    const latitude = Number(referenceLatitude)
    const longitude = Number(referenceLongitude)

    if (
      !referenceLatitude.trim() ||
      !referenceLongitude.trim() ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      setAdminLocationError("Enter valid latitude (-90 to 90) and longitude (-180 to 180).")
      return
    }

    setAdminReference({ latitude, longitude })
    setAdminLocationError("")
  }

  return (
    <div className="space-y-6">
      {/* High-Level Fleet KPI Strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-400">Total Enrolled</span>
            <Users className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-white mt-2">
            {totalStudents}
          </div>
          <span className="text-[11px] text-zinc-500 block mt-0.5">Students Registered</span>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-400">Active Fleet</span>
            <BusIcon className="h-4 w-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-white mt-2">
            {totalBuses} Units
          </div>
          <span className="text-[11px] text-zinc-500 block mt-0.5">{totalDrivers} Assigned Drivers</span>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-400">Current Occupancy</span>
            <Gauge className="h-4 w-4 text-blue-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-white mt-2">
            {activePassengers} <span className="text-sm font-normal text-zinc-400">/ {totalCapacity}</span>
          </div>
          <span className="text-[11px] text-zinc-500 block mt-0.5">{occupancyPercent}% Fleet Load</span>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-400">Fee Clearance</span>
            <CreditCard className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-emerald-400 mt-2">
            ₹{totalCollected.toLocaleString("en-IN")}
          </div>
          <span className="text-[11px] text-zinc-500 block mt-0.5">₹{totalPending.toLocaleString("en-IN")} Dues Pending</span>
        </div>
      </div>

      {/* Tabs Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-2">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {[
            { id: "overview", label: "Fleet & Live Map" },
            { id: "students", label: `Students (${managedStudents.length})` },
            { id: "drivers", label: `Drivers (${managedDrivers.length})` },
            { id: "buses", label: `Buses (${managedBuses.length})` },
            { id: "fees", label: `Fees (${managedFees.length})` },
            { id: "attendance", label: `Attendance (${attendance.length})` },
            { id: "face-biometrics", label: "Face Biometrics" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition whitespace-nowrap ${
                activeTab === tab.id
                  ? "bg-zinc-100 text-zinc-950 shadow-md font-bold"
                  : "text-zinc-400 hover:text-white hover:bg-zinc-800/60"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <button
          onClick={handleManualRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-300 border border-zinc-700 transition"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin text-emerald-400" : ""}`} />
          Refresh
        </button>
      </div>

      {/* TAB 1: FLEET OVERVIEW & LIVE MAP */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          {/* Real-time OpenStreetMap Fleet Grid */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <Radio className="h-5 w-5 text-emerald-400 animate-pulse" />
                  Real-Time Transit Fleet Live Map (OpenStreetMap)
                </h3>
                <p className="text-xs text-zinc-400">
                  Interactive multi-vehicle tracker powered by Leaflet & high-frequency GPS telemetry
                </p>
              </div>
              <span className="px-3 py-1 rounded-full text-xs font-mono font-semibold bg-zinc-800 text-zinc-300 border border-zinc-700">
                {managedBuses.length} Fleet Units Active
              </span>
            </div>

            <div className="rounded-xl overflow-hidden border border-zinc-800">
              <LiveMap
                buses={managedBuses.map((bus, idx) => {
                  const liveBus = buses.find((b) => b.bus_id === bus.bus_id)
                  const fallbackLat = 15.1460 - idx * 0.007
                  const fallbackLng = 76.9214 + idx * 0.006
                  return {
                    bus_id: bus.bus_id,
                    bus_name: bus.bus_name,
                    route: bus.route,
                    driver_name: bus.driver?.full_name || "Unassigned",
                    plate_number: bus.plate_number,
                    status: (bus.status as any) || "ACTIVE",
                    latitude: liveBus?.gps?.latitude || liveBus?.latitude || fallbackLat,
                    longitude: liveBus?.gps?.longitude || liveBus?.longitude || fallbackLng,
                    speed: liveBus?.gps?.speed ?? 32,
                    heading: liveBus?.gps?.heading ?? 120,
                    address: liveBus?.gps?.area || liveBus?.area || liveBus?.city || "Ballari Corridor",
                    passengers: bus.current_passengers || 0,
                    capacity: bus.capacity || 40,
                    last_updated: liveBus?.gps?.timestamp || "Active",
                  }
                })}
                height="420px"
              />
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
            <h3 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
              <BusIcon className="h-5 w-5 text-indigo-400" />
              Fleet Unit Capacity & Driver Assignments
            </h3>
            <p className="text-xs text-zinc-400 mb-6">
              Real-time seat occupancies, registration plates, and operations staff assignments.
            </p>

            {/* Admin reference location */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-3">
              <h4 className="text-sm font-semibold text-white">Bus Distance Reference Location</h4>
              <p className="text-xs text-zinc-400">
                Choose your current location or enter coordinates to calculate straight-line distance to each bus.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={useAdminCurrentLocation}
                  className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white"
                >
                  Use My Current Location
                </button>
                <input
                  aria-label="Reference latitude"
                  value={referenceLatitude}
                  onChange={(e) => setReferenceLatitude(e.target.value)}
                  placeholder="Latitude"
                  className="w-32 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-xs text-white"
                />
                <input
                  aria-label="Reference longitude"
                  value={referenceLongitude}
                  onChange={(e) => setReferenceLongitude(e.target.value)}
                  placeholder="Longitude"
                  className="w-32 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-xs text-white"
                />
                <button
                  type="button"
                  onClick={applyManualReference}
                  className="px-3 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-xs font-semibold text-white"
                >
                  Use Coordinates
                </button>
              </div>
              {adminLocationError && (
                <p role="alert" className="text-xs text-amber-400">{adminLocationError}</p>
              )}
              <p className="text-xs text-zinc-500">
                {adminReference
                  ? `Reference: ${adminReference.latitude.toFixed(6)}, ${adminReference.longitude.toFixed(6)}`
                  : "No reference location selected."}
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {managedBuses.map((bus) => {
                const pax = bus.current_passengers || 0
                const cap = bus.capacity || 40
                const pct = Math.round((pax / cap) * 100)

                return (
                  <div
                    key={bus.bus_id}
                    className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-5 hover:border-zinc-700 transition"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-lg font-bold font-mono text-white">{bus.bus_id}</span>
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                        ACTIVE
                      </span>
                    </div>

                    <p className="text-xs text-zinc-400 mt-1">{bus.bus_name}</p>
                    {(() => {
                      const liveBus = buses.find((item) => item.bus_id === bus.bus_id)
                      const lat = liveBus?.gps?.latitude ?? liveBus?.latitude
                      const lng = liveBus?.gps?.longitude ?? liveBus?.longitude
                      const hasRealGps =
                        typeof lat === "number" &&
                        typeof lng === "number" &&
                        Number.isFinite(lat) &&
                        Number.isFinite(lng) &&
                        Math.abs(lat) <= 90 &&
                        Math.abs(lng) <= 180

                      return (
                        <div className="mt-3 rounded-lg bg-zinc-900 border border-zinc-800 p-3">
                          <span className="block text-[11px] text-zinc-500">Distance from reference</span>
                          <span className="block mt-1 text-sm font-semibold text-emerald-400">
                            {!adminReference
                              ? "Select a reference location"
                              : !hasRealGps
                              ? "GPS unavailable"
                              : formatDistance(calculateDistanceMeters(adminReference, {
                                  latitude: lat as number,
                                  longitude: lng as number,
                                }))}
                          </span>
                        </div>
                      )
                    })()}
                    <div className="text-xs text-zinc-500 font-mono mt-0.5">{bus.plate_number}</div>

                    <div className="mt-4 pt-3 border-t border-zinc-800/80">
                      <div className="flex justify-between text-xs text-zinc-400 mb-1">
                        <span>Passenger Load</span>
                        <span className="font-mono text-white">{pax} / {cap} ({pct}%)</span>
                      </div>
                      <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full ${pct > 80 ? "bg-amber-500" : "bg-emerald-500"}`}
                          style={{ width: `${Math.min(100, pct)}%` }}
                        />
                      </div>
                    </div>

                    <div className="mt-4 pt-3 border-t border-zinc-800/80 flex items-center justify-between text-xs">
                      <div className="truncate">
                        <span className="text-zinc-500 block">Driver</span>
                        <span className="text-zinc-300 font-medium truncate">
                          {bus.driver?.full_name || "Unassigned"}
                        </span>
                      </div>
                      <button
                        onClick={() => openAssignDriver(bus)}
                        className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs transition"
                      >
                        Change Driver
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Emergency / Incident Monitor */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
            <h3 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-rose-400" />
              Incident & Emergency Dispatch Log
            </h3>
            <p className="text-xs text-zinc-400 mb-4">
              Real-time alerts triggered by onboard SOS or telemetry anomalies.
            </p>

            {emergencies.length === 0 ? (
              <div className="p-6 text-center rounded-xl bg-zinc-950/40 border border-zinc-800 text-zinc-500 text-sm">
                <CheckCircle2 className="h-6 w-6 text-emerald-400 mx-auto mb-1" />
                All transit corridors operational. Zero emergency incidents logged.
              </div>
            ) : (
              <div className="space-y-2">
                {emergencies.map((em, idx) => (
                  <div
                    key={idx}
                    className="p-3.5 rounded-xl border border-rose-500/30 bg-rose-950/20 flex items-center justify-between text-xs"
                  >
                    <div>
                      <span className="font-bold text-rose-400">{em.bus_id}</span> â€¢ {em.type || "Alert"}
                      <p className="text-zinc-300 mt-0.5">{em.message}</p>
                    </div>
                    <span className="font-mono text-zinc-500">{em.timestamp}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: STUDENTS MANAGEMENT */}
      {activeTab === "students" && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-5">
            <div>
              <h3 className="text-lg font-bold text-white">Student Enrollment & Pass Records</h3>
              <p className="text-xs text-zinc-400">
                Manage registered students, assigned bus units, and transport pass clearance.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="h-4 w-4 absolute left-3 top-2.5 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Search by ID, name, bus..."
                  value={studentSearch}
                  onChange={(e) => setStudentSearch(e.target.value)}
                  className="pl-9 pr-3.5 py-1.5 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white placeholder-zinc-500 w-56 focus:outline-none focus:border-zinc-700"
                />
              </div>
              <button
                onClick={openCreateStudent}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white transition shadow-md"
              >
                <Plus className="h-4 w-4" />
                Add Student
              </button>
            </div>
          </div>

          {studentEmailNotice && (
            <div className="mb-4 p-3 rounded-xl bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              {studentEmailNotice}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-400 uppercase tracking-wider border-b border-zinc-800 bg-zinc-950/50">
                <tr>
                  <th className="py-3 px-4">Student ID</th>
                  <th className="py-3 px-4">Full Name</th>
                  <th className="py-3 px-4">Email / Phone</th>
                  <th className="py-3 px-4">Assigned Bus</th>
                  <th className="py-3 px-4">Fee Status</th>
                  <th className="py-3 px-4">Transit Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                {filteredStudents.map((st) => (
                  <tr key={st.student_id} className="hover:bg-zinc-800/30 transition">
                    <td className="py-3 px-4 font-mono font-semibold text-white">{st.student_id}</td>
                    <td className="py-3 px-4">{st.name}</td>
                    <td className="py-3 px-4 text-xs">
                      <div>{st.email}</div>
                      <div className="text-zinc-500">{st.phone}</div>
                    </td>
                    <td className="py-3 px-4 font-mono text-zinc-300">{st.assigned_bus || "BUS-01"}</td>
                    <td className="py-3 px-4">
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                          st.fee_status === "PAID"
                            ? "bg-emerald-500/20 text-emerald-400"
                            : st.fee_status === "PARTIAL"
                            ? "bg-amber-500/20 text-amber-400"
                            : "bg-rose-500/20 text-rose-400"
                        }`}
                      >
                        {st.fee_status || "PAID"}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                          st.is_boarded ? "bg-emerald-500/20 text-emerald-400" : "bg-zinc-800 text-zinc-400"
                        }`}
                      >
                        {st.is_boarded ? "BOARDED" : "OFF BUS"}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right space-x-2">
                      <button
                        id={`btn-reset-student-pass-${st.student_id}`}
                        onClick={() => handleResetStudentPassword(st.student_id)}
                        disabled={resetLoadingTarget === st.student_id}
                        title="Reset Password & Resend Credentials"
                        className="p-1 rounded bg-zinc-800 hover:bg-amber-950/40 text-zinc-400 hover:text-amber-300 transition"
                      >
                        <Key className={`h-3.5 w-3.5 ${resetLoadingTarget === st.student_id ? "animate-spin text-amber-400" : ""}`} />
                      </button>
                      <button
                        onClick={() => openEditStudent(st)}
                        className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => handleDeleteStudent(st.student_id)}
                        className="p-1 rounded bg-zinc-800 hover:bg-rose-900/50 text-zinc-400 hover:text-rose-400 transition"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: DRIVERS MANAGEMENT */}
      {activeTab === "drivers" && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-5">
            <div>
              <h3 className="text-lg font-bold text-white">Transit Drivers & Fleet Operators</h3>
              <p className="text-xs text-zinc-400">
                Authorize driver logins, update contact information, and assign vehicles.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="h-4 w-4 absolute left-3 top-2.5 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Search drivers..."
                  value={driverSearch}
                  onChange={(e) => setDriverSearch(e.target.value)}
                  className="pl-9 pr-3.5 py-1.5 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white placeholder-zinc-500 w-52 focus:outline-none focus:border-zinc-700"
                />
              </div>
              <button
                onClick={openCreateDriver}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white transition shadow-md"
              >
                <Plus className="h-4 w-4" />
                Add Driver
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-400 uppercase tracking-wider border-b border-zinc-800 bg-zinc-950/50">
                <tr>
                  <th className="py-3 px-4">Username</th>
                  <th className="py-3 px-4">Full Name</th>
                  <th className="py-3 px-4">Contact</th>
                  <th className="py-3 px-4">License Number</th>
                  <th className="py-3 px-4">Assigned Unit</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                {filteredDrivers.map((dr) => (
                  <tr key={dr.username} className="hover:bg-zinc-800/30 transition">
                    <td className="py-3 px-4 font-mono font-semibold text-white">{dr.username}</td>
                    <td className="py-3 px-4">{dr.full_name || dr.name}</td>
                    <td className="py-3 px-4 text-xs">
                      <div>{dr.email || "driver@smartbus.transit.org"}</div>
                      <div className="text-zinc-500">{dr.phone || "+91 98888 11111"}</div>
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-zinc-400">{dr.license_number || "DL-KA34-2024-889"}</td>
                    <td className="py-3 px-4 font-mono text-emerald-400 font-semibold">{dr.assigned_bus || "Unassigned"}</td>
                    <td className="py-3 px-4 text-right space-x-2">
                      <button
                        id={`btn-reset-driver-pass-${dr.username}`}
                        onClick={() => handleResetDriverPassword(dr.username)}
                        disabled={resetLoadingTarget === dr.username}
                        title="Reset Driver Password"
                        className="p-1 rounded bg-zinc-800 hover:bg-amber-950/40 text-zinc-400 hover:text-amber-300 transition"
                      >
                        <Key className={`h-3.5 w-3.5 ${resetLoadingTarget === dr.username ? "animate-spin text-amber-400" : ""}`} />
                      </button>
                      <button
                        onClick={() => openEditDriver(dr)}
                        className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => handleDeleteDriver(dr.username)}
                        className="p-1 rounded bg-zinc-800 hover:bg-rose-900/50 text-zinc-400 hover:text-rose-400 transition"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: BUSES MANAGEMENT */}
      {activeTab === "buses" && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-5">
            <div>
              <h3 className="text-lg font-bold text-white">Institutional Bus Fleet</h3>
              <p className="text-xs text-zinc-400">
                Vehicle registrations, passenger seating capacities, and assigned route operators.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="h-4 w-4 absolute left-3 top-2.5 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Search buses..."
                  value={busSearch}
                  onChange={(e) => setBusSearch(e.target.value)}
                  className="pl-9 pr-3.5 py-1.5 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white placeholder-zinc-500 w-52 focus:outline-none focus:border-zinc-700"
                />
              </div>
              <button
                onClick={openCreateBus}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white transition shadow-md"
              >
                <Plus className="h-4 w-4" />
                Add Bus
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-400 uppercase tracking-wider border-b border-zinc-800 bg-zinc-950/50">
                <tr>
                  <th className="py-3 px-4">Bus ID</th>
                  <th className="py-3 px-4">Registration Plate</th>
                  <th className="py-3 px-4">Designated Driver</th>
                  <th className="py-3 px-4">Seating Capacity</th>
                  <th className="py-3 px-4">Active Boarded</th>
                  <th className="py-3 px-4">Available Seats</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                {filteredBuses.map((b) => (
                  <tr key={b.bus_id} className="hover:bg-zinc-800/30 transition">
                    <td className="py-3 px-4 font-mono font-bold text-white">{b.bus_id}</td>
                    <td className="py-3 px-4 font-mono text-zinc-300">{b.plate_number}</td>
                    <td className="py-3 px-4">
                      {b.driver?.full_name ? (
                        <span className="text-zinc-200 font-medium">{b.driver.full_name}</span>
                      ) : (
                        <span className="text-zinc-500 italic">Unassigned</span>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono">{b.capacity} Seats</td>
                    <td className="py-3 px-4 font-mono text-emerald-400 font-bold">{b.current_passengers || 0}</td>
                    <td className="py-3 px-4 font-mono text-amber-400 font-bold">{b.available_seats || b.capacity}</td>
                    <td className="py-3 px-4 text-right space-x-2">
                      <button
                        onClick={() => openAssignDriver(b)}
                        className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 transition"
                      >
                        Assign Driver
                      </button>
                      <button
                        onClick={() => openEditBus(b)}
                        className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => handleDeleteBus(b.bus_id)}
                        className="p-1 rounded bg-zinc-800 hover:bg-rose-900/50 text-zinc-400 hover:text-rose-400 transition"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 5: FEES MANAGEMENT */}
      {activeTab === "fees" && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-5">
            <div>
              <h3 className="text-lg font-bold text-white">Student Transport Fee Ledger</h3>
              <p className="text-xs text-zinc-400">
                Track annual transport dues, paid amounts, outstanding balances, and pass expiry.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="h-4 w-4 absolute left-3 top-2.5 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Search fee records..."
                  value={feeSearch}
                  onChange={(e) => setFeeSearch(e.target.value)}
                  className="pl-9 pr-3.5 py-1.5 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white placeholder-zinc-500 w-52 focus:outline-none focus:border-zinc-700"
                />
              </div>
              <button
                onClick={openCreateFee}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white transition shadow-md"
              >
                <Plus className="h-4 w-4" />
                Record Fee
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-400 uppercase tracking-wider border-b border-zinc-800 bg-zinc-950/50">
                <tr>
                  <th className="py-3 px-4">Student ID</th>
                  <th className="py-3 px-4">Student Name</th>
                  <th className="py-3 px-4">Academic Year</th>
                  <th className="py-3 px-4">Total Billed</th>
                  <th className="py-3 px-4">Paid Amount</th>
                  <th className="py-3 px-4">Outstanding Dues</th>
                  <th className="py-3 px-4">Clearance Status</th>
                  <th className="py-3 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                {filteredFees.map((f) => (
                  <tr key={f.student_id} className="hover:bg-zinc-800/30 transition">
                    <td className="py-3 px-4 font-mono font-semibold text-white">{f.student_id}</td>
                    <td className="py-3 px-4">{f.student_name || f.student_id}</td>
                    <td className="py-3 px-4 text-xs font-mono">{f.academic_year}</td>
                    <td className="py-3 px-4 font-mono">₹{f.total_fee.toLocaleString()}</td>
                    <td className="py-3 px-4 font-mono text-emerald-400 font-semibold">₹{f.paid_amount.toLocaleString()}</td>
                    <td className="py-3 px-4 font-mono text-rose-400">₹{f.pending_amount.toLocaleString()}</td>
                    <td className="py-3 px-4">
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                          f.status === "PAID"
                            ? "bg-emerald-500/20 text-emerald-400"
                            : f.status === "PARTIAL"
                            ? "bg-amber-500/20 text-amber-400"
                            : "bg-rose-500/20 text-rose-400"
                        }`}
                      >
                        {f.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => openEditFee(f)}
                        className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 transition"
                      >
                        Update Dues
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 6: ATTENDANCE LOGS */}
      {activeTab === "attendance" && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-5">
            <div>
              <h3 className="text-lg font-bold text-white">Transit Verification Audit Trail</h3>
              <p className="text-xs text-zinc-400">
                Real-time logs of student boarding, exit events, and access denials across all units.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400">Filter:</span>
              <select
                value={attendanceFilter}
                onChange={(e) => setAttendanceFilter(e.target.value)}
                className="px-3 py-1.5 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-zinc-700"
              >
                <option value="ALL">All Events</option>
                <option value="BOARDED">BOARDED Only</option>
                <option value="EXITED">EXITED Only</option>
                <option value="DENIED">DENIED Only</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-400 uppercase tracking-wider border-b border-zinc-800 bg-zinc-950/50">
                <tr>
                  <th className="py-3 px-4">Timestamp</th>
                  <th className="py-3 px-4">Student</th>
                  <th className="py-3 px-4">Bus Unit</th>
                  <th className="py-3 px-4">Terminal / Stop</th>
                  <th className="py-3 px-4">Event Type</th>
                  <th className="py-3 px-4">Fee Clearance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                {filteredAttendance.map((a, idx) => (
                  <tr key={idx} className="hover:bg-zinc-800/30 transition">
                    <td className="py-3 px-4 font-mono text-xs">
                      {a.date} {a.time && `â€¢ ${a.time}`}
                    </td>
                    <td className="py-3 px-4 font-semibold text-white">
                      {a.name || a.student_id}
                    </td>
                    <td className="py-3 px-4 font-mono text-zinc-300">{a.bus_id}</td>
                    <td className="py-3 px-4 text-zinc-400">{a.stop || "Campus Terminal"}</td>
                    <td className="py-3 px-4">
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                          a.status === "BOARDED"
                            ? "bg-emerald-500/20 text-emerald-400"
                            : a.status === "DENIED"
                            ? "bg-rose-500/20 text-rose-400"
                            : "bg-blue-500/20 text-blue-400"
                        }`}
                      >
                        {a.status || "BOARDED"}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-xs font-mono">{a.fee_status || "PAID"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 7: FACE BIOMETRICS & RE-REGISTRATION MANAGEMENT */}
      {activeTab === "face-biometrics" && (
        <AdminFaceManagement
          students={managedStudents}
          onRefreshParent={onRefreshAll}
        />
      )}

      {/* --- MODALS --- */}

      {/* Student Modal */}
      {showStudentModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 max-w-md w-full shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-1">
              {editingStudent ? "Edit Student Details" : "Enroll New Student"}
            </h3>
            <p className="text-xs text-zinc-400 mb-4">
              {!editingStudent && "SMTP service will automatically dispatch access credentials to the student's email."}
            </p>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-zinc-300 font-semibold mb-1">Student ID / Registration</label>
                <input
                  type="text"
                  disabled={!!editingStudent}
                  value={studentFormId}
                  onChange={(e) => setStudentFormId(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-zinc-300 font-semibold mb-1">Full Legal Name</label>
                <input
                  type="text"
                  value={studentFormName}
                  onChange={(e) => setStudentFormName(e.target.value)}
                  placeholder="e.g. Aditi Rao"
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-zinc-300 font-semibold mb-1">Email (for SMTP Credential Dispatch)</label>
                <input
                  type="email"
                  value={studentFormEmail}
                  onChange={(e) => setStudentFormEmail(e.target.value)}
                  placeholder="student@institution.edu"
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white focus:outline-none focus:border-emerald-500"
                />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-zinc-300 font-semibold mb-1">Branch</label>
                  <select
                    value={studentFormDept}
                    onChange={(e) => setStudentFormDept(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white focus:outline-none focus:border-emerald-500"
                  >
                    <option value="Computer Science">CSE</option>
                    <option value="CSE-AI">CSE (AI)</option>
                    <option value="CSE-DS">CSE (Data Science)</option>
                    <option value="CSE-AI/ML">CSE (AI&ML)</option>
                    <option value="Electronics and Communication">ECE</option>
                    <option value="Electrical and Electronics">EEE</option>
                    <option value="Mechanical Engineering">Mechanical</option>
                    <option value="Civil Engineering">Civil</option>
                  </select>
                </div>
                <div>
                  <label className="block text-zinc-300 font-semibold mb-1">Year</label>
                  <select
                    value={studentFormYear}
                    onChange={(e) => setStudentFormYear(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white focus:outline-none focus:border-emerald-500"
                  >
                    <option value="1st Year">1st Year</option>
                    <option value="2nd Year">2nd Year</option>
                    <option value="3rd Year">3rd Year</option>
                    <option value="4th Year">4th Year</option>
                  </select>
                </div>
                <div>
                  <label className="block text-zinc-300 font-semibold mb-1">Semester</label>
                  <select
                    value={studentFormSemester}
                    onChange={(e) => setStudentFormSemester(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white focus:outline-none focus:border-emerald-500"
                  >
                    {Array.from({ length: 8 }, (_, i) => (
                      <option key={i + 1} value={String(i + 1)}>
                        Semester {i + 1}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-zinc-300 font-semibold mb-1">Contact Phone</label>
                  <input
                    type="text"
                    value={studentFormPhone}
                    onChange={(e) => setStudentFormPhone(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-zinc-300 font-semibold mb-1">Assigned Bus Unit</label>
                  <select
                    value={studentFormBus}
                    onChange={(e) => setStudentFormBus(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono focus:outline-none focus:border-emerald-500"
                  >
                    {managedBuses.map((b) => (
                      <option key={b.bus_id} value={b.bus_id}>
                        {b.bus_id}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {!editingStudent && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-zinc-300 font-semibold mb-1">Total Transport Fee</label>
                    <input
                      type="number"
                      value={studentFormFeeTotal}
                      onChange={(e) => setStudentFormFeeTotal(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-zinc-300 font-semibold mb-1">Initial Fee Paid</label>
                    <input
                      type="number"
                      value={studentFormFeePaid}
                      onChange={(e) => setStudentFormFeePaid(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setShowStudentModal(false)}
                className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveStudent}
                disabled={studentModalLoading}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg"
              >
                {studentModalLoading ? "Saving..." : "Save Record"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Driver Modal */}
      {showDriverModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 max-w-md w-full shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-1">
              {editingDriver ? "Edit Driver Details" : "Register Transit Driver"}
            </h3>
            <p className="text-xs text-zinc-400 mb-4">
              Driver account for mobile GPS telemetry and passenger boarding verification.
            </p>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-zinc-300 font-semibold mb-1">Username</label>
                <input
                  type="text"
                  disabled={!!editingDriver}
                  value={driverFormUsername}
                  onChange={(e) => setDriverFormUsername(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono"
                />
              </div>

              <div>
                <label className="block text-zinc-300 font-semibold mb-1">Full Name</label>
                <input
                  type="text"
                  value={driverFormName}
                  onChange={(e) => setDriverFormName(e.target.value)}
                  placeholder="e.g. Suresh Kumar"
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-zinc-300 font-semibold mb-1">Phone</label>
                  <input
                    type="text"
                    value={driverFormPhone}
                    onChange={(e) => setDriverFormPhone(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white"
                  />
                </div>
                <div>
                  <label className="block text-zinc-300 font-semibold mb-1">Assigned Bus</label>
                  <select
                    value={driverFormBus}
                    onChange={(e) => setDriverFormBus(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono"
                  >
                    {managedBuses.map((b) => (
                      <option key={b.bus_id} value={b.bus_id}>
                        {b.bus_id}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-zinc-300 font-semibold mb-1">Driving License Number</label>
                <input
                  type="text"
                  value={driverFormLicense}
                  onChange={(e) => setDriverFormLicense(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setShowDriverModal(false)}
                className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveDriver}
                disabled={driverModalLoading}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg"
              >
                {driverModalLoading ? "Saving..." : "Save Driver"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bus Modal */}
      {showBusModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 max-w-md w-full shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-1">
              {editingBus ? "Edit Bus Unit" : "Add Vehicle to Fleet"}
            </h3>

            <div className="space-y-3 text-xs mt-4">
              <div>
                <label className="block text-zinc-300 font-semibold mb-1">Bus Unit ID</label>
                <input
                  type="text"
                  disabled={!!editingBus}
                  value={busFormId}
                  onChange={(e) => setBusFormId(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono"
                />
              </div>

              <div>
                <label className="block text-zinc-300 font-semibold mb-1">Registration / Plate Number</label>
                <input
                  type="text"
                  value={busFormPlate}
                  onChange={(e) => setBusFormPlate(e.target.value)}
                  placeholder="KA-34-E-1001"
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono"
                />
              </div>

              <div>
                <label className="block text-zinc-300 font-semibold mb-1">Bus Display Name</label>
                <input
                  type="text"
                  value={busFormName}
                  onChange={(e) => setBusFormName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white"
                />
              </div>

              <div>
                <label className="block text-zinc-300 font-semibold mb-1">Seating Capacity</label>
                <input
                  type="number"
                  value={busFormCapacity}
                  onChange={(e) => setBusFormCapacity(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setShowBusModal(false)}
                className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveBus}
                disabled={busModalLoading}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg"
              >
                {busModalLoading ? "Saving..." : "Save Vehicle"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Driver Modal */}
      {assignBusTarget && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 max-w-sm w-full shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-1">
              Assign Driver to {assignBusTarget.bus_id}
            </h3>
            <p className="text-xs text-zinc-400 mb-4">
              Select an authorized transit driver to pilot this vehicle unit.
            </p>

            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1">Select Driver</label>
              <select
                value={selectedDriverToAssign}
                onChange={(e) => setSelectedDriverToAssign(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white text-xs font-mono"
              >
                {managedDrivers.map((d) => (
                  <option key={d.username} value={d.username}>
                    {d.full_name || d.name} ({d.username})
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setAssignBusTarget(null)}
                className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleAssignDriver}
                disabled={assignModalLoading}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg"
              >
                {assignModalLoading ? "Assigning..." : "Confirm Assignment"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fee Modal */}
      {showFeeModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 max-w-md w-full shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-1">
              {editingFee ? "Update Transport Dues" : "Record Transport Fee"}
            </h3>

            <div className="space-y-3 text-xs mt-4">
              <div>
                <label className="block text-zinc-300 font-semibold mb-1">Student ID</label>
                <input
                  type="text"
                  disabled={!!editingFee}
                  value={feeFormStudentId}
                  onChange={(e) => setFeeFormStudentId(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono"
                />
              </div>

              <div>
                <label className="block text-zinc-300 font-semibold mb-1">Academic Year</label>
                <input
                  type="text"
                  value={feeFormYear}
                  onChange={(e) => setFeeFormYear(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-zinc-300 font-semibold mb-1">Total Fee (₹)</label>
                  <input
                    type="number"
                    value={feeFormTotal}
                    onChange={(e) => setFeeFormTotal(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-zinc-300 font-semibold mb-1">Paid Amount (₹)</label>
                  <input
                    type="number"
                    value={feeFormPaid}
                    onChange={(e) => setFeeFormPaid(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono"
                  />
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setShowFeeModal(false)}
                className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveFee}
                disabled={feeModalLoading}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg"
              >
                {feeModalLoading ? "Saving..." : "Save Fee Record"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Password Reset Modal */}
      {passwordResetNotice && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 max-w-md w-full shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
                <Key className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">
                  Password Reset & Credentials
                </h3>
                <p className="text-xs text-zinc-400">
                  Target: <span className="font-mono text-zinc-200 font-bold">{passwordResetNotice.target}</span> ({passwordResetNotice.role})
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2">
              <span className="text-xs text-zinc-400 font-semibold block">New Temporary Password:</span>
              <div className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-zinc-900 border border-zinc-800">
                <span className="font-mono text-base font-extrabold text-amber-400 tracking-wider">
                  {passwordResetNotice.temporaryPassword}
                </span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(passwordResetNotice.temporaryPassword)
                    setCopiedPass(true)
                    setTimeout(() => setCopiedPass(false), 2000)
                  }}
                  className="flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-200 transition"
                >
                  {copiedPass ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copiedPass ? "Copied" : "Copy"}</span>
                </button>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/80 text-xs space-y-1">
              <span className="font-semibold text-zinc-300">Email Dispatch Status:</span>
              <p className={passwordResetNotice.emailNote?.includes("not configured") ? "text-amber-400 font-medium" : "text-emerald-400 font-medium"}>
                {passwordResetNotice.emailNote || "Email service is not configured."}
              </p>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setPasswordResetNotice(null)}
                className="px-4 py-2 rounded-xl bg-white hover:bg-zinc-200 text-black text-xs font-bold transition shadow"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


