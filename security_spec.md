# BAPASITARAM ENTERPRISE Transport ERP — Security Specification

## Phase 0: Data Invariants
1. **Authentication & Verification**: All database reads and writes require `request.auth != null` and `request.auth.token.email_verified == true`.
2. **Ownership & Bootstrap Admin**: Operational records (`Vehicle`, `Party`, `PartyPayment`, `Trip`, `Driver`, `DriverPayment`, `MaintenanceRecord`, `Bill`, `CompanySettings`, `ImportBatch`, `ImportedSheetRow`, `AuditLog`) carry an immutable `ownerId` matching `request.auth.uid` on creation. Only the record owner (`ownerId == request.auth.uid`) or verified admins (`nilgajra143@gmail.com` or `/admins/{uid}`) can access or modify records.
3. **RBAC Role Isolation (`/erpUsers`)**: Only the bootstrap admin (`nilgajra143@gmail.com`) can create, modify, or revoke `ErpUser` role assignments. Employees cannot self-assign or escalate their `role` or permission flags.
4. **Referential Integrity**:
   - A `Trip` requires valid existing `vehicleId` and `partyId`.
   - A `PartyPayment` requires an existing `partyId` in `/parties/{partyId}` and positive `amount > 0`.
   - A `DriverPayment` requires an existing `driverId` in `/drivers/{driverId}`.
   - A `MaintenanceRecord` requires an existing `vehicleId` in `/vehicles/{vehicleId}`.
   - A `Bill` requires an existing `partyId` in `/parties/{partyId}` and bounded `tripIds` / `lineItems` (max 50).
   - An `ImportedSheetRow` requires an existing `batchId` in `/importBatches/{batchId}`.
5. **Terminal State Locking**: Settled/Cancelled `Trip` records and Paid/Cancelled `Bill` records are locked against non-admin updates. `AuditLog`, `ImportBatch`, and `ImportedSheetRow` records are immutable (`allow update: if false`).
6. **Strict Field Allowlisting & Boundary Enforcement**: Every string has `.size()` bounds; every enum is checked; arrays are size-bounded; `createdAt` and `updatedAt` must equal `request.time`.
7. **PII Isolation**: Party contact details, driver phone/license numbers, bank details, and user emails are never exposed via blanket `isSignedIn()` reads or unfiltered `list` queries.

## The "Dirty Dozen" Adversarial Payloads (Must Return PERMISSION_DENIED)
1. **Unauthenticated Read**: `get /vehicles/v1` with `auth: null`.
2. **Unverified Email Write**: `create /drivers/drv_1` with `auth.token.email_verified: false`.
3. **Spoofed Owner ID**: `create /vehicles/v1` where `ownerId != request.auth.uid`.
4. **Shadow Ghost Field Injection**: `create /parties/p1` with all valid fields plus `isVerified: true`.
5. **Email Spoofing Attack**: `list /trips` with `auth.token.email: 'nilgajra143@gmail.com'` and `email_verified: false`.
6. **Self-Assigned RBAC Escalation**: `create /erpUsers/emp_1` by non-bootstrap-admin setting `role: 'admin'`.
7. **Query Trust Bypass**: `list /driverPayments` without `where('ownerId', '==', uid)` by a non-bootstrap-admin user.
8. **Orphaned Relational Record**: `create /driverPayments/dp_1` referencing a non-existent `driverId`.
9. **Resource Poisoning via Oversized ID**: `create /vehicles/<1500-char-id>` violating `isValidId()`.
- **Value Poisoning on Update**: `update /trips/t1` changing `dieselQuantity`, `dieselRate`, or `freightAmount` to a negative number, exceeding bounds, or sending a string.
11. **Terminal State Tampering**: Non-admin user updating a `Trip` whose `tripStatus` is `'Settled'` or a `Bill` whose `status` is `'Paid'`.
12. **Audit Trail Tampering & Timestamp Forgery**: `update /auditLogs/log_1` or `delete /auditLogs/log_1`, or setting `createdAt` to a past client timestamp.

## Security Posture Note
Firestore Security Rules + Google verified authentication + owner/admin isolation strictly enforce authorization and schema bounds on the database layer, while client-side RBAC gates UI actions. No web application can be guaranteed 100% hack-proof; periodically review `firestore.rules` and Audit History.
