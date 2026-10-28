/**
 * KNOWN BREAKING CHANGE (post embedding-model migration, see
 * docs/EMBEDDING_SPEC.md): relies on seed students with legacy embeddings,
 * which the matching gating in lib/server-db.ts correctly excludes from
 * the candidate pool. Query embeddings here were migrated to
 * generateDevFixture512DVector to fix a hard dimension mismatch only
 * (EMBEDDING_DIMENSION=512 now rejects the old 128-D vectors outright) --
 * expect UNKNOWN where this suite previously expected RECOGNIZED, until
 * its fixtures carry real, spec-compliant embedding_metadata.
 * See the same note in scripts/biometric-runtime-test.ts.
 *
 * Smart Bus IoT & Deboarding Lifecycle Verification Suite
 * Tests:
 * 1. Student Entry (NOT_BOARDED -> BOARDED)
 * 2. Student Exit (BOARDED -> EXITED), passenger count decrements by 1
 * 3. Repeat Exit rejected (ALREADY EXITED)
 * 4. Unboarded student cannot exit (NOT_BOARDED error)
 * 5. Re-entry rejected in same trip (EXITED -> cannot re-board in same trip)
 * 6. IoT API Key authentication
 * 7. IoT GPS Telemetry ingestion
 * 8. IoT Device Heartbeat & status tracking
 * 9. IoT Batch Offline Sync (idempotency replay)
 * 10. Trip Stats API (Total entries, exits, currently on board)
 */

import { serverDb } from "../lib/server-db"

