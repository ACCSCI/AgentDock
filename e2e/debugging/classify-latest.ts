/**
 * CLI: Classify failures from the latest Playwright report.
 *
 * Reads `e2e/reports/latest.json` (written by the JSON reporter),
 * extracts failed tests by recursively traversing the nested `suites`
 * structure (Playwright JSON reporter nests specs inside suites, and
 * errors live in `test.results[].errors`), runs each through the
 * failure classifier, and prints a summary to stdout.
 *
 * Usage:
 *   bun run e2e:classify
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyFailure, type FailureClassification } from "./failure-classifier.js";

const ROOT = process.cwd();
const REPORT_PATH = join(ROOT, "e2e/reports/latest.json");

interface PlaywrightReport {
  suites?: Array<{
    file: string;
    specs?: Array<{
      title: string;
      ok: boolean;
      tests: Array<{
        status: string;
        results?: Array<{
          errors?: Array<{ message: string; stack: string }>;
        }>;
      }>;
    }>;
    suites?: any[];
  }>;
}

interface ClassificationResult {
  test: string;
  file: string;
  classification: FailureClassification;
}

interface ExtractedError {
  specTitle: string;
  file: string;
  message: string;
  stack: string;
}

function extractErrors(report: PlaywrightReport): ExtractedError[] {
  const errors: ExtractedError[] = [];

  function traverseSuite(suite: any, file: string): void {
    const currentFile = suite.file || file;
    if (suite.specs) {
      for (const spec of suite.specs) {
        if (!spec.ok) {
          for (const test of spec.tests) {
            if (test.status === "failed" || test.status === "unexpected") {
              for (const result of test.results ?? []) {
                if (result.errors) {
                  for (const err of result.errors) {
                    errors.push({
                      specTitle: spec.title,
                      file: currentFile,
                      message: err.message || "",
                      stack: err.stack || "",
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
    if (suite.suites) {
      for (const subSuite of suite.suites) {
        traverseSuite(subSuite, currentFile);
      }
    }
  }

  if (report.suites) {
    for (const suite of report.suites) {
      traverseSuite(suite, "");
    }
  }
  return errors;
}

function main(): void {
  if (!existsSync(REPORT_PATH)) {
    console.error(`❌ No report found at ${REPORT_PATH}`);
    console.error("   Run `bun run test:e2e` first.");
    process.exit(1);
  }

  const raw = readFileSync(REPORT_PATH, "utf-8");
  const report: PlaywrightReport = JSON.parse(raw);
  const extractedErrors = extractErrors(report);

  if (extractedErrors.length === 0) {
    console.log("✅ No failures found in latest report.");
    process.exit(0);
  }

  const results: ClassificationResult[] = [];
  for (const err of extractedErrors) {
    const classification = classifyFailure(err.message, err.stack, err.file);
    results.push({
      test: err.specTitle,
      file: err.file,
      classification,
    });
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
