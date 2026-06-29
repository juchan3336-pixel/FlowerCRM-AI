export function countBy(leads, key) {
  const counts = {};
  for (const lead of leads) {
    const value = lead[key] || "미분류";
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

export function buildSummaryReport(collectionStats, saveResult) {
  return {
    totalAttempts: collectionStats.totalAttempts,
    inserted: saveResult.inserted,
    duplicateExcluded: collectionStats.duplicateExcluded + saveResult.skipped,
    missingPhoneExcluded: collectionStats.missingPhoneExcluded,
    regionMismatchExcluded: collectionStats.regionMismatchExcluded,
    industryMismatchExcluded: collectionStats.industryMismatchExcluded,
    industryCounts: saveResult.industryCounts || {},
    gradeCounts: saveResult.gradeCounts || {},
  };
}

export function printSummaryReport(report) {
  console.log("");
  console.log("수집 요약 리포트");
  console.log("================");
  console.log(`총 수집 시도 수: ${report.totalAttempts}`);
  console.log(`신규 추가 수: ${report.inserted}`);
  console.log(`중복 제외 수: ${report.duplicateExcluded}`);
  console.log(`전화번호 없음 제외 수: ${report.missingPhoneExcluded}`);
  console.log(`지역 불일치 제외 수: ${report.regionMismatchExcluded}`);
  console.log(`업종 불일치 제외 수: ${report.industryMismatchExcluded}`);
  printCounts("업종별 추가 수", report.industryCounts);
  printCounts("등급별 추가 수", report.gradeCounts);
}

function printCounts(title, counts) {
  console.log(`${title}:`);
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    console.log("  - 없음: 0");
    return;
  }
  for (const [name, count] of entries) {
    console.log(`  - ${name}: ${count}`);
  }
}
