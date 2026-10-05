import { verifyLedger } from '../governance/ledger.mjs';
import { missingApprovalAnchors } from '../governance/approval.mjs';

export function cmdAuditVerify() {
  const report = verifyLedger();
  // A rollback that removes an approval's anchor leaves the ledger chain intact but the
  // approval unusable. Report those approvals alongside the chain result so the gap is
  // visible even when no hash link is broken.
  const unanchoredApprovals = missingApprovalAnchors();
  if (unanchoredApprovals.length > 0) report.unanchoredApprovals = unanchoredApprovals;
  console.log(JSON.stringify(report, null, 2));
  return report;
}
