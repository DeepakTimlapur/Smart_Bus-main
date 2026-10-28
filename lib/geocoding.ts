/**
 * Smart Bus Geocoding Service
 * Performs reverse geocoding to human-readable address/area.
 * Handles timeouts, network failures, and caching gracefully without blocking GPS storage.
 */

interface GeoAddress {
  area?: string
  city?: string
  state?: string
  country?: string
  formatted?: string
}

// In-memory geocode cache to prevent redundant external queries
const geocodeCache = new Map<string, { data: GeoAddress; timestamp: number }>()
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

// Known campus route hubs for instant offline resolution
const KNOWN_HUBS = [
  { lat: 15.1394, lon: 76.9214, area: "BITM Engineering Campus Gate", city: "Ballari", state: "Karnataka" },
  { lat: 15.1485, lon: 76.9258, area: "KHB Colony Transit Stop", city: "Ballari", state: "Karnataka" },
  { lat: 15.1310, lon: 76.9180, area: "Cantonment Terminal", city: "Ballari", state: "Karnataka" },
  { lat: 15.1550, lon: 76.9380, area: "Moti Circle Bus Bay", city: "Ballari", state: "Karnataka" },
  { lat: 15.1620, lon: 76.9450, area: "Central Bus Stand (KSRTC)", city: "Ballari", state: "Karnataka" },
  { lat: 15.1200, lon: 76.9050, area: "Allipur Cross Stop", city: "Ballari", state: "Karnataka" },
]

function getDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

export async function reverseGeocode(latitude: number, longitude: number): Promise<GeoAddress> {
  const roundedLat = Number(latitude.toFixed(4))
  const roundedLon = Number(longitude.toFixed(4))
  const cacheKey = `${roundedLat},${roundedLon}`

  const cached = geocodeCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data
  }

  // Check known route hubs first (within 350 meters)
  for (const hub of KNOWN_HUBS) {
    if (getDistanceKm(latitude, longitude, hub.lat, hub.lon) < 0.35) {
      const res: GeoAddress = {
        area: hub.area,
        city: hub.city,
        state: hub.state,
        country: "India",
        formatted: `${hub.area}, ${hub.city}, ${hub.state}`,
      }
      geocodeCache.set(cacheKey, { data: res, timestamp: Date.now() })
      return res
    }
  }

  // Query OpenStreetMap Nominatim with safe timeout
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 1800)

    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}`
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "SmartBusSystem-AIStudio/1.0",
        Accept: "application/json",
      },
    })
    clearTimeout(timeoutId)

    if (response.ok) {
      const data = await response.json()
      const addr = data.address || {}
      const area =
        addr.suburb ||
        addr.neighbourhood ||
        addr.road ||
        addr.quarter ||
        addr.village ||
        data.name ||
        "Transit Route"
      const city = addr.city || addr.town || addr.county || "Ballari"
      const state = addr.state || "Karnataka"
      const country = addr.country || "India"

      const result: GeoAddress = {
        area,
        city,
        state,
        country,
        formatted: [area, city, state].filter(Boolean).join(", "),
      }

      geocodeCache.set(cacheKey, { data: result, timestamp: Date.now() })
      return result
    }
  } catch {
    // Fail gracefully without crashing
  }

  // Fallback estimation based on coordinates
  const fallbackArea = `Route Segment (${roundedLat.toFixed(3)}°N, ${roundedLon.toFixed(3)}°E)`
  const fallback: GeoAddress = {
    area: fallbackArea,
    city: "Ballari",
    state: "Karnataka",
    country: "India",
    formatted: `${fallbackArea}, Ballari`,
  }
  geocodeCache.set(cacheKey, { data: fallback, timestamp: Date.now() })
  return fallback
}
