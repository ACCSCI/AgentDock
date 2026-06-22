/**
 * CLI: Suggest fixes for the latest Playwright failures.
 *
 * Reads `e2e/reports/latest.json`, classifies each failure, and
 * feeds it through the fix-suggester to produce actionable recommendations.
 *
 * Usage:
 *   bun run e2e:suggest-fix
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyFailure } from "./failure-classifier.js";
import { suggestFix } from "./fix-suggester.js";

const ROOT = process.cwd();
const REPORT_PATH = join(ROOT, "e2e/reports/latest.json");

interface PlaywrightTestResult {
  specs: Array<{
    title: string;
    file: string;
    ok: boolean;
    tests: Array<{
      status: string;
      errors: Array<{ message: string; stack: string }>;
    }>;
  }>;
}

function main(): void {
  if (!existsSync(REPORT_PATH)) {
    console.error(`❌ No report found at ${REPORT_PATH}`);
    console.error("   Run `bun run test:e2e` first.");
    process.exit(1);
  }

  const raw = readFileSync(REPORT_PATH, "utf-8");
  const report: PlaywrightTestResult = JSON.parse(raw);
  const failedSpecs = (report.specs ?? []).filter(
    (spec) => !spec.ok && spec.tests.some((t) => t.status === "failed" || t.status === "unexpected")
  );

  if (failedSpecs.length === 0) {
    console.log("✅ No failures — nothing to suggest.");
    process.exit(0);
  }

  let totalSuggestions = 0;
  for (const spec of failedSpecs) {
    for (const test of spec.tests) {
      if (test.status === "passed") continue;
      for (const error of test.errors) {
        const classification = classifyFailure(
          error.message ?? "",
          error.stack ?? "",
          spec.file
        );
        const suggestions = suggestFix(classification, spec.file, error.message ?? "");
        if (suggestions.length === 0) continue;

        totalSuggestions += suggestions.length;
        console.log(`\n🔧 ${spec.title}`);
        console.log(`   File: ${spec.file}`);
        console.log(`   Classification: ${classification.type} (confidence: ${classification.confidence})`);
        for (const s of suggestions) {
          console.log(`\n   💡 ${s.title} (confidence: ${s.confidence})`);
          console.log(`      ${s.description}`);
          for (const f of s.files) {
            console.log(`      📄 ${f.path} [${f.change}] — ${f.rationale}`);
          }
        }
      }
    }
  }

  console.log(`\n📊 Total: ${totalSuggestions} suggestion(s) across ${failedSpecs.length} failed test(s)\n`);
}

main();
