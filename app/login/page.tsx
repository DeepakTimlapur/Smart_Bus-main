"use client"

import { FormEvent, useState, useEffect, Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { login, setAuthSession, getStoredToken, getStoredUser, getCurrentUser, clearAuthSession } from "@/lib/api"

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [activeSession, setActiveSession] = useState<{ username: string; role: string; name?: string } | null>(null)

  const quickRoles = [
    { label: "Admin", user: "admin", pass: "admin123", path: "/dashboard/admin", desc: "Full Fleet, Biometrics & Fees" },
    { label: "Driver", user: "driver1", pass: "driver123", path: "/dashboard/driver", desc: "Bus-03 Cockpit & Face Scanner" },
    { label: "Student", user: "3BR23CD016", pass: "student123", path: "/dashboard/student", desc: "Deepak K (Pass & Tracking)" },
  ]

  useEffect(() => {
    const msg = searchParams.get("error") || searchParams.get("message")
    const requestedRole = (searchParams.get("role") || "").toLowerCase()

    if (requestedRole === "admin") {
      setUsername("admin")
      setPassword("admin123")
    } else if (requestedRole === "driver") {
      setUsername("driver1")
      setPassword("driver123")
    } else if (requestedRole === "student") {
      setUsername("3BR23CD016")
      setPassword("student123")
    }

    if (msg === "session_expired" || msg === "expired") {
      clearAuthSession()
      setActiveSession(null)
      setError("Your session has expired. Please log in again.")
      return
    } else if (msg === "unauthorized") {
      setError("You are not authorized to access this section.")
    }

    // Check if an active session already exists in storage without forcing a blind redirect
    const token = getStoredToken()
    const storedUser = getStoredUser()
    if (token && storedUser && storedUser.role) {
      setActiveSession({
        username: storedUser.username,
        role: storedUser.role,
        name: storedUser.name || storedUser.username,
      })
    }
  }, [searchParams])

  function navigateToDashboard(role: string) {
    const target =
      role === "ADMIN"
        ? "/dashboard/admin"
        : role === "DRIVER"
        ? "/dashboard/driver"
        : role === "STUDENT"
        ? "/dashboard/student"
        : "/dashboard"

    if (typeof window !== "undefined") {
      window.location.assign(target)
    } else {
      router.push(target)
    }
  }

  async function handleQuickLogin(user: string, pass: string, targetPath: string) {
    if (loading) return
    setError("")
    setLoading(true)
    setUsername(user)
    setPassword(pass)

    try {
      const data = await login(user.trim(), pass)
      setAuthSession(data)
      if (typeof window !== "undefined") {
        window.location.assign(targetPath)
      } else {
        router.push(targetPath)
      }
    } catch (err: any) {
      console.error("[Smart Transit] Quick login error:", err)
      const errMsg = err?.message || ""
      if (errMsg.includes("connect") || errMsg.includes("Failed to fetch") || errMsg.includes("Network")) {
        setError("Unable to connect to the server. Please try again.")
      } else {
        setError(errMsg || "Invalid username or password")
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (loading) return

    const trimmedUser = username.trim()
    if (!trimmedUser || !password) {
      setError("Please enter both username and password")
      return
    }

    setError("")
    setLoading(true)

    try {
      const data = await login(trimmedUser, password)
      setAuthSession(data)

      // Role-based redirection
      navigateToDashboard(data.role)
    } catch (err: any) {
      console.error("[Smart Transit] Login error:", err)

      const errMsg = err?.message || ""
      if (errMsg.includes("connect") || errMsg.includes("Failed to fetch") || errMsg.includes("Network")) {
        setError("Unable to connect to the server. Please try again.")
      } else if (errMsg.includes("expired")) {
        setError("Your session has expired. Please log in again.")
      } else if (errMsg.includes("authorized")) {
        setError("You are not authorized to access this section.")
      } else {
        setError("Invalid username or password")
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#080808",
        color: "#f4f1ea",
        padding: "24px",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "460px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
          <h1
            style={{
              fontSize: "36px",
              fontWeight: 800,
              letterSpacing: "-0.02em",
              margin: 0,
            }}
          >
            SMART TRANSIT
          </h1>
          <a
            href="/"
            style={{
              fontSize: "12px",
              color: "#888",
              textDecoration: "none",
              padding: "6px 10px",
              borderRadius: "6px",
              border: "1px solid #27272a",
              background: "#18181b",
            }}
          >
            Home
          </a>
        </div>

        <p
          style={{
            opacity: 0.6,
            marginBottom: "24px",
            fontSize: "13px",
            letterSpacing: "0.05em",
          }}
        >
          SECURE CONTROL CENTER ACCESS
        </p>

        {/* Active Session Notification (renders immediately if session exists, avoiding redirect loops) */}
        {activeSession && (
          <div
            id="active-session-banner"
            style={{
              marginBottom: "20px",
              padding: "14px 16px",
              borderRadius: "10px",
              background: "rgba(16, 185, 129, 0.08)",
              border: "1px solid rgba(16, 185, 129, 0.25)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <span style={{ fontSize: "10px", fontWeight: 700, color: "#34d399", textTransform: "uppercase", letterSpacing: "1px" }}>
                  Active Session
                </span>
                <div style={{ fontSize: "13px", fontWeight: 600, color: "#fff", marginTop: "2px" }}>
                  {activeSession.name || activeSession.username} ({activeSession.role})
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  clearAuthSession()
                  setActiveSession(null)
                  setError("")
                }}
                style={{
                  fontSize: "11px",
                  color: "#9ca3af",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                Sign Out
              </button>
            </div>
            <button
              id="btn-continue-to-dashboard"
              type="button"
              onClick={() => navigateToDashboard(activeSession.role)}
              style={{
                width: "100%",
                marginTop: "10px",
                padding: "8px 12px",
                borderRadius: "6px",
                background: "#10b981",
                color: "#000",
                fontSize: "12px",
                fontWeight: 700,
                border: "none",
                cursor: "pointer",
              }}
            >
              Continue to {activeSession.role} Dashboard &rarr;
            </button>
          </div>
        )}

        <div style={{ marginBottom: "24px" }}>
          <div style={{ fontSize: "11px", fontWeight: "bold", letterSpacing: "1px", color: "#888", marginBottom: "8px", textTransform: "uppercase" }}>
            Quick 1-Click Login
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
            {quickRoles.map((r) => (
              <button
                key={r.label}
                id={`btn-quick-login-${r.label.toLowerCase()}`}
                type="button"
                disabled={loading}
                onClick={() => handleQuickLogin(r.user, r.pass, r.path)}
                style={{
                  padding: "10px 6px",
                  background: username.toLowerCase() === r.user.toLowerCase() ? "#22c55e" : "#1a1a1a",
                  color: username.toLowerCase() === r.user.toLowerCase() ? "#000" : "#fff",
                  border: username.toLowerCase() === r.user.toLowerCase() ? "1px solid #22c55e" : "1px solid #333",
                  borderRadius: "6px",
                  fontSize: "12px",
                  fontWeight: "bold",
                  cursor: loading ? "not-allowed" : "pointer",
                  textAlign: "center",
                }}
                title={`Instant 1-click login as ${r.label}`}
              >
                {r.label} Login
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
            {quickRoles.map((r) => (
              <button
                key={`fill-${r.label}`}
                id={`btn-fill-${r.label.toLowerCase()}`}
                type="button"
                onClick={() => {
                  setUsername(r.user)
                  setPassword(r.pass)
                  setError("")
                }}
                style={{
                  flex: 1,
                  padding: "4px 6px",
                  background: "transparent",
                  color: "#777",
                  border: "none",
                  fontSize: "10px",
                  cursor: "pointer",
                  textAlign: "center",
                  textDecoration: "underline",
                }}
              >
                Fill {r.user}
              </button>
            ))}
          </div>
        </div>

        <form
          onSubmit={handleLogin}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "18px",
          }}
        >
          <div>
            <label id="lbl-username" style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "1px", color: "#a1a1aa" }}>
              USERNAME
            </label>

            <input
              id="input-username"
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Enter username"
              required
              autoComplete="username"
              style={{
                display: "block",
                width: "100%",
                marginTop: "8px",
                padding: "14px",
                background: "#151515",
                color: "#fff",
                border: "1px solid #333",
                borderRadius: "6px",
                fontSize: "14px",
              }}
            />
          </div>

          <div>
            <label id="lbl-password" style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "1px", color: "#a1a1aa" }}>
              PASSWORD
            </label>

            <input
              id="input-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter password"
              required
              autoComplete="current-password"
              style={{
                display: "block",
                width: "100%",
                marginTop: "8px",
                padding: "14px",
                background: "#151515",
                color: "#fff",
                border: "1px solid #333",
                borderRadius: "6px",
                fontSize: "14px",
              }}
            />
          </div>

          {error && (
            <p
              id="login-error-message"
              style={{
                color: "#ff6b6b",
                margin: 0,
                fontSize: "13px",
                fontWeight: "500",
                background: "rgba(239, 68, 68, 0.1)",
                padding: "10px 12px",
                borderRadius: "6px",
                border: "1px solid rgba(239, 68, 68, 0.25)",
              }}
            >
              {error}
            </p>
          )}

          <button
            id="btn-submit-login"
            type="submit"
            disabled={loading}
            style={{
              padding: "15px",
              border: "none",
              borderRadius: "6px",
              cursor: loading ? "not-allowed" : "pointer",
              fontWeight: "bold",
              opacity: loading ? 0.7 : 1,
              background: "#22c55e",
              color: "#000",
              fontSize: "14px",
            }}
          >
            {loading ? "AUTHENTICATING..." : "LOGIN"}
          </button>
        </form>
      </div>
    </main>
  )
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div style={{ minHeight: "100vh", background: "#080808", display: "flex", alignItems: "center", justifyContent: "center", color: "#888" }}>
          Loading Smart Transit Login...
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  )
}