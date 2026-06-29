const A_GRADE = ["\uac74\uc124", "\uc2dc\ud589", "\uc885\ud569\uac74\uc124", "\ubcd1\uc6d0"];
const B_GRADE = ["\uc81c\uc870", "\uae08\uc735", "\uc790\ub3d9\ucc28", "\ub51c\ub7ec", "\ud638\ud154"];
const C_GRADE = ["\ubc95\ubb34", "\uc138\ubb34", "\ud68c\uacc4"];

export function scoreIndustry(industry = "", companyName = "") {
  const text = `${industry} ${companyName}`;
  if (A_GRADE.some((keyword) => text.includes(keyword))) return "A";
  if (B_GRADE.some((keyword) => text.includes(keyword))) return "B";
  if (C_GRADE.some((keyword) => text.includes(keyword))) return "C";
  return "B";
}

export function normalizeIndustry(queryIndustry, sourceCategory = "") {
  return sourceCategory ? sourceCategory.replaceAll(">", " / ").trim() : queryIndustry.trim();
}
