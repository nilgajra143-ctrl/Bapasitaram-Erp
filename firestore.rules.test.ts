/**
 * Security Rules Specification Verification (Dirty Dozen Adversarial Suite)
 * Matches security_spec.md and firestore.rules for BAPASITARAM ENTERPRISE ERP.
 */

export const DIRTY_DOZEN_CASES = [
  {
    id: 1,
    name: 'Unauthenticated Vehicle Read',
    operation: 'get /vehicles/veh_1',
    auth: null,
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Unverified Email Write on Driver',
    operation: 'create /drivers/drv_1',
    auth: { uid: 'user_1', email: 'staff@example.com', email_verified: false },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Spoofed Owner ID',
    operation: 'create /vehicles/veh_1 with ownerId="other_uid"',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Shadow Ghost Field Injection',
    operation: 'create /parties/party_1 with extra field isVerified=true',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Email Spoofing Attack (unverified admin email)',
    operation: 'list /trips',
    auth: { uid: 'attacker', email: 'nilgajra143@gmail.com', email_verified: false },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Self-Assigned RBAC Privilege Escalation',
    operation: 'create /erpUsers/emp_1 with role="admin" by non-bootstrap admin',
    auth: { uid: 'user_2', email: 'user2@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Unscoped List Query by Non-Admin',
    operation: 'list /driverPayments without ownerId filter',
    auth: { uid: 'user_2', email: 'user2@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Orphaned Driver Payment Creation (missing driverId)',
    operation: 'create /driverPayments/dp_1 with nonexistent driverId',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Resource Poisoning via Oversized ID',
    operation: 'create /vehicles/' + 'a'.repeat(200),
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Value Poisoning on Trip Update (negative freightAmount, dieselQuantity, or dieselRate)',
    operation: 'update /trips/trip_1 with dieselQuantity=-25 or dieselRate=-10',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Terminal State Tampering on Paid Bill / Settled Trip',
    operation: 'update /bills/paid_bill_1 by non-admin owner',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Audit Log Mutation & Timestamp Forgery',
    operation: 'update or delete /auditLogs/log_1',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 13,
    name: 'Orphaned or Zero-Amount Party Payment Creation',
    operation: 'create /partyPayments/pp_1 with nonexistent partyId or amount <= 0',
    auth: { uid: 'user_1', email: 'user1@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
] as const;
