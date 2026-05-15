#!/usr/bin/env bash
# No-op test body for the //apps/workers/onboarding:replay_test target.
#
# By the time this script runs, the temporal_test launcher has already:
#   1. Booted `temporal server start-dev` on a free port.
#   2. Created an isolated test namespace.
#   3. Started the :worker binary against TEMPORAL_ADDRESS.
#   4. Waited until the worker is polling the `onboarding` task queue.
#   5. Validated the declared workflow_types / activity_types in
#      :worker_build match the running worker's actual pollers.
#
# If the script reaches `exit 0`, all of the above succeeded.
#
# Recorded-history replay lands in #129c (#138) via the L2 itest test
# driver capturing a real workflow execution's history JSON.
exit 0
