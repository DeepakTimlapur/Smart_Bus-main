"use client"

import { useEffect, useRef, useState } from "react"
import {
  Navigation,
  Crosshair,
  Maximize2,
  RefreshCw,
  MapPin,
  Compass,
  Gauge,
  Clock,
  Shield,
  Layers,
} from "lucide-react"

export interface BusMapMarker {
  bus_id: string
  bus_name?: string
  route?: string
  driver_name?: string
  plate_number?: string
  status: "ACTIVE" | "INACTIVE" | "MAINTENANCE" | string
  latitude: number
  longitude: number
  speed?: number
  heading?: number
  address?: string
  passengers?: number
  capacity?: number
  last_updated?: string
}

interface LiveMapProps {
  buses: BusMapMarker[]
  selectedBusId?: string | null
  onSelectBus?: (busId: string) => void
  height?: string
  showRoutePolyline?: boolean
  routeWaypoints?: Array<[number, number]>
  centerOnBus?: boolean
  autoRefreshIntervalMs?: number
  className?: string
}

export default function LiveMap({
  buses,
  selectedBusId,
  onSelectBus,
  height = "420px",
  showRoutePolyline = true,
  routeWaypoints,
  centerOnBus = true,
  className = "",
}: LiveMapProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapInstanceRef = useRef<any>(null)
  const markersGroupRef = useRef<any>(null)
  const routePolylineRef = useRef<any>(null)
  const [mapReady, setMapReady] = useState(false)
  const [isFollowing, setIsFollowing] = useState(centerOnBus)
  const [activeBusId, setActiveBusId] = useState<string | null>(selectedBusId || null)

  // Sync selectedBusId prop with internal state
  useEffect(() => {
    if (selectedBusId) {
      setActiveBusId(selectedBusId)
    }
  }, [selectedBusId])

  // Initialize Leaflet map on client
  useEffect(() => {
    let isMounted = true

    const initMap = async () => {
      if (!mapContainerRef.current || mapInstanceRef.current) return

      try {
        // Dynamic import of leaflet and its styles
        const L = (await import("leaflet")).default
        // Also import CSS
        await import("leaflet/dist/leaflet.css")

        if (!isMounted || !mapContainerRef.current) return

        // Default initial center (Ballari Transit Center)
        const initialLat = buses[0]?.latitude || 15.1394
        const initialLng = buses[0]?.longitude || 76.9214

        const map = L.map(mapContainerRef.current, {
          center: [initialLat, initialLng],
          zoom: 14,
          zoomControl: false,
          attributionControl: true,
        })

        // CARTO Voyager basemap; allow a custom URL from .env.local
        const cartoTileUrl =
          process.env.NEXT_PUBLIC_CARTO_BASEMAP_URL ||
          "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"

        L.tileLayer(cartoTileUrl, {
          maxZoom: 19,
          subdomains: "abcd",
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        }).addTo(map)

        // Custom zoom control in bottom right
        L.control.zoom({ position: "bottomright" }).addTo(map)

        // Layers group for markers
        const markersGroup = L.layerGroup().addTo(map)
        markersGroupRef.current = markersGroup
        mapInstanceRef.current = map

        setMapReady(true)
      } catch (err) {
        console.error("Failed to initialize Leaflet map:", err)
      }
    }

    initMap()

    return () => {
      isMounted = false
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove()
        mapInstanceRef.current = null
      }
    }
  }, [])

  // Update markers whenever buses, selectedBusId, or mapReady changes
  useEffect(() => {
    if (!mapReady || !mapInstanceRef.current || !markersGroupRef.current) return

    const updateMapContent = async () => {
      const L = (await import("leaflet")).default
      const map = mapInstanceRef.current
      const markersGroup = markersGroupRef.current

      markersGroup.clearLayers()

      if (routePolylineRef.current) {
        map.removeLayer(routePolylineRef.current)
        routePolylineRef.current = null
      }

      if (!buses || buses.length === 0) return

      const bounds = L.latLngBounds([])

      buses.forEach((bus) => {
        if (!bus.latitude || !bus.longitude) return

        const isSelected = activeBusId === bus.bus_id
        const isActive = bus.status === "ACTIVE"
        const speedKmh = Math.round(bus.speed || 0)
        const occPercent = bus.capacity ? Math.round(((bus.passengers || 0) / bus.capacity) * 100) : 0

        // Custom HTML marker pin with pulse animation
        const markerHtml = `
          <div style="position: relative; display: flex; flex-direction: column; align-items: center; cursor: pointer;">
            <div style="
              background: ${isSelected ? "#2563eb" : isActive ? "#2563eb" : "#64748b"};
              color: #ffffff;
              padding: 4px 8px;
              border-radius: 9999px;
              font-size: 11px;
              font-weight: 700;
              letter-spacing: 0.05em;
              display: flex;
              align-items: center;
              gap: 4px;
              box-shadow: 0 2px 8px rgba(15,23,42,0.28);
              border: 2px solid ${isSelected ? "#ffffff" : "rgba(255,255,255,0.7)"};
              white-space: nowrap;
            ">
              <span style="display:inline-block; width: 6px; height: 6px; border-radius: 50%; background: ${isActive ? "#a7f3d0" : "#cbd5e1"}; ${isActive ? "box-shadow: 0 0 8px #a7f3d0;" : ""}"></span>
              ${bus.bus_id}
            </div>
            <div style="
              width: 0;
              height: 0;
              border-left: 5px solid transparent;
              border-right: 5px solid transparent;
              border-top: 6px solid ${isSelected ? "#2563eb" : isActive ? "#2563eb" : "#64748b"};
            "></div>
          </div>
        `

        const customIcon = L.divIcon({
          html: markerHtml,
          className: "custom-bus-marker",
          iconSize: [80, 42],
          iconAnchor: [40, 40],
          popupAnchor: [0, -36],
        })

        const marker = L.marker([bus.latitude, bus.longitude], { icon: customIcon })

        // Detailed popup content
        const popupContent = `
          <div style="font-family: system-ui, -apple-system, sans-serif; color: #1e293b; padding: 4px; min-width: 210px;">
            <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; margin-bottom: 8px;">
              <strong style="font-size: 14px; color: #0f172a;">${bus.bus_id}</strong>
              <span style="
                font-size: 10px;
                font-weight: 700;
                padding: 2px 6px;
                border-radius: 4px;
                background: ${isActive ? "#dcfce7" : "#f1f5f9"};
                color: ${isActive ? "#15803d" : "#475569"};
              ">${bus.status}</span>
            </div>

            <div style="font-size: 11px; line-height: 1.6; color: #334155;">
              <div><strong>Route:</strong> ${bus.route || "Default Route"}</div>
              <div><strong>Driver:</strong> ${bus.driver_name || "Assigned Driver"}</div>
              <div><strong>Speed:</strong> ${speedKmh} km/h</div>
              <div><strong>Occupancy:</strong> ${bus.passengers || 0} / ${bus.capacity || 40} (${occPercent}%)</div>
              <div><strong>Location:</strong> ${bus.address || `${bus.latitude.toFixed(4)}, ${bus.longitude.toFixed(4)}`}</div>
              <div style="font-size: 10px; color: #64748b; margin-top: 4px;">Last update: ${bus.last_updated ? new Date(bus.last_updated).toLocaleTimeString() : "Just now"}</div>
            </div>
          </div>
        `

        marker.bindPopup(popupContent)

        marker.on("click", () => {
          setActiveBusId(bus.bus_id)
          if (onSelectBus) onSelectBus(bus.bus_id)
        })

        markersGroup.addLayer(marker)
        bounds.extend([bus.latitude, bus.longitude])
      })

      // Draw route polyline if specified
      if (showRoutePolyline && routeWaypoints && routeWaypoints.length > 1) {
        const polyline = L.polyline(routeWaypoints, {
          color: "#3b82f6",
          weight: 4,
          opacity: 0.75,
          dashArray: "8, 8",
        }).addTo(map)
        routePolylineRef.current = polyline
      }

      // Auto-centering behavior
      if (isFollowing) {
        const targetBus = buses.find((b) => b.bus_id === activeBusId) || buses[0]
        if (targetBus?.latitude && targetBus?.longitude) {
          map.panTo([targetBus.latitude, targetBus.longitude], { animate: true, duration: 0.8 })
        } else if (bounds.isValid()) {
          map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 })
        }
      }
    }

    updateMapContent()
  }, [buses, activeBusId, isFollowing, mapReady, showRoutePolyline, routeWaypoints, onSelectBus])

  // Center on active bus manually
  const handleRecenter = () => {
    if (!mapInstanceRef.current) return
    const targetBus = buses.find((b) => b.bus_id === activeBusId) || buses[0]
    if (targetBus?.latitude && targetBus?.longitude) {
      mapInstanceRef.current.setView([targetBus.latitude, targetBus.longitude], 15, { animate: true })
      setIsFollowing(true)
    }
  }

  const activeBus = buses.find((b) => b.bus_id === activeBusId) || buses[0]

  return (
    <div
      id="live-bus-map-container"
      className={`relative rounded-2xl overflow-hidden border border-slate-200 bg-white shadow-sm ${className}`}
      style={{ height }}
    >
      {/* Map DOM Element */}
      <div ref={mapContainerRef} className="w-full h-full z-0" />

      {/* Loading overlay while Leaflet initializes */}
      {!mapReady && (
        <div className="absolute inset-0 bg-zinc-950/80 backdrop-blur-sm z-10 flex flex-col items-center justify-center gap-3 text-zinc-400">
          <RefreshCw className="h-6 w-6 animate-spin text-emerald-400" />
          <span className="text-xs font-semibold tracking-wider uppercase">Loading Live Transit Map...</span>
        </div>
      )}

      {/* Top Map HUD: Bus Selector / Status Banner */}
      <div className="absolute top-3 left-3 right-3 z-10 flex flex-wrap items-center justify-between gap-2 pointer-events-none">
        <div className="flex items-center gap-2 pointer-events-auto">
          {buses.length > 1 ? (
            <select
              value={activeBusId || ""}
              onChange={(e) => {
                setActiveBusId(e.target.value)
                if (onSelectBus) onSelectBus(e.target.value)
              }}
              className="px-3 py-1.5 rounded-xl bg-white/95 backdrop-blur-md border border-slate-200 text-xs font-semibold text-slate-800 shadow-md outline-none focus:border-blue-500"
            >
              {buses.map((b) => (
                <option key={b.bus_id} value={b.bus_id}>
                  {b.bus_id} - {b.route || "Active Route"} ({b.status})
                </option>
              ))}
            </select>
          ) : (
            <div className="px-3 py-1.5 rounded-xl bg-white/95 backdrop-blur-md border border-slate-200 text-xs font-bold text-slate-800 shadow-md flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${activeBus?.status === "ACTIVE" ? "bg-emerald-400 animate-pulse" : "bg-zinc-500"}`} />
              <span>{activeBus?.bus_id || "Transit Vehicle"}</span>
              <span className="text-[10px] text-slate-500 font-normal">| {activeBus?.route || "Ballari Transit"}</span>
            </div>
          )}

          {activeBus && (
            <span
              className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border backdrop-blur-md ${
                activeBus.status === "ACTIVE"
                  ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                  : "bg-zinc-800/80 text-zinc-400 border-zinc-700"
              }`}
            >
              {activeBus.status}
            </span>
          )}
        </div>

        {/* Map Controls */}
        <div className="flex items-center gap-1.5 pointer-events-auto">
          <button
            onClick={() => setIsFollowing((prev) => !prev)}
            title={isFollowing ? "Auto-Follow Enabled" : "Auto-Follow Disabled"}
            className={`px-2.5 py-1.5 rounded-xl text-xs font-semibold border backdrop-blur-md shadow-xl transition-colors flex items-center gap-1.5 ${
              isFollowing
                ? "bg-indigo-600 text-white border-indigo-500"
                : "bg-white/95 text-slate-700 border-slate-200 hover:bg-white"
            }`}
          >
            <Navigation className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{isFollowing ? "Following" : "Free Roam"}</span>
          </button>

          <button
            onClick={handleRecenter}
            title="Center on Active Bus"
            className="p-1.5 rounded-xl bg-white/95 backdrop-blur-md text-slate-700 hover:text-blue-600 border border-slate-200 shadow-md"
          >
            <Crosshair className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Bottom Telemetry Bar */}
      {activeBus && (
        <div className="absolute bottom-3 left-3 right-3 z-10 pointer-events-auto">
          <div className="p-3 rounded-xl bg-white/95 backdrop-blur-md border border-slate-200 shadow-lg text-xs text-slate-700 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-rose-400 shrink-0" />
              <div className="min-w-0">
                <span className="text-[10px] text-slate-500 block leading-tight">Coordinates</span>
                <span className="font-mono text-[11px] text-slate-800 truncate block">
                  {activeBus.latitude ? `${activeBus.latitude.toFixed(4)}, ${activeBus.longitude.toFixed(4)}` : "Acquiring..."}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-emerald-400 shrink-0" />
              <div>
                <span className="text-[10px] text-slate-500 block leading-tight">Live Speed</span>
                <span className="font-mono text-[11px] font-bold text-slate-800">
                  {Math.round(activeBus.speed || 0)} km/h
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-indigo-400 shrink-0" />
              <div>
                <span className="text-[10px] text-slate-500 block leading-tight">Passengers</span>
                <span className="font-mono text-[11px] text-slate-800">
                  {activeBus.passengers || 0} / {activeBus.capacity || 40} seats
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-400 shrink-0" />
              <div className="min-w-0">
                <span className="text-[10px] text-slate-500 block leading-tight">Last Telemetry</span>
                <span className="text-[11px] text-slate-600 truncate block">
                  {activeBus.last_updated ? new Date(activeBus.last_updated).toLocaleTimeString() : "Live"}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


