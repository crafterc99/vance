const { evaluateFrame, evaluateStrip } = require("./index");
const path = require("path");
const fs = require("fs");
const ASSETS = "/Users/crafterc/Claude Test/soul-jam/public/assets/images";

async function test() {
  const framesDir = path.join(ASSETS, "99-static-dribble-frames");
  if (!fs.existsSync(framesDir)) { console.log("No frames dir"); return; }
  const frames = fs.readdirSync(framesDir).filter(f => f.endsWith(".png")).sort();
  const paths = frames.map(f => path.join(framesDir, f));

  console.log("=== Per-frame evaluation ===");
  for (const fp of paths) {
    const r = await evaluateFrame(fp);
    const issues = r.issues.map(i => i.type).join(", ") || "none";
    console.log(path.basename(fp) + ": score=" + r.score + " fill=" + r.metrics.fillHeight + "% cov=" + r.metrics.coverage + "% issues=[" + issues + "]");
  }

  console.log("\n=== Strip evaluation ===");
  const strip = await evaluateStrip(paths);
  console.log("Passed:", strip.passed);
  console.log("Overall:", strip.overallScore, "| Avg frame:", strip.avgFrameScore, "| Consistency:", strip.consistencyScore);
  console.log("Median fill:", strip.medianFill + "%");
  console.log("Issues:", strip.issues.map(i => i.type + " (" + i.severity + ") frames:" + i.affectedFrames).join("; ") || "none");
  console.log("Fixes:", strip.fixes.length, "suggested");
  strip.fixes.forEach(f => console.log("  ->", f.section + ":", f.text.trim().substring(0, 80)));
}
test();
