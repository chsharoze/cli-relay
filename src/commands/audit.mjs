import { verifyLedger } from '../governance/ledger.mjs';
import { missingApprovalAnchors, orphanedApprovalEntries } from '../governance/approval.mjs';

export function cmdAuditVerify() {
  const report = verifyLedger();
  // A rollback that removes an approval's anchor leaves the ledger chain intact but the
  // approval unusable. Report those approvals alongside the chain result so the gap is
  // visible even when no hash link is broken.
  const unanchoredApprovals = missingApprovalAnchors();
  if (unanchoredApprovals.length > 0) report.unanchoredApprovals = unanchoredApprovals;
  // The mirror case: an approval's ledger line survived but no approval record references
  // it (for example, an approvals save that failed after the ledger append). Report these
  // loop-review entries so the orphaned chain history is visible.
  const orphanedApprovals = orphanedApprovalEntries();
  if (orphanedApprovals.length > 0) report.orphanedApprovalEntries = orphanedApprovals;
  console.log(JSON.stringify(report, null, 2));
  return report;
}
