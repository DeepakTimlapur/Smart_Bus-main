"use client"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  Bus as BusIcon,
  User,
  LogOut,
  Sun,
  Moon,
  Loader2,
  ShieldAlert,
  LogIn,
  ArrowRight,
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

export default function AdminDashboardPage() {
  const router = useRouter()
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [unauthorizedRole, setUnauthorizedRole] = useState<string | null>(null)
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

  // SMARTBUS_AUTO_REFRESH: refresh only after admin authentication.
  useEffect(() => {
    if (currentUser?.role !== "ADMIN" || unauthorizedRole !== null) return

    const refreshId = window.setInterval(() => {
      void loadAdminData()
    }, 5000)

    return () => window.clearInterval(refreshId)
  }, [currentUser?.role, unauthorizedRole])
  useEffect(() => {
    let isMounted = true

    async function checkAdminAuth() {
      setUnauthorizedRole(null)

      // 1. Fast path: check localStorage first
      const token = getStoredToken()
      const storedUser = getStoredUser()

      if (!token) {
        clearAuthSession()
        router.replace("/login?message=session_expired")
        return
      }

      // If stored role is not ADMIN, block immediately
      if (storedUser && storedUser.role !== "ADMIN") {
        setUnauthorizedRole(storedUser.role)
        setCurrentUser(storedUser)
        setLoading(false)
        return
      }

      // If stored role is ADMIN, render immediately and fetch data
      if (storedUser && storedUser.role === "ADMIN") {
        setCurrentUser(storedUser)
        setLoading(false)
        loadAdminData()
      }

      // 2. Validate/refresh session with server (with timeout race to never hang)
      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Auth request timeout")), 4000)
        )
        const user = await Promise.race([getCurrentUser(), timeoutPromise])

        if (!isMounted) return

        if (!user || !user.role) {
          clearAuthSession()
          router.replace("/login?message=session_expired")
          return
        }

        // Role-Based Access Control: Admin only
        if (user.role !== "ADMIN") {
          setUnauthorizedRole(user.role)
          setCurrentUser(user)
          setLoading(false)
          return
        }

        setCurrentUser(user)
        await loadAdminData()
      } catch (err) {
        if (!isMounted) return

        // If we already had a valid admin profile from localStorage, preserve access
        if (storedUser && storedUser.role === "ADMIN") {
          console.warn("[Admin Dashboard] Auth refresh slow or offline, using stored session:", err)
          setCurrentUser(storedUser)
          setLoading(false)
          loadAdminData()
          return
        }

        clearAuthSession()
        router.replace("/login?message=session_expired")
      } finally {
        if (isMounted) {
          setLoading(false)
        }
      }
    }

    checkAdminAuth()

    return () => {
      isMounted = false
    }
  }, [router])

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
          <span>Authenticating Administrator Privileges...</span>
        </div>
      </div>
    )
  }

  // 403 Forbidden Screen: Unauthorized access
  if (unauthorizedRole) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
        <div className="max-w-md w-full rounded-2xl border border-rose-500/30 bg-zinc-900/90 p-8 text-center shadow-2xl backdrop-blur-md">
          <div className="h-14 w-14 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400 mx-auto mb-4">
            <ShieldAlert className="h-7 w-7" />
          </div>
          <h2 className="text-xl font-bold text-white">Access Denied</h2>
          <p className="text-sm font-medium text-rose-400 mt-2">
            You are not authorized to access this section.
          </p>
          <p className="text-xs text-zinc-400 mt-1">
            Administrator privileges are required to access this portal. You are currently logged in as a{" "}
            <span className="font-semibold text-white uppercase">{unauthorizedRole}</span>.
          </p>

          <div className="mt-6 space-y-2.5">
            <Link
              href={unauthorizedRole === "DRIVER" ? "/dashboard/driver" : "/dashboard/student"}
              className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm transition flex items-center justify-center gap-2 shadow-lg"
            >
              <span>Go to your {unauthorizedRole} Dashboard</span>
              <ArrowRight className="h-4 w-4" />
            </Link>

            <button
              onClick={handleLogout}
              className="w-full py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold transition block text-center"
            >
              Sign In with a Different Account
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!currentUser) return null

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
                  Institutional Fleet System &bull; Admin Console
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
              <span className="ml-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-purple-500/20 text-purple-400 border border-purple-500/30">
                ADMIN
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
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 text-xs font-semibold transition cursor-pointer"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden md:inline">Sign Out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Admin Dashboard View */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
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
      </main>
    </div>
  )
}