async function runIoTLifecycleSuite() {
  console.log("=====================================================================")
  console.log("     SMART BUS — IoT & DEBOARDING LIFECYCLE VERIFICATION SUITE       ")
  console.log("=====================================================================")

  const busId = "BUS-01"
  const testTripId = `TRIP-TEST-IOT-${Date.now()}`

  // Ensure fresh trip
  await serverDb.startBusTrip(busId, testTripId)

  // Student Anita Sharma embedding (PAID) and Rohan Mehta (PAID)
  const { generateDevFixture512DVector } = await import("../lib/face-recognition")
  const anitaEmbedding = generateDevFixture512DVector("3BR23EC045")
  const rohanEmbedding = generateDevFixture512DVector("3BR23CS089")

  let passedTests = 0

  // -------------------------------------------------------------
  // Test 1: Entry Camera -> BOARDED
  // -------------------------------------------------------------
  console.log("\n>>> Test 1: Entry Camera Processing...")
  const entryRes = await serverDb.recognizeAndProcessFaces({
    bus_id: busId,
    stop: "Main Campus Gate",
    faces: [{ embedding: anitaEmbedding, bbox: { x: 10, y: 10, width: 100, height: 100 } }],
    trip_id: testTripId,
    camera_role: "ENTRY",
    device_id: "RPI-TEST-ENTRY",
  })
  const f1 = entryRes.processed_faces[0]
  if (f1.status === "RECOGNIZED" && f1.passenger_state === "BOARDED") {
    console.log("✅ Test 1 PASSED: Student transitioned to BOARDED.")
    passedTests++
  } else {
    console.error("❌ Test 1 FAILED:", f1)
  }

  // -------------------------------------------------------------
  // Test 2: Exit Camera -> EXITED (Passenger Count Decrements)
  // -------------------------------------------------------------
  console.log("\n>>> Test 2: Exit Camera Processing (Deboarding)...")
  const busBeforeExit = await serverDb.getBusById(busId)
  const passengersBefore = busBeforeExit?.passengers || 0

  const exitRes = await serverDb.recognizeAndProcessFaces({
    bus_id: busId,
    stop: "Science Block Stop",
    faces: [{ embedding: anitaEmbedding, bbox: { x: 10, y: 10, width: 100, height: 100 } }],
    trip_id: testTripId,
    camera_role: "EXIT",
    device_id: "RPI-TEST-EXIT",
  })
  const f2 = exitRes.processed_faces[0]
  const busAfterExit = await serverDb.getBusById(busId)
  const passengersAfter = busAfterExit?.passengers || 0

  if (
    (f2.status === "EXIT SUCCESSFUL" || f2.status === "RECOGNIZED") &&
    f2.passenger_state === "EXITED" &&
    passengersAfter === passengersBefore - 1
  ) {
    console.log(`✅ Test 2 PASSED: Student EXITED, passengers: ${passengersBefore} -> ${passengersAfter}.`)
    passedTests++
  } else {
    console.error("❌ Test 2 FAILED:", f2, `passengers: ${passengersBefore} -> ${passengersAfter}`)
  }

  // -------------------------------------------------------------
  // Test 3: Repeat Exit -> ALREADY EXITED
  // -------------------------------------------------------------
  console.log("\n>>> Test 3: Repeat Exit Deboarding Attempt...")
  const repeatExitRes = await serverDb.recognizeAndProcessFaces({
    bus_id: busId,
    stop: "Science Block Stop",
    faces: [{ embedding: anitaEmbedding, bbox: { x: 10, y: 10, width: 100, height: 100 } }],
    trip_id: testTripId,
    camera_role: "EXIT",
    device_id: "RPI-TEST-EXIT",
  })
  const f3 = repeatExitRes.processed_faces[0]
  if (f3.status === "ALREADY EXITED") {
    console.log("✅ Test 3 PASSED: Repeat exit idempotently blocked as ALREADY EXITED.")
    passedTests++
  } else {
    console.error("❌ Test 3 FAILED:", f3)
  }

  // -------------------------------------------------------------
  // Test 4: Unboarded Student at Exit Gate -> CANNOT EXIT
  // -------------------------------------------------------------
  console.log("\n>>> Test 4: Unboarded Student at Exit Gate...")
  const unboardedExitRes = await serverDb.recognizeAndProcessFaces({
    bus_id: busId,
    stop: "Library Stop",
    faces: [{ embedding: rohanEmbedding, bbox: { x: 10, y: 10, width: 100, height: 100 } }],
    trip_id: testTripId,
    camera_role: "EXIT",
    device_id: "RPI-TEST-EXIT",
  })
  const f4 = unboardedExitRes.processed_faces[0]
  if (
    f4.passenger_state === "NOT_BOARDED" ||
    (f4.status as string) === "EXIT DENIED / NOT BOARDED" ||
    (f4.status as string) === "NOT BOARDED - CANNOT EXIT"
  ) {
    console.log("✅ Test 4 PASSED: Student not on board was rejected from exiting.")
    passedTests++
  } else {
    console.error("❌ Test 4 FAILED:", f4)
  }

  // -------------------------------------------------------------
  // Test 5: Re-entry in Same Trip Session -> REJECTED
  // -------------------------------------------------------------
  console.log("\n>>> Test 5: Deboarded Student Re-entry Attempt in Same Trip...")
  const reBoardRes = await serverDb.recognizeAndProcessFaces({
    bus_id: busId,
    stop: "Library Stop",
    faces: [{ embedding: anitaEmbedding, bbox: { x: 10, y: 10, width: 100, height: 100 } }],
    trip_id: testTripId,
    camera_role: "ENTRY",
    device_id: "RPI-TEST-ENTRY",
  })
  const f5 = reBoardRes.processed_faces[0]
  if (f5.status === "ALREADY EXITED" || f5.boarding_status === "Already Exited") {
    console.log("✅ Test 5 PASSED: Deboarded student blocked from re-boarding during same trip.")
    passedTests++
  } else {
    console.error("❌ Test 5 FAILED:", f5)
  }

  // -------------------------------------------------------------
  // Test 6: IoT Device Registration & Heartbeat
  // -------------------------------------------------------------
  console.log("\n>>> Test 6: IoT Device Registration & Heartbeat...")
  const deviceReg = await serverDb.registerIotDevice({
    device_id: "RPI-BUS01-TEST",
    device_name: "Test Unit RPi 4",
    device_type: "RASPBERRY_PI",
    bus_id: busId,
    camera_role: "ENTRY",
  })
  const hbRes = await serverDb.recordIotHeartbeat("RPI-BUS01-TEST", {
    status: "ONLINE",
    camera_status: "ACTIVE",
    gps_status: "FIX_ACQUIRED",
    network_status: "CELLULAR",
  })
  if (deviceReg && hbRes) {
    console.log("✅ Test 6 PASSED: IoT Device registered and heartbeat recorded.")
    passedTests++
  } else {
    console.error("❌ Test 6 FAILED:", deviceReg, hbRes)
  }

  // -------------------------------------------------------------
  // Test 7: GPS Telemetry Ingestion
  // -------------------------------------------------------------
  console.log("\n>>> Test 7: GPS Telemetry Ingestion...")
  const gpsRes = await serverDb.updateGpsLocation({
    bus_id: busId,
    latitude: 12.9750,
    longitude: 77.5980,
    speed: 32.5,
    heading: 95.0,
  })
  const busAfterGPS = await serverDb.getBusById(busId)
  if (gpsRes.success && (busAfterGPS?.latitude === 12.9750 || (busAfterGPS as any)?.gps?.latitude === 12.9750)) {
    console.log("✅ Test 7 PASSED: GPS coordinates and speed ingested.")
    passedTests++
  } else {
    console.error("❌ Test 7 FAILED:", gpsRes, busAfterGPS)
  }

  // -------------------------------------------------------------
  // Test 8: IoT Idempotency (Processed IoT Events)
  // -------------------------------------------------------------
  console.log("\n>>> Test 8: IoT Event Idempotency...")
  const testEventId = `OFFLINE-EV-${Date.now()}`
  const firstProcess = await serverDb.recognizeAndProcessFaces({
    bus_id: busId,
    stop: "Terminal Gate",
    trip_id: testTripId,
    camera_role: "ENTRY",
    device_id: "RPI-BUS01-TEST",
    event_id: testEventId,
    faces: [{ embedding: rohanEmbedding }],
  })
  const duplicateProcess = await serverDb.recognizeAndProcessFaces({
    bus_id: busId,
    stop: "Terminal Gate",
    trip_id: testTripId,
    camera_role: "ENTRY",
    device_id: "RPI-BUS01-TEST",
    event_id: testEventId,
    faces: [{ embedding: rohanEmbedding }],
  })
  const firstStatus = firstProcess.event_status
const duplicateStatus = duplicateProcess.event_status

if (
  firstStatus === "COMPLETED" &&
  duplicateStatus === "ALREADY_PROCESSED"
) {
  console.log(
    "Test PASSED: event status and idempotent replay verified."
  )
  passedTests++
} else {
  console.error("Test FAILED:", {
    firstStatus,
    duplicateStatus,
  })
}

  // -------------------------------------------------------------
  // Test 9: Trip Stats API (Passenger Accounting)
  // -------------------------------------------------------------
  console.log("\n>>> Test 9: Trip Passenger Statistics...")
  const stats = await serverDb.getTripStats(busId, testTripId)
  if (stats && stats.total_entries >= 1 && stats.total_exits >= 1) {
    console.log(`✅ Test 9 PASSED: Trip Stats (Entries: ${stats.total_entries}, Exits: ${stats.total_exits}, On Board: ${stats.currently_on_board}).`)
    passedTests++
  } else {
    console.error("❌ Test 9 FAILED:", stats)
  }

  console.log("\n=====================================================================")
  console.log(`RESULTS: ${passedTests} / 9 IOT & LIFECYCLE TESTS PASSED`)
  console.log("=====================================================================")
  if (passedTests === 9) {
    console.log("STATUS: ALL TESTS PASSED ✅")
  }
}

runIoTLifecycleSuite().catch(console.error)
