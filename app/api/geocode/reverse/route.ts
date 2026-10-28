import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const lat = Number(request.nextUrl.searchParams.get("lat"));
  const lon = Number(request.nextUrl.searchParams.get("lon"));

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return NextResponse.json(
      { error: "Valid latitude and longitude are required." },
      { status: 400 }
    );
  }

  try {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("zoom", "18");

    const response = await fetch(url, {
      headers: {
        "User-Agent": "SmartBusTransit/1.0 (GPS tracking application)",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "Geocoding provider request failed." },
        { status: 502 }
      );
    }

    const data = await response.json();
    const a = data.address ?? {};

    return NextResponse.json({
      display_name: data.display_name ?? "",
      area:
        a.road ??
        a.neighbourhood ??
        a.suburb ??
        a.residential ??
        a.village ??
        a.town ??
        a.city ??
        "",
      city: a.city ?? a.town ?? a.village ?? a.municipality ?? "",
      state: a.state ?? "",
      country: a.country ?? "",
      latitude: lat,
      longitude: lon,
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to resolve this GPS location." },
      { status: 502 }
    );
  }
}
