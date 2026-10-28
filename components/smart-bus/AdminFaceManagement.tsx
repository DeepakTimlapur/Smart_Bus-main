"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import {
  Eye,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  Search,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  User,
  Users,
  Check,
  X,
  MessageSquare,
} from "lucide-react"
import {
  getFaceReRegistrationRequests,
  approveFaceReRegistration,
  getFaceStats,
  type FaceReRegistrationRequestItem,
  type FaceStatsResponse,
  type ManagedStudent,
} from "@/lib/api"

interface AdminFaceManagementProps {
  students: ManagedStudent[]
  onRefreshParent?: () => Promise<void>
}

export default function AdminFaceManagement({ students, onRefreshParent }: AdminFaceManagementProps) {
  const [requests, setRequests] = useState<FaceReRegistrationRequestItem[]>([])
  const [stats, setStats] = useState<FaceStatsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<"ALL" | "REGISTERED" | "UNREGISTERED" | "PENDING">("ALL")
  const [actionNotice, setActionNotice] = useState<string | null>(null)

  // Review modal
  const [selectedReq, setSelectedReq] = useState<FaceReRegistrationRequestItem | null>(null)
  const [adminNotes, setAdminNotes] = useState("")

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [reqsRes, statsRes] = await Promise.all([
        getFaceReRegistrationRequests().catch(() => ({ requests: [], count: 0 })),
        getFaceStats().catch(() => null),
      ])
      setRequests(reqsRes.requests || [])
      if (statsRes) setStats(statsRes)
    } catch (err) {
      console.error("Failed to load face management data:", err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const handleApproveOrReject = async (
    studentId: string,
    action: "APPROVE" | "REJECT",
    notes?: string
  ) => {
    setActionLoadingId(studentId)
    setActionNotice(null)
    try {
      const res = await approveFaceReRegistration(studentId, action, notes)
      setActionNotice(res.message)
      setSelectedReq(null)
      setAdminNotes("")
      await loadData()
      if (onRefreshParent) await onRefreshParent()
    } catch (err: any) {
      alert(err?.detail || err?.message || "Failed to process face request.")
    } finally {
      setActionLoadingId(null)
    }
  }

  const pendingRequests = useMemo(() => {
    return requests.filter((r) => r.status === "PENDING")
  }, [requests])

  const filteredStudents = useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    return students.filter((s) => {
      const matchesSearch =
        !q ||
        s.student_id.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        (s.department && s.department.toLowerCase().includes(q))

      if (!matchesSearch) return false

      if (statusFilter === "ALL") return true
      if (statusFilter === "REGISTERED") return Boolean(s.face_registered)
      if (statusFilter === "UNREGISTERED") return !s.face_registered
      if (statusFilter === "PENDING") return s.face_reregistration_status === "PENDING"
      return true
    })
  }, [students, searchQuery, statusFilter])

  return (
    <div className="space-y-6">
      {/* Biometrics Summary KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-400">Total Enrolled</span>
            <Users className="h-4 w-4 text-zinc-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-white mt-2">
            {stats?.total_students ?? students.length}
          </div>
          <span className="text-[11px] text-zinc-500 block mt-0.5">Students in registry</span>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-400">Registered Faces</span>
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-emerald-400 mt-2">
            {stats?.registered_faces ?? students.filter((s) => s.face_registered).length}
          </div>
          <span className="text-[11px] text-zinc-500 block mt-0.5">
            {stats?.registration_rate ?? "0%"} Enrolled
          </span>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-400">Unregistered</span>
            <AlertCircle className="h-4 w-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-amber-400 mt-2">
            {stats?.unregistered_faces ?? students.filter((s) => !s.face_registered).length}
          </div>
          <span className="text-[11px] text-zinc-500 block mt-0.5">Awaiting initial capture</span>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-400">Re-registration Requests</span>
            <Clock className="h-4 w-4 text-indigo-400" />
          </div>
          <div
            className={`text-2xl font-bold font-mono mt-2 ${
              pendingRequests.length > 0 ? "text-indigo-400" : "text-zinc-400"
            }`}
          >
            {pendingRequests.length}
          </div>
          <span className="text-[11px] text-zinc-500 block mt-0.5">Pending approval</span>
        </div>
      </div>

      {actionNotice && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{actionNotice}</span>
          </div>
          <button onClick={() => setActionNotice(null)} className="text-zinc-400 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Pending Re-registration Requests Queue */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-zinc-800">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-white">Face Re-Registration Approvals</h3>
              {pendingRequests.length > 0 && (
                <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  {pendingRequests.length} Action Needed
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">
              Review and approve or reject student requests to reset and register a new facial profile
            </p>
          </div>

          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 transition"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin text-emerald-400" : ""}`} />
            Refresh Queue
          </button>
        </div>

        {pendingRequests.length === 0 ? (
          <div className="p-8 text-center rounded-xl bg-zinc-950/40 border border-zinc-800/60">
            <CheckCircle2 className="h-8 w-8 text-emerald-500/50 mx-auto mb-2" />
            <p className="text-sm font-medium text-zinc-300">All Re-registration Requests Cleared</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              No pending student face update requests are awaiting administrative review.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-400 uppercase tracking-wider border-b border-zinc-800 bg-zinc-950/50">
                <tr>
                  <th className="py-3 px-4">Student</th>
                  <th className="py-3 px-4">Department / Bus</th>
                  <th className="py-3 px-4">Requested At</th>
                  <th className="py-3 px-4">Reason / Notes</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
                {pendingRequests.map((req) => (
                  <tr key={req.request_id} className="hover:bg-zinc-800/30 transition">
                    <td className="py-3 px-4">
                      <div className="font-semibold text-white">{req.student_name}</div>
                      <div className="font-mono text-xs text-zinc-400">{req.student_id}</div>
                    </td>
                    <td className="py-3 px-4 text-xs">
                      <div>{req.department}</div>
                      <span className="inline-block mt-0.5 px-2 py-0.5 rounded font-mono text-[10px] bg-zinc-800 text-zinc-300 border border-zinc-700">
                        {req.bus_id}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-xs text-zinc-400 font-mono">
                      {new Date(req.requested_at).toLocaleDateString()} •{" "}
                      {new Date(req.requested_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td className="py-3 px-4 text-xs text-zinc-300 max-w-xs truncate">
                      {req.admin_notes || "Student requested face update"}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          id={`btn-approve-face-${req.student_id}`}
                          onClick={() => handleApproveOrReject(req.student_id, "APPROVE")}
                          disabled={actionLoadingId === req.student_id}
                          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-sm transition"
                        >
                          <Check className="h-3.5 w-3.5" />
                          Approve
                        </button>
                        <button
                          id={`btn-reject-face-${req.student_id}`}
                          onClick={() => handleApproveOrReject(req.student_id, "REJECT")}
                          disabled={actionLoadingId === req.student_id}
                          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/30 text-xs font-semibold transition"
                        >
                          <X className="h-3.5 w-3.5" />
                          Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Student Biometrics Directory */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-zinc-800">
          <div>
            <h3 className="text-base font-bold text-white">Student Biometric Enrollment Status</h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              Live database tracking of facial embeddings across registered transit students
            </p>
          </div>

          {/* Search & Filter */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="h-3.5 w-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search student or ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 pr-3 py-1.5 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500 transition w-48"
              />
            </div>

            <div className="flex items-center gap-1 bg-zinc-950 p-1 rounded-xl border border-zinc-800 text-xs">
              {(["ALL", "REGISTERED", "UNREGISTERED"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setStatusFilter(mode)}
                  className={`px-2.5 py-1 rounded-lg font-medium transition ${
                    statusFilter === mode
                      ? "bg-zinc-800 text-white font-semibold shadow-sm"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {mode.charAt(0) + mode.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-400 uppercase tracking-wider border-b border-zinc-800 bg-zinc-950/50">
              <tr>
                <th className="py-3 px-4">Student</th>
                <th className="py-3 px-4">Department & Bus</th>
                <th className="py-3 px-4">Biometric Status</th>
                <th className="py-3 px-4">Registration Date</th>
                <th className="py-3 px-4">Transport Fee</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
              {filteredStudents.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-xs text-zinc-500">
                    No students matching the criteria.
                  </td>
                </tr>
              ) : (
                filteredStudents.map((st) => {
                  const isReg = Boolean(st.face_registered)
                  const isPending = st.face_reregistration_status === "PENDING"
                  const isApproved = st.face_reregistration_status === "APPROVED"

                  return (
                    <tr key={st.student_id} className="hover:bg-zinc-800/30 transition">
                      <td className="py-3 px-4">
                        <div className="font-semibold text-white">{st.name}</div>
                        <div className="font-mono text-xs text-zinc-400">{st.student_id}</div>
                      </td>
                      <td className="py-3 px-4 text-xs">
                        <div>{st.department}</div>
                        <span className="font-mono text-[10px] text-zinc-400">{st.assigned_bus}</span>
                      </td>
                      <td className="py-3 px-4">
                        {isPending ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                            <Clock className="h-3 w-3" />
                            Re-reg Pending
                          </span>
                        ) : isApproved ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                            <CheckCircle2 className="h-3 w-3" />
                            Re-reg Approved
                          </span>
                        ) : isReg ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                            <CheckCircle2 className="h-3 w-3" />
                            Face Registered
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700">
                            <AlertCircle className="h-3 w-3 text-amber-400" />
                            Not Registered
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-xs font-mono text-zinc-400">
                        {st.face_registered_at
                          ? new Date(st.face_registered_at).toLocaleDateString()
                          : isReg
                          ? "Enrolled"
                          : "—"}
                      </td>
                      <td className="py-3 px-4 text-xs font-semibold">
                        <span
                          className={
                            st.fee_status === "PAID"
                              ? "text-emerald-400"
                              : st.fee_status === "PARTIAL"
                              ? "text-amber-400"
                              : "text-rose-400"
                          }
                        >
                          {st.fee_status}
                        </span>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
