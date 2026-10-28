"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import {
  Activity,
  AlertTriangle,
  BusFront,
  ChevronRight,
  CircleUserRound,
  Gauge,
  LayoutDashboard,
  Menu,
  Radio,
  ScanFace,
  Search,
  Settings,
  ShieldCheck,
  Ticket,
  Users,
  X,
} from "lucide-react"

import { getCurrentUser, clearAuthSession, getStoredToken } from "@/lib/api"

const API_URL = ""

const nav = [
  ["Overview", LayoutDashboard],
  ["Live Vision", ScanFace],
  ["Emergency", AlertTriangle],
  ["Students", Users],
  ["Passengers", CircleUserRound],
  ["Fleet", BusFront],
  ["Transit Gate", ShieldCheck],
  ["Analytics", Gauge],
  ["Event Log", Activity],
] as const

const events = [
  ["08:44:11", "FACE VERIFIED", "3BR23CD016", "success"],
  ["08:43:02", "ENTRY VERIFIED", "3BR23CD021", "success"],
  ["08:42:28", "BUS-03 GPS UPDATE", "ROYAL CIRCLE", "info"],
  ["08:41:09", "ROUTE CHECKPOINT", "CANTONMENT", "info"],
]

type User = {
  username: string
  role: string
}

export default function Console() {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState("Overview")
  const [user, setUser] = useState<User | null>(null)
  const [checkingAuth, setCheckingAuth] = useState(true)

  useEffect(() => {
    const token = getStoredToken()

    if (!token) {
      clearAuthSession()
      window.location.href = "/login?message=session_expired"
      return
    }

    getCurrentUser()
      .then((data) => {
        if (data.role !== "ADMIN") {
          window.location.href = `/dashboard/${data.role.toLowerCase()}`
          return
        }

        setUser({
          username: data.username,
          role: data.role,
        })
        setCheckingAuth(false)
      })
      .catch(() => {
        clearAuthSession()
        window.location.href = "/login?message=session_expired"
      })
  }, [])

  function handleLogout() {
    clearAuthSession()
    window.location.href = "/login"
  }

  if (checkingAuth) {
    return (
      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#080808",
          color: "#f4f1ea",
          fontSize: "12px",
          letterSpacing: "0.15em",
        }}
      >
        AUTHENTICATING...
      </main>
    )
  }

  return (
    <main className="console">
      <aside className={open ? "console-nav open" : "console-nav"}>
        <div className="console-brand">
          SMART <span>BUS</span>
          <small>TRANSIT CONTROL</small>
        </div>

        <div className="console-section">OPERATIONS</div>

        {nav.map(([name, Icon]) => (
          <button
            className={
              active === name
                ? "console-link active"
                : "console-link"
            }
            onClick={() => {
              setActive(name)
              setOpen(false)
            }}
            key={name}
          >
            <Icon />

            {name}

            {name === "Emergency" && (
              <i className="nav-alert" />
            )}
          </button>
        ))}

        <div className="console-bottom">
          <Link href="/dashboard" className="console-link">
            <LayoutDashboard />
            Full Dashboard
          </Link>

          <Link href="/dashboard" className="console-link">
            <Ticket />
            Attendance Terminal
          </Link>

          <button
            className="console-link"
            onClick={handleLogout}
          >
            <CircleUserRound />
            Logout
          </button>

          <Link
            href="/"
            className="back-link"
          >
            ← Transit Hub
          </Link>
        </div>
      </aside>

      <section className="console-content">
        <header className="console-header">
          <button
            className="console-menu"
            onClick={() => setOpen(!open)}
            aria-label="Toggle navigation"
          >
            {open ? <X /> : <Menu />}
          </button>

          <div>
            <span className="eyebrow">
              CONTROL CENTER / {active.toUpperCase()}
            </span>

            <h1>{active}</h1>
          </div>

          <div className="console-user">
            <span>
              <b>
                {user
                  ? `${user.role} / ${user.username.toUpperCase()}`
                  : "AUTHENTICATING..."}
              </b>

              <small>
                {user
                  ? `CONNECTED / ${user.role}`
                  : "VERIFYING SESSION"}
              </small>
            </span>

            <CircleUserRound />
          </div>
        </header>

        <div className="console-body">
          <div className="console-overview">
            <div className="console-stat">
              <span>ACTIVE VEHICLE</span>

              <strong>BUS-03</strong>

              <small>
                <Radio />
                GPS ACTIVE / BITM-R03
              </small>
            </div>

            <div className="console-stat">
              <span>PASSENGERS</span>

              <strong>
                32 <small>/ 40</small>
              </strong>

              <div className="mini-meter">
                <i style={{ width: '80%' }} />
              </div>

              <small>80% OCCUPANCY</small>
            </div>

            <div className="console-stat">
              <span>VERIFICATION</span>

              <strong>
                98.7
                <small>%</small>
              </strong>

              <small className="positive">
                +2.1% THIS WEEK
              </small>
            </div>

            <div className="console-stat">
              <span>SAFETY STATUS</span>

              <strong className="safe">
                <ShieldCheck />
                CLEAR
              </strong>

              <small>NO ACTIVE INCIDENTS</small>
            </div>
          </div>

          <div className="console-grid">
            <div className="console-main">
              <div className="console-panel vision-console">
                <div className="panel-title">
                  <span>LIVE VISION FEED</span>

                  <span className="live-dot">
                    <i />
                    LIVE / CAMERA 04
                  </span>
                </div>

                <div className="console-camera">
                  <div className="camera-grid" />

                  <div className="face-box">
                    <span>FACE / 01</span>
                  </div>

                  <div className="scanline" />

                  <div className="camera-corner">
                    FRAME 004281
                    <br />
                    1080 × 720
                  </div>
                </div>

                <div className="vision-result">
                  <ScanFace />

                  <div>
                    <span>FACE VERIFIED</span>

                    <b>
                      3BR23CD016 / 98.7%
                    </b>
                  </div>

                  <strong>
                    APPROVED
                    <ShieldCheck />
                  </strong>
                </div>
              </div>

              <div className="console-panel">
                <div className="panel-title">
                  <span>ACTIVE FLEET</span>

                  <span>25 ONLINE</span>
                </div>

                <div className="console-map">
                  <div className="map-grid" />

                  <div className="route route-1" />
                  <div className="route route-2" />

                  <i className="fleet-dot d1" />
                  <i className="fleet-dot d2" />
                  <i className="fleet-dot d3" />

                  <div className="map-label">
                    BUS-03 / LIVE
                  </div>
                </div>
              </div>
            </div>

            <aside className="console-side">
              <div className="console-panel sos-card">
                <div className="panel-title">
                  <span>EMERGENCY SOS</span>

                  <AlertTriangle />
                </div>

                <div className="sos-status">
                  <i />

                  <strong>
                    SYSTEM CLEAR
                  </strong>

                  <span>
                    NO ACTIVE EMERGENCY EVENTS
                  </span>
                </div>

                <Link href="/dashboard" className="inline-flex items-center justify-between w-full px-4 py-3 text-xs font-semibold tracking-wider text-white uppercase bg-zinc-900 border border-zinc-800 rounded-lg hover:bg-zinc-800 transition">
                  OPEN EMERGENCY PANEL
                  <ChevronRight />
                </Link>
              </div>

              <div className="console-panel event-card">
                <div className="panel-title">
                  <span>EVENT LOG</span>

                  <Search />
                </div>

                {events.map(
                  ([time, event, detail, kind]) => (
                    <div
                      className="event-row"
                      key={time}
                    >
                      <time>{time}</time>

                      <span className={kind}>
                        {event}

                        <small>
                          {detail}
                        </small>
                      </span>
                    </div>
                  )
                )}

                <Link href="/dashboard" className="view-all">
                  VIEW ALL IN DASHBOARD
                  <ChevronRight />
                </Link>
              </div>
            </aside>
          </div>

          <div className="console-panel registry">
            <div className="panel-title">
              <span>
                PASSENGER REGISTRY / BUS-03
              </span>

              <span>
                LIVE MANIFEST{" "}
                <i className="live-dot">
                  <i />
                </i>
              </span>
            </div>

            <div className="registry-head">
              <span>STUDENT ID</span>
              <span>NAME</span>
              <span>PICKUP STOP</span>
              <span>BOARDING TIME</span>
              <span>STATUS</span>
            </div>

            {[
              [
                "3BR23CD016",
                "Deepak K",
                "Royal Circle",
                "08:42:17",
              ],
              [
                "3BR23EC045",
                "Anita M",
                "Sudha Cross",
                "08:43:02",
              ],
              [
                "3BR23CS089",
                "Kiran Kumar",
                "DC Office",
                "08:44:11",
              ],
            ].map((row) => (
              <div
                className="registry-row"
                key={row[0]}
              >
                {row.map((x, i) => (
                  <span
                    key={x}
                    className={
                      i === 0 ? "mono" : ""
                    }
                  >
                    {x}
                  </span>
                ))}

                <b>
                  <ShieldCheck />
                  BOARDED
                </b>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  )
}
