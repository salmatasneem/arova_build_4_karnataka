# Security Specification — SmartCare AI (AROVA) Firestore Rules

## 1. Data Invariants
1. **Identity & Privilege Isolation**: No user may self-assign `role: "admin"` during `users/{userId}` creation or change their own `role` or `accountStatus` on update unless already verified by `isAdmin()`.
2. **PII Isolation**: User email, raw phone numbers, and emergency notes reside strictly in `/users/{userId}/private/{docId}` (readable/writable only by owner or admin). Shared/linked collections (`caregiverContacts`, `voiceCallHistory`) store ONLY masked phone numbers (`maskedPhone`), never raw unmasked numbers.
3. **Patient Scope & Master Gate**: Readings and alerts under `/patients/{patientId}` cannot be created unless the parent `/patients/{patientId}` document exists and the caller is the owning patient or an administrator.
4. **Explicit Consent & Authorization Bounds**: `caregiverContacts/{contactId}` enforces explicit booleans (`explicitCallConsent`, `authorizedForPatientIdentity`, `authorizedForHealthReadings`), strict language enums (`en`, `kn`, `hi`), and priority enums (`primary`, `secondary`, `alternate`). Only the patient owner or an admin may register or update caregiver contacts.
5. **Terminal State Locking**: Once an alert's `status` transitions to `"resolved"`, or a `voiceCallHistory` record reaches `"Completed"`/`"Failed"`, non-admin users cannot reopen or tamper with terminal records.
6. **Immutable Audit Logs & Anomaly Events**: `voiceAuditLogs/{auditId}`, `audit_logs/{logId}`, and `anomaly_events/{eventId}` are strictly append-only (`allow update: if false; allow delete: if isAdmin();`) and require `createdAt == request.time`.
7. **Temporal & Ownership Integrity**: `createdAt`, `ownerUid`/`patientOwnerUid` fields are immutable on update; `createdAt` and `updatedAt` must strictly equal `request.time`.
8. **Zero Unbounded Arrays & Strict Keys**: Every document enforces `hasAll` + `hasOnly` on create and `affectedKeys().hasOnly(...)` on update, with bounded arrays (`triggeredMetrics.size() <= 8`, `callLog.size() <= 12`) and strict string `.size()` limits.
9. **Caregiver Scope & Baseline Protection**: `baselines/{baselineId}` and `anomaly_events/{eventId}` allow read access only to the owning patient, explicitly linked primary/secondary caregivers, or verified administrators.

## 2. Dirty Dozen Adversarial Payloads (Expected: PERMISSION_DENIED)
1. **Self-Admin Escalation**: `users/{uid}` create with `{ uid, displayName: "Attacker", role: "admin", createdAt: serverTimestamp(), updatedAt: serverTimestamp() }` by non-admin.
2. **Ghost Field Injection (Shadow Update)**: `patients/{id}` or `caregiverContacts/{id}` update adding `{ isVerifiedClinical: true }` or `{ rawPhone: "+14155550199" }` alongside valid `updatedAt`.
3. **Unverified Email Spoof**: Request where `request.auth.token.email == "aasiyahadiya7575@gmail.com"`, `"salmatasneem75@gmail.com"`, or `"salmatasneem692@gmail.com"` and `email_verified == false`.
4. **Cross-User PII Snooping**: Authenticated user B attempting `get` on `/users/{userA}/private/contact`.
5. **Blanket List Scraping**: Unfiltered `list` query on `/patients`, `/caregiverContacts`, `/voiceCallHistory`, `/baselines`, `/anomaly_events`, or `/audit_logs` attempting to read records belonging to unrelated users.
6. **Orphaned Reading / Contact Injection**: Creating `/patients/nonexistent_id/readings/r1` or `/caregiverContacts/c1` referencing a nonexistent `patientId`.
7. **ID Poisoning (Denial of Wallet)**: Creating `/devices/{1500_char_string}` or `/voiceCallHistory/bad$id`.
8. **Type / Boundary Poisoning**: Updating `caregiverResponse` with a 2,000-character string or arbitrary enum not in the 8 allowed response categories.
9. **Terminal Alert / Call Record Reopening**: Non-admin attempting to update a `Completed` `voiceCallHistory` record back to `Initiated` or a `resolved` alert back to `active`.
10. **Owner Hijack on Update**: Changing `patientOwnerUid` on `/caregiverContacts/{id}` or `ownerUid` on `/patients/{id}` or changing `role` on `/users/{id}` without admin privileges.
11. **Backdated Timestamp Spoof**: Creating a `voiceAuditLogs/{auditId}`, `audit_logs/{logId}`, or `readings/{readingId}` with a client-supplied past timestamp instead of `request.time`.
12. **Audit Log Tampering**: Attempting `update` on `/voiceAuditLogs/{auditId}` or `/audit_logs/{logId}` to alter historical escalation/auth audit entries.
