import fs from "node:fs";
import path from "node:path";

export function generateCoverageSummary(lcovPath = "coverage/lcov.info") {
  if (!fs.existsSync(lcovPath)) {
    return "*(No coverage/lcov.info found. Run `npm run test:coverage` first)*\n";
  }

  const lcov = fs.readFileSync(lcovPath, "utf8");
  const files = [];
  let cur = {};

  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      cur.file = line.slice(3).replace(/^\.\//, "");
    } else if (line.startsWith("LF:")) {
      cur.lf = parseInt(line.slice(3), 10);
    } else if (line.startsWith("LH:")) {
      cur.lh = parseInt(line.slice(3), 10);
    } else if (line.startsWith("FNF:")) {
      cur.fnf = parseInt(line.slice(4), 10);
    } else if (line.startsWith("FNH:")) {
      cur.fnh = parseInt(line.slice(4), 10);
    } else if (line.startsWith("BRF:")) {
      cur.brf = parseInt(line.slice(4), 10);
    } else if (line.startsWith("BRH:")) {
      cur.brh = parseInt(line.slice(4), 10);
    } else if (line === "end_of_record") {
      if (cur.file && !cur.file.startsWith("test/")) {
        files.push(cur);
      }
      cur = {};
    }
  }

  let totalLf = 0;
  let totalLh = 0;
  let totalFnf = 0;
  let totalFnh = 0;

  const lines = [
    "| File | Lines | Functions | Status |",
    "|:---|:---:|:---:|:---:|",
  ];

  for (const f of files.sort((a, b) => a.file.localeCompare(b.file))) {
    const linePct = f.lf ? Math.round((f.lh / f.lf) * 100) : 100;
    const fnPct = f.fnf ? Math.round((f.fnh / f.fnf) * 100) : 100;
    totalLf += f.lf || 0;
    totalLh += f.lh || 0;
    totalFnf += f.fnf || 0;
    totalFnh += f.fnh || 0;
    const badge = linePct >= 80 ? "🟢" : linePct >= 60 ? "🟡" : "🔴";
    lines.push(
      `| \`${f.file}\` | ${f.lh}/${f.lf} (${linePct}%) | ${f.fnh}/${f.fnf} (${fnPct}%) | ${badge} |`
    );
  }

  const totLinePct = totalLf ? Math.round((totalLh / totalLf) * 100) : 100;
  const totFnPct = totalFnf ? Math.round((totalFnh / totalFnf) * 100) : 100;
  const totBadge = totLinePct >= 75 ? "🟢" : totLinePct >= 60 ? "🟡" : "🔴";

  lines.push(
    `| **Total (src & bin)** | **${totalLh}/${totalLf} (${totLinePct}%)** | **${totalFnh}/${totalFnf} (${totFnPct}%)** | **${totBadge}** |`
  );

  return lines.join("\n") + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const file = process.argv[2] || "coverage/lcov.info";
  process.stdout.write(generateCoverageSummary(file));
}
