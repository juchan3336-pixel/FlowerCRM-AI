const KST_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("sv-SE", {
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  month: "2-digit",
  timeZone: "Asia/Seoul",
  year: "numeric",
})

export function formatKstDateTime(value: string): string {
  return `${KST_DATE_TIME_FORMATTER.format(new Date(value))} KST`
}
