import { verifyLedger } from '../governance/ledger.mjs';

export function cmdAuditVerify() {
  const report = verifyLedger();
  console.log(JSON.stringify(report, null, 2));
  return report;
}
