// Comprehensive End-to-End Test Suite for Smart Bus System
const BASE_URL = "http://localhost:3000/api/v1";

// Deterministic seed vector generator from lib/face-recognition.ts
function generateCanonicalFaceEmbedding(seedString) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < seedString.length; i++) {
    const ch = seedString.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  const vector = new Array(128);
  let s = h1 ^ h2;

  for (let i = 0; i < 128; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    const val = (s / 0x7fffffff) * 2 - 1;
    vector[i] = val;
  }

  let sumSq = 0;
  for (let i = 0; i < 128; i++) sumSq += vector[i] * vector[i];
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < 128; i++) vector[i] = Number((vector[i] / norm).toFixed(6));

  return vector;
}

async function runTests() {
  console.log("==================================================");
  console.log("STARTING SMART BUS SYSTEM END-TO-END VERIFICATION");
  console.log("==================================================\n");

  const results = {
    admin: {},
    driver: {},
    student: {},
    rbac: {},
    database: {},
    smtp: {},
    faceRecognition: {},
  };

  async function api(path, options = {}) {
    const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
    const headers = { ...options.headers };
    let body = options.body;

    if (body && typeof body === "object" && !(body instanceof URLSearchParams)) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }

    const res = await fetch(url, { ...options, headers, body });
    let data;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, ok: res.ok, data };
  }

  // -------------------------------------------------------------
  // 1. ADMIN TEST
  // -------------------------------------------------------------
  console.log("--- 1. ADMIN TESTS ---");
  const adminLoginRes = await api("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "admin", password: "admin123" }),
  });

  const adminToken = adminLoginRes.data?.access_token;
  console.log(`[Admin Login] Status: ${adminLoginRes.status}, Role: ${adminLoginRes.data?.role}, Token: ${adminToken ? "Present" : "Missing"}`);
  results.admin.login = adminLoginRes.status === 200 && adminLoginRes.data?.role === "ADMIN";

  const adminAuthHeader = { Authorization: `Bearer ${adminToken}` };

  // Profile / Session
  const adminMe = await api("/auth/me", { headers: adminAuthHeader });
  console.log(`[Admin /auth/me] Status: ${adminMe.status}, Name: ${adminMe.data?.name}`);
  results.admin.profile = adminMe.status === 200 && adminMe.data?.role === "ADMIN";

  // Students management
  const studentsRes = await api("/smart-bus/management/students", { headers: adminAuthHeader });
  console.log(`[Admin Students] Status: ${studentsRes.status}, Count: ${studentsRes.data?.count}`);
  results.admin.students = studentsRes.status === 200 && Array.isArray(studentsRes.data?.students);

  // Drivers management
  const driversRes = await api("/smart-bus/management/drivers", { headers: adminAuthHeader });
  console.log(`[Admin Drivers] Status: ${driversRes.status}, Count: ${driversRes.data?.count}`);
  results.admin.drivers = driversRes.status === 200 && Array.isArray(driversRes.data?.drivers);

  // Buses management
  const busesRes = await api("/smart-bus/buses", { headers: adminAuthHeader });
  console.log(`[Admin Buses] Status: ${busesRes.status}, Count: ${busesRes.data?.count}`);
  results.admin.buses = busesRes.status === 200 && Array.isArray(busesRes.data?.buses);

  // Fees management
  const feesRes = await api("/smart-bus/management/fees", { headers: adminAuthHeader });
  console.log(`[Admin Fees] Status: ${feesRes.status}, Count: ${feesRes.data?.count}`);
  results.admin.fees = feesRes.status === 200 && Array.isArray(feesRes.data?.fees);

  // Attendance history
  const attendanceRes = await api("/smart-bus/attendance", { headers: adminAuthHeader });
  console.log(`[Admin Attendance] Status: ${attendanceRes.status}, Count: ${attendanceRes.data?.count}`);
  results.admin.attendance = attendanceRes.status === 200 && Array.isArray(attendanceRes.data?.attendance);

  // GPS / Fleet Overview
  const overviewRes = await api("/smart-bus/overview", { headers: adminAuthHeader });
  console.log(`[Admin Overview] Status: ${overviewRes.status}, Total Buses: ${overviewRes.data?.total_buses}, Live Buses: ${overviewRes.data?.live_buses?.length}`);
  results.admin.gps = overviewRes.status === 200 && overviewRes.data?.live_buses?.length > 0;

  // Face Biometrics Stats
  const faceStatsRes = await api("/smart-bus/face/stats", { headers: adminAuthHeader });
  console.log(`[Admin Face Stats] Status: ${faceStatsRes.status}, Registered: ${faceStatsRes.data?.registered_faces}/${faceStatsRes.data?.total_students}`);
  results.admin.faceStats = faceStatsRes.status === 200 && typeof faceStatsRes.data?.registered_faces === "number";

  // Face Re-registration Requests
  const faceRequestsRes = await api("/smart-bus/face/reregistration-requests", { headers: adminAuthHeader });
  console.log(`[Admin Face Requests] Status: ${faceRequestsRes.status}, Requests: ${faceRequestsRes.data?.count}`);
  results.admin.faceRequests = faceRequestsRes.status === 200;

  // -------------------------------------------------------------
  // 2. DRIVER TEST
  // -------------------------------------------------------------
  console.log("\n--- 2. DRIVER TESTS ---");
  const driverLoginRes = await api("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "driver1", password: "driver123" }),
  });
  const driverToken = driverLoginRes.data?.access_token;
  console.log(`[Driver Login] Status: ${driverLoginRes.status}, Role: ${driverLoginRes.data?.role}, Bus: ${driverLoginRes.data?.assigned_bus}`);
  results.driver.login = driverLoginRes.status === 200 && driverLoginRes.data?.role === "DRIVER";

  const driverAuthHeader = { Authorization: `Bearer ${driverToken}` };

  // Profile
  const driverMe = await api("/auth/me", { headers: driverAuthHeader });
  console.log(`[Driver /auth/me] Status: ${driverMe.status}, Assigned Bus: ${driverMe.data?.assigned_bus}`);
  results.driver.profile = driverMe.status === 200 && driverMe.data?.assigned_bus === "BUS-01";

  // Bus details & passengers
  const myBusRes = await api("/smart-bus/buses/BUS-01", { headers: driverAuthHeader });
  console.log(`[Driver Bus Details] Status: ${myBusRes.status}, Passengers: ${myBusRes.data?.passengers}, Capacity: ${myBusRes.data?.capacity}, Available: ${myBusRes.data?.available_seats}`);
  results.driver.busDetails = myBusRes.status === 200 && myBusRes.data?.bus_id === "BUS-01";
  results.driver.passengerCount = typeof myBusRes.data?.passengers === "number";

  // GPS Telemetry Update
  const gpsUpdateRes = await api("/smart-bus/gps", {
    method: "POST",
    headers: driverAuthHeader,
    body: {
      bus_id: "BUS-01",
      latitude: 12.9716,
      longitude: 77.5946,
      speed: 35,
      heading: 90,
      area: "Indiranagar 100ft Rd",
      city: "Bengaluru",
    },
  });
  console.log(`[Driver GPS Update] Status: ${gpsUpdateRes.status}, Message: ${gpsUpdateRes.data?.message}`);
  results.driver.gps = gpsUpdateRes.status === 200;

  // Boarding Event (manual/attendance)
  const boardRes = await api("/smart-bus/attendance", {
    method: "POST",
    headers: driverAuthHeader,
    body: {
      student_id: "3BR23EC045",
      bus_id: "BUS-01",
      stop: "Indiranagar Depot",
      event_type: "BOARDED",
    },
  });
  console.log(`[Driver Boarding Event] Status: ${boardRes.status}, Event: ${boardRes.data?.event_type}, Success: ${boardRes.data?.success}`);
  results.driver.boarding = boardRes.status === 200 && boardRes.data?.success;

  // Exit Event
  const exitRes = await api("/smart-bus/attendance", {
    method: "POST",
    headers: driverAuthHeader,
    body: {
      student_id: "3BR23EC045",
      bus_id: "BUS-01",
      stop: "Indiranagar Depot",
      event_type: "EXITED",
    },
  });
  console.log(`[Driver Exit Event] Status: ${exitRes.status}, Event: ${exitRes.data?.event_type}, Success: ${exitRes.data?.success}`);
  results.driver.exit = exitRes.status === 200 && exitRes.data?.success;

  // -------------------------------------------------------------
  // MULTI-FACE RECOGNITION (4-FACE SIMULTANEOUS PROCESSING)
  // -------------------------------------------------------------
  console.log("\n--- FACE RECOGNITION (4-FACE SIMULTANEOUS PROCESSING) ---");

  // Generate canonical embeddings for:
  // Face 1: 3BR23EC045 (Anita Sharma - fee PAID, registered) -> Should be recognized & boarded!
  // Face 2: 3BR23ME012 (Rahul Verma - fee PENDING/EXPIRED, registered) -> Should be DENIED - FEE NOT VALID!
  // Face 3: UNKNOWN_PERSON_X (not registered) -> Should be UNKNOWN!
  // Face 4: UNKNOWN_PERSON_Y (not registered) -> Should be UNKNOWN!
  const face1Embedding = generateCanonicalFaceEmbedding("3BR23EC045");
  const face2Embedding = generateCanonicalFaceEmbedding("3BR23ME012");
  const face3Embedding = generateCanonicalFaceEmbedding("RANDOM_UNKNOWN_PERSON_1");
  const face4Embedding = generateCanonicalFaceEmbedding("RANDOM_UNKNOWN_PERSON_2");

  const multiFaceRes = await api("/smart-bus/face/recognize", {
    method: "POST",
    headers: driverAuthHeader,
    body: {
      bus_id: "BUS-01",
      stop: "Indiranagar Metro",
      faces: [
        { embedding: face1Embedding, bbox: { x: 50, y: 50, width: 120, height: 150 } },
        { embedding: face2Embedding, bbox: { x: 200, y: 50, width: 120, height: 150 } },
        { embedding: face3Embedding, bbox: { x: 350, y: 50, width: 120, height: 150 } },
        { embedding: face4Embedding, bbox: { x: 500, y: 50, width: 120, height: 150 } },
      ],
    },
  });

  console.log(`[Multi-Face Recognize] Status: ${multiFaceRes.status}, Processed count: ${multiFaceRes.data?.count}`);
  const processedFaces = multiFaceRes.data?.processed_faces || [];
  processedFaces.forEach((f) => {
    console.log(`  Face #${f.face_index}: Student=${f.student_id} (${f.name}), Status=${f.status}, Confidence=${f.confidence}, Fee=${f.fee_status}, Msg=${f.message}`);
  });

  results.faceRecognition.fourFacesProcessed = multiFaceRes.status === 200 && processedFaces.length === 4;

  const validFace = processedFaces.find((f) => f.student_id === "3BR23EC045");
  results.faceRecognition.validStudentBoarded = validFace && (validFace.status === "RECOGNIZED" || validFace.status === "ALREADY BOARDED");

  const feeDeniedFace = processedFaces.find((f) => f.student_id === "3BR23ME012");
  results.faceRecognition.feeValidationDenied = feeDeniedFace && feeDeniedFace.status === "DENIED - FEE NOT VALID";

  const unknownFaces = processedFaces.filter((f) => f.status === "UNKNOWN");
  results.faceRecognition.unknownFacesHandled = unknownFaces.length >= 2;

  // Duplicate Boarding Prevention Test:
  // Now submit face 1 (3BR23EC045) AGAIN while she is already boarded!
  const duplicateFaceRes = await api("/smart-bus/face/recognize", {
    method: "POST",
    headers: driverAuthHeader,
    body: {
      bus_id: "BUS-01",
      stop: "Indiranagar Metro",
      faces: [
        { embedding: face1Embedding, bbox: { x: 50, y: 50, width: 120, height: 150 } },
      ],
    },
  });
  const dupFace = duplicateFaceRes.data?.processed_faces?.[0];
  console.log(`[Duplicate Boarding Test] Status: ${dupFace?.status}, Msg: ${dupFace?.message}`);
  results.faceRecognition.duplicatePrevented = dupFace?.status === "ALREADY BOARDED";

  // Inactive Account Prevention Test
  await api("/smart-bus/management/students/3BR23EC045", {
    method: "PUT",
    headers: adminAuthHeader,
    body: { account_status: "SUSPENDED" }
  });
  const inactiveFaceRes = await api("/smart-bus/face/recognize", {
    method: "POST",
    headers: driverAuthHeader,
    body: {
      bus_id: "BUS-01",
      stop: "Indiranagar Metro",
      faces: [{ embedding: face1Embedding, bbox: { x: 50, y: 50, width: 120, height: 150 } }],
    },
  });
  const inactFace = inactiveFaceRes.data?.processed_faces?.[0];
  console.log(`[Inactive Account Test] Status: ${inactFace?.status}, Msg: ${inactFace?.message}`);
  results.faceRecognition.inactivePrevented = inactFace?.status === "DENIED - INACTIVE ACCOUNT";

  // Restore student
  await api("/smart-bus/management/students/3BR23EC045", {
    method: "PUT",
    headers: adminAuthHeader,
    body: { account_status: "ACTIVE", is_boarded: false }
  });

  // Capacity Protection Test
  await api("/smart-bus/buses/BUS-01", {
    method: "PUT",
    headers: adminAuthHeader,
    body: { capacity: 40, passengers: 40 }
  });
  const capFaceRes = await api("/smart-bus/face/recognize", {
    method: "POST",
    headers: driverAuthHeader,
    body: {
      bus_id: "BUS-01",
      stop: "Indiranagar Metro",
      faces: [{ embedding: face1Embedding, bbox: { x: 50, y: 50, width: 120, height: 150 } }],
    },
  });
  const capFace = capFaceRes.data?.processed_faces?.[0];
  console.log(`[Capacity Reached Test] Status: ${capFace?.status}, Msg: ${capFace?.message}`);
  results.faceRecognition.capacityPrevented = capFace?.status === "DENIED - CAPACITY REACHED";

  // Reset bus back to normal passengers
  await api("/smart-bus/buses/BUS-01", {
    method: "PUT",
    headers: adminAuthHeader,
    body: { capacity: 40, passengers: 30 }
  });

  // Passenger count check
  console.log(`[Passenger Count Updated] Passengers: ${multiFaceRes.data?.bus?.passengers}, Available: ${multiFaceRes.data?.bus?.available_seats}`);
  results.faceRecognition.passengerCountUpdated = typeof multiFaceRes.data?.bus?.passengers === "number";

  // -------------------------------------------------------------
  // 3. STUDENT TEST
  // -------------------------------------------------------------
  console.log("\n--- 3. STUDENT TESTS ---");
  const studentLoginRes = await api("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "3BR23CD016", password: "student123" }),
  });
  const studentToken = studentLoginRes.data?.access_token;
  console.log(`[Student Login] Status: ${studentLoginRes.status}, Role: ${studentLoginRes.data?.role}, ID: ${studentLoginRes.data?.student_id}`);
  results.student.login = studentLoginRes.status === 200 && studentLoginRes.data?.role === "STUDENT";

  const studentAuthHeader = { Authorization: `Bearer ${studentToken}` };

  // Profile / Information
  const studentMe = await api("/auth/me", { headers: studentAuthHeader });
  console.log(`[Student /auth/me] Status: ${studentMe.status}, Name: ${studentMe.data?.name}, Bus: ${studentMe.data?.assigned_bus}`);
  results.student.profile = studentMe.status === 200 && studentMe.data?.student_id === "3BR23CD016";

  // Fee info
  const myFeeRes = await api("/fees/my-fee", { headers: studentAuthHeader });
  console.log(`[Student My Fee] Status: ${myFeeRes.status}, Total: ₹${myFeeRes.data?.fee_total}, Status: ${myFeeRes.data?.fee_status}`);
  results.student.fee = myFeeRes.status === 200 && myFeeRes.data?.student_id === "3BR23CD016";

  // Attendance history
  const myAttendanceRes = await api("/smart-bus/attendance", { headers: studentAuthHeader });
  console.log(`[Student Attendance] Status: ${myAttendanceRes.status}, Records: ${myAttendanceRes.data?.count}`);
  results.student.attendance = myAttendanceRes.status === 200 && Array.isArray(myAttendanceRes.data?.attendance);

  // Live Bus Location
  const myBusLocationRes = await api("/smart-bus/my-bus/location", { headers: studentAuthHeader });
  console.log(`[Student Bus Tracking] Status: ${myBusLocationRes.status}, Bus: ${myBusLocationRes.data?.bus_id}, Lat: ${myBusLocationRes.data?.latitude}, Lng: ${myBusLocationRes.data?.longitude}`);
  results.student.busTracking = myBusLocationRes.status === 200 && myBusLocationRes.data?.bus_id === "BUS-01";

  // Face Registration Status
  const studentFaceStatus = await api("/smart-bus/face/status", { headers: studentAuthHeader });
  console.log(`[Student Face Status] Status: ${studentFaceStatus.status}, Is Registered: ${studentFaceStatus.data?.face_registered}, Can Re-register: ${studentFaceStatus.data?.can_reregister}`);
  results.student.faceStatus = studentFaceStatus.status === 200;

  // Face Registration Test:
  // Student registers their face with 128D embedding
  const deepakEmbedding = generateCanonicalFaceEmbedding("3BR23CD016");
  const faceRegRes = await api("/smart-bus/face/register", {
    method: "POST",
    headers: studentAuthHeader,
    body: {
      face_embedding: deepakEmbedding,
      sample_count: 5,
    },
  });
  console.log(`[Student Face Register] Status: ${faceRegRes.status}, Success: ${faceRegRes.data?.success}, Msg: ${faceRegRes.data?.message || faceRegRes.data?.detail}`);
  results.student.faceRegistration = (faceRegRes.status === 200 && faceRegRes.data?.success) || (faceRegRes.status === 400 && faceRegRes.data?.detail?.includes("already"));

  // Check that duplicate re-registration without approval is prevented:
  const bypassAttempt = await api("/smart-bus/face/register", {
    method: "POST",
    headers: studentAuthHeader,
    body: {
      face_embedding: deepakEmbedding,
      sample_count: 5,
    },
  });
  console.log(`[Bypass Prevention Test] Status: ${bypassAttempt.status}, Detail: ${bypassAttempt.data?.detail}`);
  results.student.bypassPrevented = bypassAttempt.status === 400 && bypassAttempt.data?.detail?.includes("already registered");

  // Re-registration Request Workflow:
  const reregReqRes = await api("/smart-bus/face/reregistration-request", {
    method: "POST",
    headers: studentAuthHeader,
    body: { reason: "Updated haircut and glasses" },
  });
  console.log(`[Student Re-reg Request] Status: ${reregReqRes.status}, Msg: ${reregReqRes.data?.message || reregReqRes.data?.detail}`);
  results.student.reregWorkflow = reregReqRes.status === 200 || (reregReqRes.status === 400 && reregReqRes.data?.detail?.includes("already"));

  // Admin approves re-registration
  const approveRes = await api("/smart-bus/face/reregistration-approve", {
    method: "POST",
    headers: adminAuthHeader,
    body: { student_id: "3BR23CD016", action: "APPROVE", admin_notes: "Approved for testing" },
  });
  console.log(`[Admin Approve Re-reg] Status: ${approveRes.status}, Msg: ${approveRes.data?.message}`);
  results.admin.approveControls = approveRes.status === 200;

  // -------------------------------------------------------------
  // 4. RBAC TESTS
  // -------------------------------------------------------------
  console.log("\n--- 4. RBAC & PERMISSION TESTS ---");

  // Student attempts Admin management students API -> 403
  const rbacStudent1 = await api("/smart-bus/management/students", { headers: studentAuthHeader });
  console.log(`[RBAC] Student -> GET /management/students: Status ${rbacStudent1.status} (Expected 403)`);
  results.rbac.studentToAdmin = rbacStudent1.status === 403;

  // Student attempts Admin management fees API -> 403
  const rbacStudent2 = await api("/smart-bus/management/fees", { headers: studentAuthHeader });
  console.log(`[RBAC] Student -> GET /management/fees: Status ${rbacStudent2.status} (Expected 403)`);
  results.rbac.studentToFees = rbacStudent2.status === 403;

  // Driver attempts Admin management fees API -> 403
  const rbacDriver1 = await api("/smart-bus/management/fees", { headers: driverAuthHeader });
  console.log(`[RBAC] Driver -> GET /management/fees: Status ${rbacDriver1.status} (Expected 403)`);
  results.rbac.driverToFees = rbacDriver1.status === 403;

  // Student attempts Driver Face Recognition API -> 403
  const rbacStudent3 = await api("/smart-bus/face/recognize", {
    method: "POST",
    headers: studentAuthHeader,
    body: { bus_id: "BUS-01", faces: [] },
  });
  console.log(`[RBAC] Student -> POST /face/recognize: Status ${rbacStudent3.status} (Expected 403)`);
  results.rbac.studentToFaceRecognize = rbacStudent3.status === 403;

  // Driver attempts Admin Face Re-registration Approve -> 403
  const rbacDriver2 = await api("/smart-bus/face/reregistration-approve", {
    method: "POST",
    headers: driverAuthHeader,
    body: { student_id: "3BR23CD016", action: "APPROVE" },
  });
  console.log(`[RBAC] Driver -> POST /face/reregistration-approve: Status ${rbacDriver2.status} (Expected 403)`);
  results.rbac.driverToApprove = rbacDriver2.status === 403;

  // Unauthenticated user -> Protected endpoint -> 401
  const rbacUnauth = await api("/auth/me");
  console.log(`[RBAC] Unauthenticated -> GET /auth/me: Status ${rbacUnauth.status} (Expected 401)`);
  results.rbac.unauthenticatedToMe = rbacUnauth.status === 401;

  // -------------------------------------------------------------
  // 5. DATABASE TEST
  // -------------------------------------------------------------
  console.log("\n--- 5. DATABASE TEST ---");
  const healthRes = await api("/health");
  console.log(`[Database Health] Status: ${healthRes.status}, Persistence: ${healthRes.data?.persistence}`);
  
  // Verify Item 14 database fields on attendance records
  const attRes = await api("/smart-bus/attendance", { headers: adminAuthHeader });
  const records = attRes.data?.attendance || [];
  const latestWithAudit = records.find(r => r.driver_id && r.trip_id && r.latitude && r.longitude && r.recognition_status);
  console.log(`[Database Audit Fields Check] Found complete record: ${!!latestWithAudit}`);
  if (latestWithAudit) {
    console.log(`  Fields verified: student_id=${latestWithAudit.student_id}, bus_id=${latestWithAudit.bus_id}, driver_id=${latestWithAudit.driver_id}, trip_id=${latestWithAudit.trip_id}, timestamp=${latestWithAudit.timestamp}, lat=${latestWithAudit.latitude}, lng=${latestWithAudit.longitude}, address=${latestWithAudit.address}, status=${latestWithAudit.recognition_status}`);
  }
  results.database.health = healthRes.status === 200;
  results.database.auditFieldsVerified = !!latestWithAudit;

  // -------------------------------------------------------------
  // 6. SMTP TEST
  // -------------------------------------------------------------
  console.log("\n--- 6. SMTP TEST ---");
  const testStudentId = `TEST_STUDENT_${Date.now().toString().slice(-4)}`;
  const smtpRes = await api("/smart-bus/management/students", {
    method: "POST",
    headers: adminAuthHeader,
    body: {
      student_id: testStudentId,
      name: "E2E Test Student",
      email: "test.student@smartbus.transit.org",
      phone: "+91 99880 00000",
      department: "Computer Science",
      fee_total: 35000,
      fee_paid: 35000,
      bus_id: "BUS-01",
    },
  });
  console.log(`[Create Student + SMTP] Status: ${smtpRes.status}, Sent: ${smtpRes.data?.email_dispatch?.sent}`);
  results.smtp.creationAndFallback = smtpRes.status === 201 && smtpRes.data?.success;

  // Clean up test student
  await api(`/students/${testStudentId}`, { method: "DELETE", headers: adminAuthHeader });

  console.log("\n==================================================");
  console.log("FINAL RESULTS SUMMARY OBJECT:");
  console.log(JSON.stringify(results, null, 2));
  console.log("==================================================");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
