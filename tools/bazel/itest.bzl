"""itest_suite — compose hermetic multi-server integration tests.

Wraps `rules_itest` over the collider-bazel-extensions `*_server` rules so
a single test target can request any subset of pg / temporal / spicedb / k8s
/ nats backends and receive canonical environment variables (PG_URL,
TEMPORAL_ADDR, SPICEDB_ADDR, KUBECONFIG, NATS_URL) regardless of how the
underlying rules name their own connection details.

Hermeticity comes from the upstream rules — each `*_server` runs from a
system-toolchain-installed binary, writes its env file under $TEST_TMPDIR,
and tears down on SIGTERM. See Discussion #4 for the project hermeticity
log.
"""

load("@bazel_skylib//rules:write_file.bzl", "write_file")
load("@rules_itest//:itest.bzl", "itest_service", "service_test")
load("@rules_kubernetes//:defs.bzl", "kubernetes_health_check")
load("@rules_nats//:defs.bzl", "nats_health_check")
load("@rules_pg//:defs.bzl", "pg_health_check")
load("@rules_spicedb//:defs.bzl", "spicedb_health_check")
load("@rules_temporal//:defs.bzl", "temporal_health_check")
load("@rules_zitadel//:defs.bzl", "zitadel_health_check")

_SUPPORTED = {
    "k8s": (
        kubernetes_health_check,
        # KUBECONFIG is already canonical. Native KUBE_NAMESPACE etc.
        # are picked up by the wrapper's `set -a` (see itest_suite).
        ":",
    ),
    "nats": (
        nats_health_check,
        ":",  # NATS_URL canonical; native NATS_HOST/NATS_PORT via set -a.
    ),
    "pg": (
        pg_health_check,
        'export PG_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}"',
    ),
    "spicedb": (
        spicedb_health_check,
        'export SPICEDB_ADDR="${SPICEDB_GRPC_ADDR}"',
    ),
    "temporal": (
        temporal_health_check,
        'export TEMPORAL_ADDR="${TEMPORAL_ADDRESS}"',
    ),
    "zitadel": (
        # rules_zitadel exports ZITADEL_HOST/ZITADEL_PORT; #33 consumers
        # read ZITADEL_ISSUER (the OIDC issuer URL). Native vars stay via
        # the wrapper's `set -a`.
        zitadel_health_check,
        'export ZITADEL_ISSUER="http://${ZITADEL_HOST}:${ZITADEL_PORT}"',
    ),
}

def itest_suite(name, servers, test, tags = None):
    """Bring up a subset of {pg, temporal, spicedb, k8s, nats} servers and run `test`.

    Args:
      name: target name; the runnable test is `:<name>`. Internal helper
        targets are named `_<name>__*` and considered private.
      servers: dict from canonical key → server target label. Supported keys
        are exactly `pg`, `temporal`, `spicedb`, `k8s`, `nats`. The value
        must be a label to a `pg_server` / `temporal_server` / `spicedb_server`
        / `kubernetes_server` / `nats_server` target the caller has already
        declared.
      test: label to the executable test target to run after every requested
        server is healthy. Tag it `manual` so plain `bazel test //...` doesn't
        invoke it without the surrounding services.
      tags: optional list of tags forwarded to the outer `service_test`. Use
        for purity tagging (`pure` / `impure`) per code-design Rule 6.

    The wrapped test sees these environment keys (subset based on `servers`):

      PG_URL          postgresql://USER:PASS@HOST:PORT/DB
      TEMPORAL_ADDR   host:port for the temporal frontend
      SPICEDB_ADDR    host:port for the SpiceDB gRPC endpoint
      KUBECONFIG      path to a kubeconfig pointing at the test apiserver
      NATS_URL        nats://HOST:PORT for the nats-server

    Native env keys exported by each upstream `*_server` (PGHOST/PGPORT/...,
    TEMPORAL_NAMESPACE, SPICEDB_PRESHARED_KEY, KUBE_NAMESPACE, NATS_HOST,
    NATS_PORT, etc.) remain available alongside the canonical keys.
    """
    if not servers:
        fail("itest_suite: servers must be a non-empty dict; supported keys: %s" % sorted(_SUPPORTED))

    services = []
    body = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        # set -a makes every variable assigned during the subsequent
        # `source` automatically `export`ed. The upstream *_server
        # rules write their .env files as plain `KEY=value` lines (no
        # `export` prefix), and bare `source` would only set them as
        # shell-local — invisible to the exec'd test binary. set -a
        # fixes that uniformly for canonical AND native env keys
        # (KUBECONFIG, KUBE_NAMESPACE, NATS_URL, NATS_HOST, PGHOST,
        # PGUSER, etc.). After sourcing, the per-server export_line
        # may construct a canonical key from natives (e.g. PG_URL
        # from PGHOST/PGPORT/...) — that line uses `export` directly
        # since set -a only auto-exports assignments seen during a
        # source/eval, not plain expansions.
        "set -a",
    ]

    for key in sorted(servers.keys()):
        if key not in _SUPPORTED:
            fail("itest_suite: unsupported server key %r; expected one of %s" % (key, sorted(_SUPPORTED)))

        server_label = servers[key]
        server_name = native.package_relative_label(server_label).name
        health_rule, export_line = _SUPPORTED[key]

        health_target = "_%s__%s_health" % (name, key)
        health_rule(
            name = health_target,
            server = server_label,
        )

        svc_target = "_%s__%s_svc" % (name, key)
        itest_service(
            name = svc_target,
            exe = server_label,
            health_check = ":" + health_target,
            # Propagate tags so the auto-generated `_svc_hygiene_test`
            # picks up the same `manual` / `impure` / `requires-docker`
            # gating the parent target carries. Without this the
            # hygiene test runs under wildcard `bazel test //...`
            # invocations on Docker-less runners and fails the
            # `rules_kind` Docker check.
            tags = tags or [],
        )
        services.append(":" + svc_target)

        body.append('source "${TEST_TMPDIR}/%s.env"' % server_name)
        body.append(export_line)

    body.append("set +a")
    body.append('exec "$@"')

    wrapper_src = "_%s__wrapper_src" % name
    wrapper_out = "_%s__wrapper.sh" % name
    write_file(
        name = wrapper_src,
        out = wrapper_out,
        content = body,
        is_executable = True,
    )

    wrapper_test = "_%s__wrapper" % name
    native.sh_test(
        name = wrapper_test,
        srcs = [":" + wrapper_src],
        args = ["$(rootpath %s)" % test],
        data = [test],
        tags = ["manual"],
    )

    service_test(
        name = name,
        # Pass the test executable's rootpath here, NOT only on the inner
        # sh_test's `args`. rules_itest's svcinit reads `os.Args[1:]` from
        # its own invocation and forwards them to the wrapped test, which
        # here is the sh_test wrapper. Bazel populates `args` on the
        # rule it actually invokes — the outer service_test — so the
        # inner sh_test's `args` attribute is silently dropped without
        # this line. Wrapper.sh's `exec "$@"` then has nothing to exec
        # and the test "passes" in <2ms having run nothing.
        args = ["$(rootpath %s)" % test],
        data = [test],
        test = ":" + wrapper_test,
        services = services,
        tags = tags,
    )
