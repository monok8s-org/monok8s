//go:build replay_runner

// Workflow-history replay-runner entrypoint. Built only when the
// `replay_runner` go-build tag is set — the `:replay_runner_bin`
// go_binary in BUILD.bazel passes `gotags = ["replay_runner"]` to
// compile this file's `main()` in place of `main.go`'s production
// entrypoint. Per rules_temporal#5 → v0.4.0's custom_replay_runner
// attribute on `temporal_build`.
//
// Argv contract (set by rules_temporal v0.4.0's launcher):
//
//	replay_runner_bin <history_file.json>
//
// Exit 0 on successful replay; non-zero on any workflow non-
// determinism. The Temporal SDK's WorkflowReplayer emits the
// divergent event ID + the workflow code's expected-vs-actual on
// non-determinism, surfacing in the test launcher's logs.
//
// Shares the workflow + activity registrations with the production
// `:worker` binary because every other .go file in this directory
// is included in both builds. Activities are still registered (even
// though replay never invokes them) because the SDK's WorkflowReplayer
// validates that every activity called from the workflow has a
// registered name — no real I/O is performed during replay.
package main

import (
	"fmt"
	"os"

	"go.temporal.io/sdk/worker"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: replay_runner_bin <history_file.json>")
		os.Exit(2)
	}
	historyFile := os.Args[1]

	replayer := worker.NewWorkflowReplayer()

	// Register every workflow declared in run.go's RegisterWorkflow
	// block. Source of truth for the set: run.go lines 43-49. Order
	// doesn't matter; the SDK indexes by name.
	replayer.RegisterWorkflow(OnboardTenantWorkflow)
	replayer.RegisterWorkflow(RegisterUserWorkflow)
	replayer.RegisterWorkflow(ErasureWorkflow)
	replayer.RegisterWorkflow(TemporaryGrantWorkflow)
	replayer.RegisterWorkflow(InstallationRegistrationWorkflow)
	replayer.RegisterWorkflow(InstallationHeartbeatMonitorWorkflow)
	replayer.RegisterWorkflow(InstallationRevocationWorkflow)

	if err := replayer.ReplayWorkflowHistoryFromJSONFile(nil, historyFile); err != nil {
		fmt.Fprintf(os.Stderr, "replay failed for %s: %v\n", historyFile, err)
		os.Exit(1)
	}
}
