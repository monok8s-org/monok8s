//go:build !replay_runner

// onboarding worker binary entrypoint (#124 sub-PR-1).
//
// Thin shell that calls run(). The actual Temporal client + worker
// setup lives in run.go (same package) so unit tests in this
// package can exercise registration without going through the
// OS-level binary.
//
// Build tag !replay_runner: this file ships in the default (`:worker`)
// build. The `replay_runner_main.go` file under the matching positive
// tag swaps in a different main() that exec's the workflow-replayer
// instead of running the production worker. Per
// rules_temporal#5 → v0.4.0's custom_replay_runner mechanism. The two
// binaries share every other file in this directory so the workflow
// + activity code is identical between production and replay.
package main

import (
	"log"
	"os"
)

func main() {
	if err := run(); err != nil {
		log.Printf("onboarding worker: %v", err)
		os.Exit(1)
	}
}
