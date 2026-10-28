"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import {
  Radio,
  Play,
  Square,
  Navigation,
  MapPin,
  Gauge,
  Clock,
  Compass,
  Sparkles,
  AlertCircle,
  CheckCircle2,
} from "lucide-react"
import { updateBusGPS, startBus, stopBus, type GPSLocation, getBusLocation } from "@/lib/api"
import LiveMap, { type BusMapMarker } from "./LiveMap"

interface DriverGPSProps {
  busId: string
  onStatusChanged?: () => void
}

// Realistic waypoints along Ballari campus transit corridor
const SIMULATED_WAYPOINTS = [
  { lat: 15.1460, lng: 76.9214, area: "Ballari Cantonment Terminal", speed: 28, heading: 140 },
  { lat: 15.1432, lng: 76.9238, area: "Royal Circle Junction", speed: 34, heading: 135 },
  { lat: 15.1398, lng: 76.9272, area: "Station Road Corridor", speed: 42, heading: 120 },
  { lat: 15.1360, lng: 76.9305, area: "Sudha Cross Road", speed: 38, heading: 110 },
  { lat: 15.1322, lng: 76.9338, area: "Cantonment Railway Overbridge", speed: 45, heading: 105 },
  { lat: 15.1285, lng: 76.9365, area: "BITM Main Campus North Gate", speed: 20, heading: 90 },
  { lat: 15.1260, lng: 76.9380, area: "BITM Academic Complex & Bus Depot", speed: 0, heading: 90 },
]

