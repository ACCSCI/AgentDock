/**
 * CLI: Classify failures from the latest Playwright report.
 *
 * Reads `e2e/reports/latest.json` (written by the JSON reporter),
 * extracts failed tests, runs each through the failure classifier,
 * and prints a summary to stdout.
 *
 * Usage:
 *   bun run e2e:classify
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyFailure, type FailureClassification } from "./failure-classifier.js";

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

interface ClassificationResult {
  test: string;
  file: string;
  classification: FailureClassification;
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
    console.log("✅ No failures found in latest report.");
    process.exit(0);
  }

  const results: ClassificationResult[] = [];
  for (const spec of failedSpecs) {
    for (const test of spec.tests) {
      if (test.status === "passed") continue;
      for (const error of test.errors) {
        const classification = classifyFailure(
          error.message ?? "",
          error.stack ?? "",
          spec.file
        );
        results.push({
          test: spec.title,
          file: spec.file,
          classification,
        });
      }
    }
  }

  console.log(`\n🔍 Classification Results (${results.length} failure(s))\n`);
  const grouped = results.reduce(
    (acc, r) => {
      (acc[r.classification.type] ??= []).push(r);
      return acc;
    },
    {} as Record<string, ClassificationResult[]>
  );

  for (const [type, items] of Object.entries(grouped)) {
    console.log(`--- ${type.toUpperCase()} (${items.length}) ---`);
    for (const item of items) {
      const action = item.classification.suggestedAction;
      console.log(`  • ${item.test}`);
      console.log(`    File: ${item.file}`);
      console.log(`    Reason: ${item.classification.reason}`);
      console.log(`    Action: ${action} (confidence: ${item.classification.confidence})`);
    }
  }

  console.log("\n");
}
main();
