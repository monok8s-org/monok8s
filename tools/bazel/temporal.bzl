"""Temporal workflow determinism testing.

This file used to define a local `temporal_replay_test` macro that
predated `rules_temporal` v0.3.0. The local macro referenced a
`//tools/bazel:replay_test_main.go` source file that was never written
(scaffolded-ahead-of-implementation) and reinvented what the upstream
rules now ship properly.

Use the upstream `rules_temporal` primitives directly:

    load("@rules_temporal//:defs.bzl",
        "temporal_build", "temporal_workflow_history", "temporal_test")

    temporal_build(
        name  = "worker",
        embed = [":<workflow_library>"],
    )

    temporal_workflow_history(
        name   = "histories",
        worker = ":worker",
        srcs   = glob(["testdata/histories/*.json"]),
    )

    temporal_test(
        name    = "replay_test",
        worker  = ":worker",
        history = ":histories",
        srcs    = ["replay_test.sh"],
    )

The transient `temporal_server` boots automatically; each history is
replayed via the upstream `temporal workflow replay` CLI before
exec'ing the user test script. A non-determinism error fails the
target immediately and prints the full replay output. Per
`apps/workers/CLAUDE.md`, the recording recipe is:

    temporal workflow show -w <workflow-id> --output json \\
        > testdata/histories/<scenario>.json

By convention the consumer target is named `replay_test` per
`tools/bazel/CLAUDE.md` ("Temporal replay test targets are always
named `replay_test`").
"""
