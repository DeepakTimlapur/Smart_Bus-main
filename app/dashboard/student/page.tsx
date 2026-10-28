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
  ArrowRight,
  Eye,
} from "lucide-react"
import {
  getCurrentUser,
  getStoredToken,
  getStoredUser,
  clearAuthSession,
  type CurrentUser,
} from "@/lib/api"
import StudentDashboard from "@/components/smart-bus/StudentDashboard"

export default function StudentDashboardPage() {
  const router = useRouter()
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [unauthorizedRole, setUnauthorizedRole] = useState<string | null>(null)
  const [darkMode, setDarkMode] = useState(true)

  useEffect(() => {
    let isMounted = true

    async function checkStudentAuth() {
      setUnauthorizedRole(null)

      // 1. Fast path: check localStorage first
      const token = getStoredToken()
      const storedUser = getStoredUser()

      if (!token) {
        clearAuthSession()
        router.replace("/login?message=session_expired")
        return
      }

      // Drivers cannot access student pass dashboard
      if (storedUser && storedUser.role === "DRIVER") {
        setUnauthorizedRole(storedUser.role)
        setCurrentUser(storedUser)
        setLoading(false)
        return
      }

      // If stored role is STUDENT or ADMIN, render immediately
      if (storedUser && (storedUser.role === "STUDENT" || storedUser.role === "ADMIN")) {
        setCurrentUser(storedUser)
        setLoading(false)
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

        // Drivers cannot access student pass
        if (user.role === "DRIVER") {
          setUnauthorizedRole(user.role)
          setCurrentUser(user)
          setLoading(false)
          return
        }

        setCurrentUser(user)
      } catch (err: any) {
        if (!isMounted) return

        // If we already have a valid student profile from localStorage, preserve access
        if (storedUser && (storedUser.role === "STUDENT" || storedUser.role === "ADMIN")) {
          console.warn("[Student Dashboard] Auth refresh slow or offline, using stored session:", err)
          setCurrentUser(storedUser)
          setLoading(false)
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

    checkStudentAuth()

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
          <span>Authenticating Student Pass Session...</span>
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
            Student privileges are required for this transport pass. You are currently logged in as a{" "}
            <span className="font-semibold text-white uppercase">{unauthorizedRole}</span>.
          </p>

          <div className="mt-6 space-y-2.5">
            <Link
              href="/dashboard/driver"
              className="w-full py-3 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-semibold text-sm transition flex items-center justify-center gap-2 shadow-lg"
            >
              <span>Go to Driver Cockpit</span>
              <ArrowRight className="h-4 w-4" />
            </Link>

            <button
              onClick={handleLogout}
              className="w-full py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold transition block text-center"
            >
              Sign In with Student Account
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
                  Student Digital Pass &bull; Live Tracker
                </span>
              </div>
            </Link>
          </div>

          <div className="flex items-center gap-3">
            {/* Face Registration Direct Link */}
            <a
              id="header-link-student-face"
              href="#student-face-registration-module"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 text-xs font-bold transition"
            >
              <Eye className="h-3.5 w-3.5" />
              <span>Face ID</span>
            </a>

            {/* User Badge */}
            <div className={`hidden sm:flex items-center gap-2.5 px-3 py-1.5 rounded-xl border ${
              darkMode ? "bg-zinc-900 border-zinc-800" : "bg-slate-100 border-slate-200"
            }`}>
              <User className="h-4 w-4 text-zinc-400" />
              <div className="text-left leading-none">
                <span className="text-xs font-bold block">{currentUser.full_name || currentUser.name || currentUser.username}</span>
                <span className="text-[10px] text-zinc-500 font-mono">{currentUser.student_id || currentUser.username}</span>
              </div>
              <span className="ml-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                STUDENT
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

      {/* Main Student Dashboard View */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
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
      </main>
    </div>
  )
}
