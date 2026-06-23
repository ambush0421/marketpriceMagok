// 미확정 마스킹 보조그룹이 0건인지 검증하는 GOALS 게이트입니다.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dashboardPath = path.join(root, "data", "processed", "magok-commercial-transactions-dashboard.json");
const recoveryPath = path.join(root, "data", "processed", "unresolved-masked-recovery-analysis.json");

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required artifact: ${path.relative(root, filePath)}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const dashboard = readJson(dashboardPath);
const recovery = fs.existsSync(recoveryPath) ? readJson(recoveryPath) : null;

const unresolvedGroups = dashboard.metrics?.masked_parcel_groups ?? dashboard.parcel_groups.filter((group) => group.is_masked_parcel).length;
const unresolvedRecords = dashboard.metrics?.masked_parcel_records ?? dashboard.records.filter((record) => record.is_masked_parcel).length;
const officialMatched = dashboard.metrics?.official_masked_matched_records ?? dashboard.records.filter((record) => record.official_masked_match_key).length;
const highConfidenceLeft = dashboard.metrics?.unresolved_high_confidence_masked_records ?? null;

const result = {
  ok: unresolvedGroups === 0 && unresolvedRecords === 0,
  target: {
    unresolved_groups: 0,
    unresolved_records: 0,
  },
  actual: {
    unresolved_groups: unresolvedGroups,
    unresolved_records: unresolvedRecords,
    official_masked_matched_records: officialMatched,
    unresolved_high_confidence_masked_records: highConfidenceLeft,
    recovery_two_candidate_rows: recovery?.summary?.two_candidate_rows ?? null,
    recovery_no_candidate_rows: recovery?.summary?.no_candidate_rows ?? null,
  },
};

console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  process.exit(1);
}
