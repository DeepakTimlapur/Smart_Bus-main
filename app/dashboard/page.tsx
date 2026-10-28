"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  Bus as BusIcon,
  Shield,
  User,
  LogOut,
  Sun,
  Moon,
  Loader2,
  AlertCircle,
  LogIn,
  RefreshCw,
} from "lucide-react"
import {
  getCurrentUser,
  getStoredToken,
  getStoredUser,
  getOverview,
  getBuses,
  getAttendance,
  getEmergencies,
  getManagedStudents,
  getManagedDrivers,
  getManagedBuses,
  getManagedFees,
  clearAuthSession,
  type CurrentUser,
  type Overview,
  type Bus,
  type Attendance,
  type Emergency,
  type ManagedStudent,
  type ManagedDriver,
  type ManagedBus,
  type ManagedFee,
} from "@/lib/api"
import AdminDashboard from "@/components/smart-bus/AdminDashboard"
import DriverDashboard from "@/components/smart-bus/DriverDashboard"
import StudentDashboard from "@/components/smart-bus/StudentDashboard"

export default function DashboardPage() {
  const router = useRouter()
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState<string | null>(null)
  const [darkMode, setDarkMode] = useState(true)

  // Admin Data Store
  const [overview, setOverview] = useState<Overview | null>(null)
  const [buses, setBuses] = useState<Bus[]>([])
  const [attendance, setAttendance] = useState<Attendance[]>([])
  const [emergencies, setEmergencies] = useState<Emergency[]>([])
  const [managedStudents, setManagedStudents] = useState<ManagedStudent[]>([])
  const [managedDrivers, setManagedDrivers] = useState<ManagedDriver[]>([])
  const [managedBuses, setManagedBuses] = useState<ManagedBus[]>([])
  const [managedFees, setManagedFees] = useState<ManagedFee[]>([])

  const loadAdminData = async () => {
    try {
      const [
        ovRes,
        busRes,
        attRes,
        emRes,
        stuRes,
        drvRes,
        mBusRes,
        feeRes,
      ] = await Promise.all([
        getOverview().catch(() => null),
        getBuses().catch(() => []),
        getAttendance().catch(() => []),
        getEmergencies().catch(() => []),
        getManagedStudents().catch(() => []),
        getManagedDrivers().catch(() => []),
        getManagedBuses().catch(() => []),
        getManagedFees().catch(() => []),
      ])

      if (ovRes) setOverview(ovRes)
      setBuses(busRes)
      setAttendance(attRes)
      setEmergencies(emRes)
      setManagedStudents(stuRes)
      setManagedDrivers(drvRes)
      setManagedBuses(mBusRes)
      setManagedFees(feeRes)
    } catch (err) {
      console.error("Error loading admin records:", err)
    }
  }

  const checkAuthAndLoad = async () => {
    setAuthError(null)

    // 1. Check localStorage first
    const token = getStoredToken()
    const storedUser = getStoredUser()

    if (!token) {
      router.replace("/login")
      return
    }

    if (storedUser && storedUser.role) {
      if (storedUser.role === "ADMIN") {
        router.replace("/dashboard/admin")
        return
      } else if (storedUser.role === "DRIVER") {
        router.replace("/dashboard/driver")
        return
      } else if (storedUser.role === "STUDENT") {
        router.replace("/dashboard/student")
        return
      }
    }

    // 2. Validate with server if no cached role
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Auth request timeout")), 4000)
      )
      const user = await Promise.race([getCurrentUser(), timeoutPromise])

      if (!user || !user.role) {
        throw new Error("No active session detected.")
      }
      setCurrentUser(user)

      if (user.role === "ADMIN") {
        router.replace("/dashboard/admin")
        return
      } else if (user.role === "DRIVER") {
        router.replace("/dashboard/driver")
        return
      } else if (user.role === "STUDENT") {
        router.replace("/dashboard/student")
        return
      }
    } catch (err: any) {
      console.warn("Session check failed:", err)
      router.replace("/login")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    checkAuthAndLoad()
  }, [])

  const handleLogout = () => {
    clearAuthSession()
    setCurrentUser(null)
    router.replace("/login")
  }

  // Loading Screen
  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center text-zinc-300 p-4">
        <div className="h-12 w-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-4 animate-pulse">
          <BusIcon className="h-6 w-6" />
        </div>
        <div className="flex items-center gap-2 text-sm font-medium">
          <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
          <span>Authenticating Transit Session...</span>
        </div>
      </div>
    )
  }

  // Unauthenticated / Session Expired Screen
  if (authError || !currentUser) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
        <div className="max-w-md w-full rounded-2xl border border-zinc-800 bg-zinc-900/90 p-8 text-center shadow-2xl backdrop-blur-md">
          <div className="h-14 w-14 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 mx-auto mb-4">
            <AlertCircle className="h-7 w-7" />
          </div>
          <h2 className="text-xl font-bold text-white">Authentication Required</h2>
          <p className="text-sm text-zinc-400 mt-2">
            {authError || "Please sign in with your verified Institutional credentials (Admin, Driver, or Student)."}
          </p>

          <div className="mt-6 space-y-2">
            <Link
              href="/login"
              className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm transition flex items-center justify-center gap-2 shadow-lg"
            >
              <LogIn className="h-4 w-4" />
              Sign In to Transit Portal
            </Link>

            <Link
              href="/"
              className="w-full py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold transition block text-center"
            >
              Return to Homepage
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const role = currentUser.role

  return (
    <div className={`min-h-screen transition-colors duration-200 ${darkMode ? "bg-zinc-950 text-zinc-100" : "bg-slate-50 text-slate-900"}`}>
      {/* Universal Top Navigation Header */}
      <header className={`sticky top-0 z-40 border-b backdrop-blur-md transition-colors ${
        darkMode ? "bg-zinc-900/80 border-zinc-800" : "bg-white/80 border-slate-200 shadow-sm"
      }`}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2.5 group">
              <div className="h-10 w-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 group-hover:scale-105 transition">
                <BusIcon className="h-5 w-5" />
              </div>
              <div>
                <span className="font-extrabold tracking-tight text-base block leading-tight">
                  SMART BUS <span className="text-emerald-400">TRANSIT</span>
                </span>
                <span className="text-[10px] text-zinc-400 font-mono tracking-wider uppercase block">
                  Institutional Fleet System
                </span>
              </div>
            </Link>
          </div>

          <div className="flex items-center gap-3">
            {/* User Badge */}
            <div className={`hidden sm:flex items-center gap-2.5 px-3 py-1.5 rounded-xl border ${
              darkMode ? "bg-zinc-900 border-zinc-800" : "bg-slate-100 border-slate-200"
            }`}>
              <User className="h-4 w-4 text-zinc-400" />
              <div className="text-left leading-none">
                <span className="text-xs font-bold block">{currentUser.full_name || currentUser.name || currentUser.username}</span>
                <span className="text-[10px] text-zinc-500 font-mono">{currentUser.username}</span>
              </div>
              <span
                className={`ml-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                  role === "ADMIN"
                    ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                    : role === "DRIVER"
                    ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                    : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                }`}
              >
                {role}
              </span>
            </div>

            {/* Dark / Light Toggle */}
            <button
              onClick={() => setDarkMode(!darkMode)}
              className={`p-2 rounded-xl border transition ${
                darkMode ? "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white" : "bg-slate-100 border-slate-200 text-slate-600 hover:text-slate-900"
              }`}
              title="Toggle theme"
            >
              {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>

            {/* Logout Button */}
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 text-xs font-semibold transition"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden md:inline">Sign Out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Role-Based Dashboard View */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {role === "ADMIN" && (
          <AdminDashboard
            overview={overview}
            buses={buses}
            attendance={attendance}
            emergencies={emergencies}
            managedStudents={managedStudents}
            managedDrivers={managedDrivers}
            managedBuses={managedBuses}
            managedFees={managedFees}
            onRefreshAll={loadAdminData}
          />
        )}

        {role === "DRIVER" && (
          <DriverDashboard
            user={{
              username: currentUser.username,
              name: currentUser.full_name || currentUser.name,
              email: currentUser.email,
              phone: currentUser.phone,
              assigned_bus: currentUser.assigned_bus,
              role: currentUser.role,
            }}
          />
        )}

        {role === "STUDENT" && (
          <StudentDashboard
            user={{
              username: currentUser.username,
              name: currentUser.full_name || currentUser.name,
              student_id: currentUser.student_id || currentUser.username,
              email: currentUser.email,
              phone: currentUser.phone,
              department: currentUser.department,
              assigned_bus: currentUser.assigned_bus,
              role: currentUser.role,
            }}
          />
        )}
      </main>
    </div>
  )
}