export default function DriverGPS({ busId, onStatusChanged }: DriverGPSProps) {
  const effectiveBusId = busId || "BUS-01"

  const watchId = useRef<number | null>(null)
  const simIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const serverPollRef = useRef<NodeJS.Timeout | null>(null)
  const waypointIndexRef = useRef<number>(0)

  const lastGeocodeRef = useRef<{
    lat: number
    lng: number
    time: number
  } | null>(null)

  const geocodeInFlightRef = useRef(false)

  // Tracking States
  const [gpsMode, setGpsMode] = useState<"REAL" | "SIMULATED">("REAL")
  const [tracking, setTracking] = useState(false)
  const [busServiceActive, setBusServiceActive] = useState(true)
  const [serviceLoading, setServiceLoading] = useState(false)
  const [error, setError] = useState("")
  const [lastUpdate, setLastUpdate] = useState<string | null>(null)

  const [location, setLocation] = useState<{
    latitude: number
    longitude: number
    speed: number | null
    heading: number | null
  }>({
    latitude: 15.1394,
    longitude: 76.9214,
    speed: 35,
    heading: 120,
  })

  const [humanLocation, setHumanLocation] = useState<{
    area?: string
    city?: string
    state?: string
    country?: string
  }>({
    area: "Ballari Cantonment Corridor",
    city: "Ballari",
    state: "Karnataka",
    country: "India",
  })

  // Start Bus Service via API
  const handleStartBus = async () => {
    setServiceLoading(true)
    setError("")
    try {
      await startBus(effectiveBusId)
      setBusServiceActive(true)
      if (onStatusChanged) onStatusChanged()
    } catch (err: any) {
      setError(err?.message || "Failed to activate bus service.")
    } finally {
      setServiceLoading(false)
    }
  }

  // Stop Bus Service via API
  const handleStopBus = async () => {
    setServiceLoading(true)
    setError("")
    try {
      await stopBus(effectiveBusId)
      setBusServiceActive(false)
      stopTracking()
      if (onStatusChanged) onStatusChanged()
    } catch (err: any) {
      setError(err?.message || "Failed to deactivate bus service.")
    } finally {
      setServiceLoading(false)
    }
  }

  // Transmit actual coordinates and periodically resolve the address.
  const transmitLocation = useCallback(
    async (lat: number, lng: number, spd: number | null, hdg: number | null) => {
      try {
        await updateBusGPS(
          effectiveBusId,
          lat,
          lng,
          spd !== null ? spd : undefined,
          hdg !== null ? hdg : undefined
        )

        // Update the marker immediately.
        setLocation({
          latitude: lat,
          longitude: lng,
          speed: spd,
          heading: hdg,
        })

        const now = Date.now()
        const previous = lastGeocodeRef.current
        const movedEnough =
          !previous ||
          Math.abs(lat - previous.lat) >= 0.001 ||
          Math.abs(lng - previous.lng) >= 0.001
        const timeElapsed = !previous || now - previous.time >= 15000

        if (
          !geocodeInFlightRef.current &&
          (!previous || (movedEnough && timeElapsed))
        ) {
          geocodeInFlightRef.current = true

          try {
            const response = await fetch(
              `/api/geocode/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`,
              { cache: "no-store" }
            )

            if (response.ok) {
              const address = await response.json()

              setHumanLocation({
                area: address.area || address.display_name || "Address unavailable",
                city: address.city || "",
                state: address.state || "",
                country: address.country || "",
              })

              lastGeocodeRef.current = {
                lat,
                lng,
                time: Date.now(),
              }
            } else {
              console.warn("Reverse geocoding failed:", response.status)
            }
          } finally {
            geocodeInFlightRef.current = false
          }
        }

        setLastUpdate(new Date().toISOString())
        setError("")
      } catch (err: unknown) {
        console.error("GPS telemetry transmission error:", err)
        setError(
          err instanceof Error
            ? err.message
            : "Failed to transmit GPS telemetry."
        )
      }
    },
    [effectiveBusId]
  )

  // Read the latest GPS position saved by the server (including Raspberry Pi telemetry).
  const fetchServerLocation = useCallback(async () => {
    try {
      const gps = await getBusLocation(effectiveBusId)
      const latitude = Number(gps.latitude)
      const longitude = Number(gps.longitude)

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return

      setLocation({
        latitude,
        longitude,
        speed: gps.speed != null ? Number(gps.speed) : 0,
        heading: gps.heading != null ? Number(gps.heading) : 0,
      })

      const gpsData = gps as GPSLocation & {
        area?: string
        city?: string
        state?: string
        country?: string
        last_gps_time?: string
        timestamp?: string
      }

      setHumanLocation((previous) => ({
        area: gpsData.area || previous.area,
        city: gpsData.city || previous.city,
        state: gpsData.state || previous.state,
        country: gpsData.country || previous.country,
      }))

      setLastUpdate(
        gpsData.last_gps_time || gpsData.timestamp || new Date().toISOString()
      )
    } catch (err) {
      console.error("Failed to fetch server GPS location:", err)
    }
  }, [effectiveBusId])
  // Real GPS Geolocation Watcher
  const startRealTracking = () => {
    if (!navigator.geolocation) {
      setError("GPS geolocation is not supported by this device/browser.")
      return
    }

    stopSimulatedTracking()

    const id = navigator.geolocation.watchPosition(
      (position) => {
        const latitude = position.coords.latitude
        const longitude = position.coords.longitude
        const speed =
          position.coords.speed !== null && !isNaN(position.coords.speed)
            ? Math.max(0, position.coords.speed * 3.6)
            : 30
        const heading =
          position.coords.heading !== null && !isNaN(position.coords.heading)
            ? position.coords.heading
            : 0

        transmitLocation(latitude, longitude, speed, heading)
      },
      (positionError) => {
        switch (positionError.code) {
          case positionError.PERMISSION_DENIED:
            setError("Location permission denied. You can switch to Simulated GPS mode.")
            break
          case positionError.POSITION_UNAVAILABLE:
            setError("GPS location unavailable on device. Switch to Simulated GPS mode.")
            break
          case positionError.TIMEOUT:
            setError("GPS location timed out.")
            break
          default:
            setError("Unable to retrieve device GPS coordinates.")
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 3000,
        timeout: 10000,
      }
    )

    watchId.current = id
    setTracking(true)
  }

  const stopRealTracking = () => {
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current)
      watchId.current = null
    }
  }

  // Simulated GPS Waypoint Runner
  const startSimulatedTracking = () => {
    stopRealTracking()

    if (simIntervalRef.current) {
      clearInterval(simIntervalRef.current)
    }

    // Step immediately to current waypoint
    const stepWaypoint = () => {
      const wp = SIMULATED_WAYPOINTS[waypointIndexRef.current]
      waypointIndexRef.current = (waypointIndexRef.current + 1) % SIMULATED_WAYPOINTS.length

      // Add slight jitter (+/- 0.0001) for natural realism
      const jitterLat = wp.lat + (Math.random() - 0.5) * 0.0002
      const jitterLng = wp.lng + (Math.random() - 0.5) * 0.0002

      transmitLocation(jitterLat, jitterLng, wp.speed, wp.heading)
    }

    stepWaypoint()
    simIntervalRef.current = setInterval(stepWaypoint, 4000)
    setTracking(true)
  }

  const stopSimulatedTracking = () => {
    if (simIntervalRef.current) {
      clearInterval(simIntervalRef.current)
      simIntervalRef.current = null
    }
  }

  const startTracking = () => {
    setError("")
    if (gpsMode === "REAL") {
      startRealTracking()
    } else {
      startSimulatedTracking()
    }
  }

  const stopTracking = () => {
    stopRealTracking()
    stopSimulatedTracking()
    setTracking(false)
  }

  useEffect(() => {
    void fetchServerLocation()

    serverPollRef.current = setInterval(() => {
      void fetchServerLocation()
    }, 3000)

    return () => {
      stopRealTracking()
      stopSimulatedTracking()

      if (serverPollRef.current) {
        clearInterval(serverPollRef.current)
        serverPollRef.current = null
      }
    }
  }, [fetchServerLocation])

  // Prepare marker data for LiveMap
  const mapBuses: BusMapMarker[] = [
    {
      bus_id: effectiveBusId,
      bus_name: `${effectiveBusId} Transit Unit`,
      route: "Campus Transit Corridor",
      driver_name: "Onboard Driver",
      status: busServiceActive ? (tracking ? "ACTIVE" : "IN_TRANSIT") : "INACTIVE",
      latitude: location.latitude,
      longitude: location.longitude,
      speed: location.speed || 0,
      heading: location.heading || 0,
      address: [humanLocation.area, humanLocation.city].filter(Boolean).join(", "),
      last_updated: lastUpdate || undefined,
    },
  ]

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-6 space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-zinc-800/80">
        <div>
          <div className="flex items-center gap-3">
            <h3 className="text-xl font-bold text-white flex items-center gap-2">
              <Radio className={`h-5 w-5 ${tracking ? "text-emerald-400 animate-pulse" : "text-zinc-500"}`} />
              Vehicle Telemetry Transponder
            </h3>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-zinc-800 text-zinc-200 border border-zinc-700">
              {effectiveBusId}
            </span>
          </div>
          <p className="text-xs text-zinc-400 mt-1">
            Broadcasts high-frequency GPS coordinates to students and central transit dispatch
          </p>
        </div>

        {/* Bus Service Controls (Phase 15: Start/Stop Bus Service) */}
        <div className="flex items-center gap-2.5">
          <span
            className={`px-2.5 py-1 rounded-full text-xs font-bold border ${
              busServiceActive
                ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                : "bg-zinc-800 text-zinc-400 border-zinc-700"
            }`}
          >
            {busServiceActive ? "SERVICE ACTIVE" : "SERVICE INACTIVE"}
          </span>

          {busServiceActive ? (
            <button
              id="btn-stop-bus-service"
              onClick={handleStopBus}
              disabled={serviceLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-rose-950/60 hover:bg-rose-900 text-rose-300 border border-rose-800/60 text-xs font-semibold transition"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
              Stop Bus
            </button>
          ) : (
            <button
              id="btn-start-bus-service"
              onClick={handleStartBus}
              disabled={serviceLoading}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition shadow-md shadow-emerald-950/50"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              Start Bus
            </button>
          )}
        </div>
      </div>

      {/* Mode Selector & Prominent Simulated Mode Badge */}
      <div className="p-4 rounded-xl bg-zinc-900/80 border border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold text-zinc-300">Telemetry Source:</span>
          <div className="inline-flex rounded-lg bg-zinc-950 p-1 border border-zinc-800">
            <button
              id="btn-gps-mode-simulated"
              onClick={() => {
                if (tracking) stopTracking()
                setGpsMode("SIMULATED")
              }}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition ${
                gpsMode === "SIMULATED"
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              Simulated Route GPS
            </button>
            <button
              id="btn-gps-mode-real"
              onClick={() => {
                if (tracking) stopTracking()
                setGpsMode("REAL")
              }}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition ${
                gpsMode === "REAL"
                  ? "bg-emerald-600 text-white shadow-sm"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              Real Device Geolocation
            </button>
          </div>
        </div>

        {/* Clear DEMO MODE indicator (Phase 12 / 14 Requirement) */}
        {gpsMode === "SIMULATED" ? (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
            <Sparkles className="h-3.5 w-3.5 text-amber-400" />
            [DEMO / SIMULATED GPS MODE]
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
            <Navigation className="h-3.5 w-3.5 text-emerald-400" />
            [HARDWARE GEOLOCATION ACTIVE]
          </span>
        )}
      </div>

      {/* Telemetry HUD Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Vicinity */}
        <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
          <div className="flex items-center justify-between text-xs text-zinc-400 mb-1">
            <span>Current Vicinity</span>
            <MapPin className="h-3.5 w-3.5 text-emerald-400" />
          </div>
          <p className="font-semibold text-white text-sm truncate">
            {humanLocation.area || "Ballari Transit Road"}
          </p>
          <p className="text-xs text-zinc-500 mt-0.5">
            {[humanLocation.city, humanLocation.state, humanLocation.country].filter(Boolean).join(", ")}
          </p>
        </div>

        {/* Velocity & Heading */}
        <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
          <div className="flex items-center justify-between text-xs text-zinc-400 mb-1">
            <span>Velocity & Heading</span>
            <Gauge className="h-3.5 w-3.5 text-indigo-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-mono font-extrabold text-emerald-400">
              {location.speed !== null ? Math.round(location.speed) : 0}
            </span>
            <span className="text-xs text-zinc-400 font-mono">km/h</span>
            <span className="text-xs text-zinc-500 font-mono ml-auto">
              HDG: {location.heading !== null ? `${Math.round(location.heading)}Â°` : "N/A"}
            </span>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">
            {location.speed && location.speed > 0 ? "Vehicle in transit" : "Stationary at stop"}
          </p>
        </div>

        {/* Coordinates */}
        <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
          <div className="flex items-center justify-between text-xs text-zinc-400 mb-1">
            <span>Coordinates</span>
            <Compass className="h-3.5 w-3.5 text-amber-400" />
          </div>
          <div className="font-mono text-xs text-zinc-200 space-y-0.5">
            <p>LAT: {location.latitude.toFixed(6)}Â° N</p>
            <p>LNG: {location.longitude.toFixed(6)}Â° E</p>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">
            {lastUpdate ? `Last ping: ${lastUpdate}` : "Awaiting broadcast"}
          </p>
        </div>
      </div>

      {/* Error alert */}
      {error && (
        <div className="p-3.5 rounded-xl border border-rose-900/60 bg-rose-950/30 text-xs text-rose-300 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
          <span>{error}</span>
        </div>
      )}

      {/* Action Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <div className="flex items-center gap-2">
          {!tracking ? (
            <button
              id="btn-start-gps-broadcast"
              onClick={startTracking}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white hover:bg-zinc-200 text-black text-sm font-bold transition shadow-md"
            >
              <Radio className="h-4 w-4 text-black animate-pulse" />
              <span>Start GPS Broadcast</span>
            </button>
          ) : (
            <button
              id="btn-stop-gps-broadcast"
              onClick={stopTracking}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl border border-rose-800 bg-rose-950/40 hover:bg-rose-950/70 text-rose-300 text-sm font-semibold transition"
            >
              <Square className="h-4 w-4 fill-current" />
              <span>Halt Broadcast</span>
            </button>
          )}

          {tracking && (
            <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium ml-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping" />
              Transmitting packets every 3-4s
            </span>
          )}
        </div>

        {lastUpdate && (
          <span className="text-xs font-mono text-zinc-500">
            Last Transmit: {lastUpdate}
          </span>
        )}
      </div>

      {/* Interactive OpenStreetMap via Leaflet */}
      <div className="pt-1">
        <div className="text-xs font-semibold text-zinc-400 mb-2 flex items-center justify-between">
          <span>Live Vehicle Track on OpenStreetMap</span>
          <span className="font-mono text-[11px] text-zinc-500">Leaflet v1.9</span>
        </div>
        <LiveMap
          buses={mapBuses}
          selectedBusId={effectiveBusId}
          height="460px"
          showRoutePolyline={true}
          centerOnBus={true}
        />
      </div>
    </div>
  )
}



