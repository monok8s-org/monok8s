// CLI entrypoint for the bench regression checker (#189 B2).
//
// Invoked by .github/workflows/bench.yml's `Regression check` step:
//
//   bazel run //packages/db:check_regression -- \
//       <results-dir> <baseline-dir>
//
// All behavior lives in ./check_regression. This file is the
// effect-shell that maps process.argv + process.exit onto run().

import { run } from "./check_regression.js";

function main(): number {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write(
      "usage: check_regression <results-dir> <baseline-dir>\n",
    );
    return 2;
  }
  const [resultsDir, baselineDir] = args;
  const outcome = run(resultsDir!, baselineDir!);
  for (const line of outcome.lines) {
    process.stdout.write(`${line}\n`);
  }
  return outcome.exitCode;
}

process.exit(main());
