"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import {
  BusFront,
  CheckCircle2,
  ShieldAlert,
  Ticket,
  Users,
  Radio,
  ScanFace,
  ChevronRight,
  ArrowRight,
  ShieldCheck,
  Zap,
  Gauge,
  Activity,
  AlertTriangle,
  RotateCcw,
} from "lucide-react"
import { recordAttendanceEvent, type AttendanceEventResult } from "@/lib/api"

export default function SmartTransitHome() {
  const [overview, setOverview] = useState({
    buses: 25,
    students: 250,
    activePassengers: 32,
    incidents: 0,
  })

  const [testResult, setTestResult] = useState<AttendanceEventResult | null>(null)
  const [testLoading, setTestLoading] = useState(false)
  const [selectedBus, setSelectedBus] = useState("BUS-03")
  const [selectedStop, setSelectedStop] = useState("Royal Circle")

  const demoStudents = [
    {
      id: "3BR23CD016",
      name: "Deepak K",
      dept: "CS (Data Science)",
      bus: "BUS-03",
      stop: "Royal Circle",
      status: "PAID",
      pass: "ACTIVE",
      type: "success",
    },
    {
      id: "3BR23EC045",
      name: "Anita M",
      dept: "ECE",
      bus: "BUS-07",
      stop: "Sudha Cross",
      status: "PAID",
      pass: "ACTIVE",
      type: "success",
    },
    {
      id: "3BR23CS089",
      name: "Kiran Kumar",
      dept: "CSE",
      bus: "BUS-03",
      stop: "DC Office",
      status: "UNPAID",
      pass: "ACTIVE",
      type: "denied",
    },
    {
      id: "3BR23ME012",
      name: "Rahul Verma",
      dept: "Mechanical",
      bus: "BUS-03",
      stop: "KSRTC Bus Stand",
      status: "PAID",
      pass: "EXPIRED",
      type: "denied",
    },
  ]

  useEffect(() => {
    fetch("/api/v1/smart-bus/overview")
      .then((res) => res.json())
      .then((data) => {
        if (data && data.total_buses) {
          setOverview({
            buses: data.total_buses,
            students: data.total_students,
            activePassengers: data.active_passengers,
            incidents: data.emergency_events,
          })
        }
      })
      .catch(() => {})
  }, [])

  async function handleSimulateScan(studentId: string) {
    setTestLoading(true)
    setTestResult(null)
    try {
      const result = await recordAttendanceEvent(studentId, selectedBus, selectedStop)
      setTestResult(result)
    } catch (err: any) {
      setTestResult({
        success: false,
        action: "UNKNOWN",
        message: err?.message || "Failed to process entry verification",
      })
    } finally {
      setTestLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#07080a] text-zinc-100 selection:bg-emerald-500 selection:text-black">
      {/* Top Status Bar */}
      <header className="border-b border-zinc-800/80 bg-zinc-950/60 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <BusFront className="h-5 w-5" />
            </div>
            <div>
              <span className="font-bold tracking-tight text-white flex items-center gap-2">
                SMART BUS <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono">OS v2.4</span>
              </span>
              <p className="text-[11px] text-zinc-400 tracking-wider">VISION & IOT TRANSIT SYSTEM</p>
            </div>
          </div>

          <nav className="flex items-center gap-2 sm:gap-4">
            <Link
              href="/dashboard"
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white hover:border-zinc-700 transition"
            >
              Full Dashboard
            </Link>
            <Link
              href="/console"
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white hover:border-zinc-700 transition"
            >
              Operations Console
            </Link>
            <Link
              href="/login"
              className="px-3.5 py-1.5 text-xs font-bold rounded-lg bg-emerald-500 text-black hover:bg-emerald-400 transition"
            >
              Sign In
            </Link>
          </nav>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* Hero Section */}
        <section className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900/60 to-zinc-950 p-6 sm:p-10">
          <div className="max-w-3xl space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-400">
              <Radio className="h-3.5 w-3.5 animate-pulse" />
              All Systems Operational — Unified Full-Stack Architecture
            </div>

            <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight text-white">
              Next-Gen Smart Bus Entry & Fleet Intelligence
            </h1>

            <p className="text-sm sm:text-base text-zinc-400 leading-relaxed">
              Automated transit platform integrating contactless entry verification, Vision facial recognition, real-time IoT driver telemetry, fee auditing, and central fleet dispatch.
            </p>

            <div className="pt-2 flex flex-wrap gap-3">
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white text-black font-semibold text-sm hover:bg-zinc-200 transition shadow-sm"
              >
                Launch Transit Dashboard <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/console"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-zinc-900 border border-zinc-700/70 text-white font-semibold text-sm hover:bg-zinc-800 transition"
              >
                <ScanFace className="h-4 w-4 text-cyan-400" /> Tactical Console
              </Link>
            </div>
          </div>

          {/* Quick Metrics */}
          <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-4 border-t border-zinc-800/80 pt-6">
            <div className="bg-zinc-900/40 p-4 rounded-xl border border-zinc-800/50">
              <span className="text-xs text-zinc-500 font-semibold uppercase tracking-wider block">Active Fleet</span>
              <span className="text-2xl sm:text-3xl font-bold text-white mt-1 block">{overview.buses} Buses</span>
              <span className="text-xs text-emerald-400 flex items-center gap-1 mt-1">
                <CheckCircle2 className="h-3 w-3" /> 100% Online
              </span>
            </div>

            <div className="bg-zinc-900/40 p-4 rounded-xl border border-zinc-800/50">
              <span className="text-xs text-zinc-500 font-semibold uppercase tracking-wider block">Registered Students</span>
              <span className="text-2xl sm:text-3xl font-bold text-white mt-1 block">{overview.students}</span>
              <span className="text-xs text-zinc-400 mt-1 block">Campus ID sync active</span>
            </div>

            <div className="bg-zinc-900/40 p-4 rounded-xl border border-zinc-800/50">
              <span className="text-xs text-zinc-500 font-semibold uppercase tracking-wider block">Currently Boarded</span>
              <span className="text-2xl sm:text-3xl font-bold text-emerald-400 mt-1 block">{overview.activePassengers}</span>
              <span className="text-xs text-zinc-400 mt-1 block">Real-time seat telemetry</span>
            </div>

            <div className="bg-zinc-900/40 p-4 rounded-xl border border-zinc-800/50">
              <span className="text-xs text-zinc-500 font-semibold uppercase tracking-wider block">Safety Status</span>
              <span className="text-2xl sm:text-3xl font-bold text-white mt-1 block flex items-center gap-1.5">
                <ShieldCheck className="h-6 w-6 text-emerald-400" /> Clear
              </span>
              <span className="text-xs text-zinc-400 mt-1 block">0 active emergencies</span>
            </div>
          </div>
        </section>

        {/* Live Interactive Boarding Simulation & Verification */}
        <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-6 sm:p-8 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800/80 pb-5">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-emerald-400 uppercase">
                <Zap className="h-4 w-4" /> Live Verification Sandbox
              </div>
              <h2 className="text-xl sm:text-2xl font-bold text-white mt-1">
                Verify Student Transit Entry & Attendance
              </h2>
              <p className="text-xs sm:text-sm text-zinc-400 mt-0.5">
                Test boarding entry verification, exit recording, and fee compliance checks directly against MongoDB persistence.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <div>
                <label className="text-[11px] font-semibold text-zinc-400 uppercase block mb-1">Target Bus</label>
                <select
                  value={selectedBus}
                  onChange={(e) => setSelectedBus(e.target.value)}
                  className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-emerald-500"
                >
                  <option value="BUS-01">BUS-01 (Cantonment to Main Campus)</option>
                  <option value="BUS-03">BUS-03 (Gandhi Nagar to Siruguppa Rd)</option>
                  <option value="BUS-07">BUS-07 (Railway Station to Campus Hub)</option>
                </select>
              </div>
              <div>
                <label className="text-[11px] font-semibold text-zinc-400 uppercase block mb-1">Stop</label>
                <input
                  type="text"
                  value={selectedStop}
                  onChange={(e) => setSelectedStop(e.target.value)}
                  className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-emerald-500 w-32"
                />
              </div>
            </div>
          </div>

          {/* Test Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {demoStudents.map((s) => (
              <div
                key={s.id}
                className="bg-zinc-900/60 rounded-xl border border-zinc-800 p-4 flex flex-col justify-between hover:border-zinc-700 transition"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between">
                    <div>
                      <span className="font-mono text-xs font-bold text-white block">{s.id}</span>
                      <span className="text-sm font-semibold text-zinc-200 block">{s.name}</span>
                    </div>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                        s.type === "success"
                          ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                          : "bg-red-500/20 text-red-400 border border-red-500/30"
                      }`}
                    >
                      {s.status} / {s.pass}
                    </span>
                  </div>

                  <p className="text-xs text-zinc-400">{s.dept}</p>
                  <div className="text-[11px] text-zinc-500 space-y-0.5">
                    <div>Assigned: <span className="text-zinc-300">{s.bus}</span></div>
                    <div>Stop: <span className="text-zinc-300">{s.stop}</span></div>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={testLoading}
                  onClick={() => handleSimulateScan(s.id)}
                  className={`mt-4 w-full py-2 px-3 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                    s.type === "success"
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30"
                      : "bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30"
                  }`}
                >
                  <ScanFace className="h-3.5 w-3.5" /> Verify Entry / Exit
                </button>
              </div>
            ))}
          </div>

          {/* Test Scan Output Banner */}
          {testResult && (
            <div
              className={`rounded-xl border p-4 text-sm flex items-start justify-between gap-4 ${
                testResult.success
                  ? "bg-emerald-950/40 border-emerald-800/80 text-emerald-200"
                  : "bg-red-950/40 border-red-800/80 text-red-200"
              }`}
            >
              <div className="flex items-start gap-3">
                {testResult.success ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-400 mt-0.5 flex-shrink-0" />
                ) : (
                  <ShieldAlert className="h-5 w-5 text-red-400 mt-0.5 flex-shrink-0" />
                )}
                <div>
                  <div className="font-bold flex items-center gap-2">
                    Action: {testResult.action}
                    {testResult.student_id && (
                      <span className="font-mono text-xs px-2 py-0.5 rounded bg-black/40 text-zinc-200">
                        {testResult.student_id} {testResult.name ? `(${testResult.name})` : ""}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs opacity-90">{testResult.message}</p>
                </div>
              </div>

              <button
                onClick={() => setTestResult(null)}
                className="text-xs px-2.5 py-1 rounded bg-black/40 hover:bg-black/60 text-zinc-300 transition"
              >
                Dismiss
              </button>
            </div>
          )}
        </section>

        {/* 3 Role Dedicated Portals - Task 5: Access Features by Role */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-emerald-400 uppercase">
                <Users className="h-4 w-4" /> Role-Based Access Portals
              </div>
              <h2 className="text-xl sm:text-2xl font-bold text-white mt-1">
                Access Transit Features by Institutional Role
              </h2>
              <p className="text-xs sm:text-sm text-zinc-400 mt-0.5">
                Every role has a tailored dashboard with strict access control, real-time data sync, and instant actions.
              </p>
            </div>
            <Link
              href="/login"
              className="hidden sm:inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 hover:text-emerald-300 transition"
            >
              Switch Account <ChevronRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Admin Role Card */}
            <div className="bg-zinc-950 rounded-2xl border border-purple-500/30 p-6 flex flex-col justify-between hover:border-purple-500/50 transition shadow-lg shadow-purple-950/20">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="h-10 w-10 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-400">
                    <ShieldCheck className="h-5 w-5" />
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 uppercase tracking-wider">
                    ADMIN
                  </span>
                </div>
                <h3 className="text-lg font-bold text-white">Administrator Portal</h3>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Full control center: real-time fleet overview, manage student passes & fees, driver assignments, QR pass generation, and automated SMTP notifications.
                </p>
                <div className="text-[11px] text-zinc-500 font-mono">
                  Demo: <span className="text-zinc-300">admin / admin123</span>
                </div>
              </div>
              <div className="pt-6">
                <Link
                  href="/dashboard/admin"
                  className="w-full py-2.5 px-4 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold text-xs transition flex items-center justify-center gap-2"
                >
                  <span>Open Admin Console</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </div>

            {/* Driver Role Card */}
            <div className="bg-zinc-950 rounded-2xl border border-amber-500/30 p-6 flex flex-col justify-between hover:border-amber-500/50 transition shadow-lg shadow-amber-950/20">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="h-10 w-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
                    <BusFront className="h-5 w-5" />
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 uppercase tracking-wider">
                    DRIVER
                  </span>
                </div>
                <h3 className="text-lg font-bold text-white">Driver Cockpit</h3>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Live bus telemetry console: real-time GPS coordinate broadcasts, 4-face vision recognition scanner, passenger headcount verification, and emergency dispatch alerts.
                </p>
                <div className="text-[11px] text-zinc-500 font-mono">
                  Demo: <span className="text-zinc-300">driver1 / driver123</span>
                </div>
              </div>
              <div className="pt-6 space-y-2">
                <Link
                  href="/dashboard/driver"
                  className="w-full py-2.5 px-4 rounded-xl bg-amber-600 hover:bg-amber-500 text-black font-bold text-xs transition flex items-center justify-center gap-2"
                >
                  <span>Open Driver Cockpit</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
                <Link
                  href="/dashboard/driver/face-recognition"
                  className="w-full py-2 px-3 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 font-medium text-xs transition flex items-center justify-center gap-2"
                >
                  <span>Launch Face Scanner Terminal</span>
                </Link>
              </div>
            </div>

            {/* Student Role Card */}
            <div className="bg-zinc-950 rounded-2xl border border-emerald-500/30 p-6 flex flex-col justify-between hover:border-emerald-500/50 transition shadow-lg shadow-emerald-950/20">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="h-10 w-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                    <Ticket className="h-5 w-5" />
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 uppercase tracking-wider">
                    STUDENT
                  </span>
                </div>
                <h3 className="text-lg font-bold text-white">Student Digital Pass</h3>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Personal transit hub: live bus location tracking, biometric face registration, fee receipt verification, route schedules, and attendance history logs.
                </p>
                <div className="text-[11px] text-zinc-500 font-mono">
                  Demo: <span className="text-zinc-300">3BR23CD016 / student123</span>
                </div>
              </div>
              <div className="pt-6">
                <Link
                  href="/dashboard/student"
                  className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition flex items-center justify-center gap-2"
                >
                  <span>Open Student Pass</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* Credentials helper banner */}
        <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-zinc-800 flex items-center justify-center text-zinc-300">
              <Users className="h-4 w-4" />
            </div>
            <div>
              <span className="font-semibold text-white block">Pre-configured Role Credentials:</span>
              <span className="text-zinc-400">
                Admin: <code className="text-zinc-200 font-mono">admin / admin123</code> | Driver: <code className="text-zinc-200 font-mono">driver1 / driver123</code> | Student: <code className="text-zinc-200 font-mono">3BR23CD016 / student123</code>
              </span>
            </div>
          </div>

          <Link
            href="/login"
            className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black font-bold transition flex-shrink-0"
          >
            Go to Login
          </Link>
        </section>
      </main>
    </div>
  )
}
