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
    console.log("✅ No failures — nothing to suggest.");
    process.exit(0);
  }

  let totalSuggestions = 0;
  for (const err of extractedErrors) {
    const classification = classifyFailure(err.message, err.stack, err.file);
    const suggestions = suggestFix(classification, err.file, err.message);
    if (suggestions.length === 0) continue;

    totalSuggestions += suggestions.length;
    console.log(`\n🔧 ${err.specTitle}`);
    console.log(`   File: ${err.file}`);
    console.log(
      `   Classification: ${classification.type} (confidence: ${classification.confidence})`,
    );
    for (const s of suggestions) {
      console.log(`\n   💡 ${s.title} (confidence: ${s.confidence})`);
      console.log(`      ${s.description}`);
      for (const f of s.files) {
        console.log(`      📄 ${f.path} [${f.change}] — ${f.rationale}`);
      }
    }
  }

  console.log(
    `\n📊 Total: ${totalSuggestions} suggestion(s) across ${extractedErrors.length} error(s)\n`,
  );
}

main();
