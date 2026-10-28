import { NextResponse } from "next/server"
import { getMongoClientPromise } from "@/lib/mongodb"

export async function GET() {
  try {
    const client = await getMongoClientPromise()
    const database = process.env.MONGODB_DB || "smart_bus_db"
    await client.db(database).command({ ping: 1 })
    return NextResponse.json({ status: "healthy", database: "connected", timestamp: new Date().toISOString() })
  } catch {
    return NextResponse.json(
      { status: "degraded", database: "unavailable", timestamp: new Date().toISOString() },
      { status: 503 }
    )
  }
}
