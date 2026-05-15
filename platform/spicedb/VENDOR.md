# `platform/spicedb/operator-bootstrap.yaml` provenance

SpiceDB operator install, vendored from rules_spicedb v0.2.0's bundled
chart-render of `authzed/spicedb-operator` v1.25.0. Per Hermeticity
Discussion #4 Gap 3, manifests applied from this repo are **vendored**
— `kubectl apply -f operator-bootstrap.yaml` makes no network call at
sync time. Pair-bumped with `rules_spicedb` in `MODULE.bazel` so the
in-tree Bazel toolchain (for #37 L4 testing) stays version-aligned
with the deployed manifest.

`rules_spicedb v0.2.0` shipped two new install primitives in response
to [`rules_spicedb#2`](https://github.com/collider-bazel-extensions/rules_spicedb/issues/2)
(filed during PR #64):

* `spicedb_install` — `kubectl_apply` over the bundled manifest. Drops
  into `itest_service.exe` for L4 tests.
* `spicedb_install_health_check` — paired readiness probe.

Both are in the same package as the existing test primitives
(`spicedb_test`, `spicedb_server`, etc. — used by this PR's L2
`permissions_test`); the install primitives are named with `_install_`
to avoid colliding with the v0.1 test-time `spicedb_health_check`.

## Refresh procedure

Bump `rules_spicedb` in `MODULE.bazel`, then copy:

```bash
RS_DIR=$(bazel info output_base)/external/rules_spicedb+
cp "$RS_DIR/private/manifests/spicedb_operator.yaml" \
    platform/spicedb/operator-bootstrap.yaml
```

| File | rules_spicedb | spicedb-operator version | sha256 | size |
|---|---|---|---|---|
| `operator-bootstrap.yaml` | `v0.2.0` | `v1.25.0` | `faa874927cf9163f1322ddb400b70c6bc6fb40ae6eb93180d3c82bbbe8c1a563` | 89,857 |
