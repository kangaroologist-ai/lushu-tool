const BACKTICK = "`";

export function wrapTripData(md) {
  const violations = [];
  String(md).split("\n").forEach((line, i) => {
    if (line.includes(BACKTICK)) violations.push(`第 ${i + 1} 行: 含反引号 (${BACKTICK})`);
    if (line.includes("${")) violations.push(`第 ${i + 1} 行: 含模板插值序列 \${`);
  });
  if (violations.length) {
    const err = new Error("MD 不能安全嵌入 trip.data.js:\n" + violations.join("\n"));
    err.code = "unsafe_trip_data";
    throw err;
  }
  const body = String(md).endsWith("\n") ? String(md) : String(md) + "\n";
  return "window.TRIP_MD = String.raw" + BACKTICK + "\n" + body + BACKTICK + ";\n";
}
