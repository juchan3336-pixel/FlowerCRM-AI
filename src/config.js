export const DEFAULT_REGIONS = ["\ubd80\uc0b0", "\uae40\ud574", "\uc591\uc0b0", "\ucc3d\uc6d0", "\uc6b8\uc0b0"];

export const DEFAULT_INDUSTRIES = [
  "\uac74\uc124\ud68c\uc0ac",
  "\uc2dc\ud589\uc0ac",
  "\uc885\ud569\uac74\uc124",
  "\ubcd1\uc6d0",
  "\uc81c\uc870\uc5c5",
  "\ubc95\ubb34\ubc95\uc778",
  "\uc138\ubb34\ubc95\uc778",
  "\ud68c\uacc4\ubc95\uc778",
  "\uc790\ub3d9\ucc28 \ub51c\ub7ec",
  "\ud638\ud154",
];

export const SHEET_HEADERS = [
  "\ud68c\uc0ac\uba85",
  "\uc5c5\uc885",
  "\uc138\ubd80\uc5c5\uc885",
  "\uc9c0\uc5ed",
  "\uc8fc\uc18c",
  "\ub300\ud45c\uc804\ud654",
  "\ud648\ud398\uc774\uc9c0",
  "\uc774\uba54\uc77c",
  "\ucd9c\ucc98URL",
  "\uc218\uc9d1\uc77c",
  "\ub4f1\uae09",
  "\uc601\uc5c5\uc0c1\ud0dc",
  "\uba54\ubaa8",
];

export const PRIMARY_DB_SHEET_NAME = "\uae30\uc5c5 DB";
export const NEW_COMPANY_SHEET_NAME = "\uc2e0\uaddc\uae30\uc5c5";
export const SYSTEM_SHEET_NAME = "SYSTEM";
export const LOG_SHEET_NAME = "LOG";
export const SYSTEM_HEADERS = ["key", "value", "updated_at", "memo"];
export const LOG_HEADERS = [
  "\uc2e4\ud589\uc77c\uc2dc",
  "\ud604\uc7ac\ud050",
  "\ub2e4\uc74c\ud050",
  "\uc218\uc9d1\uc2dc\ub3c4\uc218",
  "\uc2e0\uaddc\ucd94\uac00\uc218",
  "\uc911\ubcf5\uc81c\uc678\uc218",
  "\uc804\ud654\ubc88\ud638\uc5c6\uc74c",
  "\uc9c0\uc5ed\ubd88\uc77c\uce58",
  "\uc5c5\uc885\ubd88\uc77c\uce58",
  "\uc2e4\ud589\uc2dc\uac04",
  "\uc0c1\ud0dc",
  "\uba54\ubaa8",
];
export const DATA_SHEET_TABS = [PRIMARY_DB_SHEET_NAME, NEW_COMPANY_SHEET_NAME, "\uc601\uc5c5\ub300\uc0c1", "\uac70\ub798\uae30\uc5c5", "\uc81c\uc678\uae30\uc5c5"];

// Places that were opened and then filtered out (no phone / wrong region / wrong industry) for a
// specific query. Recorded so a later run of the SAME query skips them at the card stage instead
// of re-opening every detail page. Deliberately NOT in DATA_SHEET_TABS: it is not company data and
// must never feed dedup keys or Enrich.
export const REJECTED_PLACE_SHEET_NAME = "\uc81c\uc678\ud50c\ub808\uc774\uc2a4"; // \uc81c\uc678\ud50c\ub808\uc774\uc2a4
export const REJECTED_PLACE_HEADERS = ["query", "place_key", "reason", "seen_at"];

export const SHEET_TABS = [...DATA_SHEET_TABS, SYSTEM_SHEET_NAME, LOG_SHEET_NAME, REJECTED_PLACE_SHEET_NAME];

// SYSTEM key ownership. Each job writes only its own list; the lists must stay disjoint so a
// concurrent Collect and Enrich run can never overwrite each other's progress.
export const COLLECT_SYSTEM_KEYS = [
  "current_region",
  "current_category",
  "current_keyword",
  "current_queue_index",
  "current_queue_attempts",
  "total_runs",
  "total_collected",
  "total_new_added",
  "total_duplicates",
  "last_run_at",
  "next_region",
  "next_category",
  "next_keyword",
  "failure_counts",
];

export const ENRICH_SYSTEM_KEYS = [
  "enrich_current_row",
  "enrich_total_runs",
  "enrich_total_processed",
  "enrich_homepage_found",
  "enrich_email_found",
  "enrich_last_run_at",
];

export const CRM_FOLDER_NAME = "\uc804\uad6d\ud314\ub3c4\uaf43\ubc30\ub2ec CRM";
export const CRM_SPREADSHEET_NAME = "\uae30\uc5c5DB";
export const CRM_FOLDER_ID = "1J-WmPxvc7FgD1nl6yeVnHJgalZGXoNRN";
export const CRM_SPREADSHEET_ID = "1vVk6WU-l1ILjLCY95Ua1SPqRxOTAh6tkyWjDjzbHvO0";
