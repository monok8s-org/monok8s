"""Helpers for building and tagging OCI images destined for Harbor.

Base images are digest-pinned in MODULE.bazel via rules_oci's oci.pull.
Macros in this file dispatch to the correct base by service language —
callers declare *what kind of service this is* (`node` or `go`), not
which base image to consume.

The Node-language path uses `aspect_rules_js`'s `js_image_layer`, which
understands pnpm's symlinked node_modules store and emits separate tar
layers for the Node toolchain, third-party store, first-party store,
top-level node_modules, and app runfiles. The bare `aspect_bazel_lib`
`tar` rule used to mishandle pnpm peer-dep-variant symlinks-to-directories
(specifically `@trpc+server@11.17.0_typescript@5.9.3/node_modules/typescript`)
with `mtree specification has different type for ...` — fixed in #153.

The Go-language path keeps the bare `tar` rule because static-linked Go
binaries have no symlink store.
"""

load("@aspect_bazel_lib//lib:tar.bzl", "tar")
load("@aspect_rules_js//js:defs.bzl", "js_image_layer")
load("@rules_oci//oci:defs.bzl", "oci_image", "oci_load", "oci_push")

HARBOR_REGISTRY = "harbor.monok8s.internal"

_BASES_BY_LANGUAGE = {
    "node": "@node_distroless",
    "go": "@distroless_static",
}

def app_image(name, language, binary, description = "", tags = []):
    """Package a binary as an OCI image with a digest-pinned base + Harbor push target.

    Args:
      name: target name. Generates four targets:
        * `<name>` — the `oci_image`
        * `<name>_layer` — the image's runfiles layer (`js_image_layer` for
          node, bare `tar` for go)
        * `<name>_push` — `oci_push` target writing to Harbor
        * `<name>_tarball` — `oci_tarball` filesystem export. Consumed by
          `rules_kind`'s `kind_cluster.images` attr for L4 e2e tests; #145.
      language: one of "node" or "go". Drives base image selection.
      binary: a `js_binary` (for node) or `go_binary` (for go) target label.
      description: human-readable label written into the OCI manifest.
      tags: tags forwarded to every generated target.
    """
    if language not in _BASES_BY_LANGUAGE:
        fail("app_image: unsupported language %r; expected one of %s" % (
            language,
            sorted(_BASES_BY_LANGUAGE.keys()),
        ))
    base = _BASES_BY_LANGUAGE[language]
    labels = {
        "org.opencontainers.image.description": description,
        "org.opencontainers.image.source": "https://github.com/monok8s-org/monok8s",
    }

    if language == "node":
        # js_image_layer emits up to 5 tars (node toolchain, package_store_3p,
        # package_store_1p, node_modules, app) — provide them all to oci_image
        # so the pnpm symlink store reconstructs correctly inside the image.
        #
        # `cmd` + `workdir` follow the rules_js convention: the path is
        # `<root>/<bazel-package>/<binary-name>` and the runfiles tree lives
        # under that path with a `.runfiles/_main` suffix. The js_binary's
        # bash launcher is the entrypoint; the distroless nodejs22 base has
        # no shell so runtime container startup needs a base with bash before
        # apps/api actually deploys (gap-logged separately). The build-time
        # assembly is correct — that's what this PR closes.
        bin_label = native.package_relative_label(binary)
        bin_path = "/app/" + bin_label.package + "/" + bin_label.name

        js_image_layer(
            name = name + "_layer",
            binary = binary,
            root = "/app",
            tags = tags,
        )

        oci_image(
            name = name,
            base = base,
            tars = [":" + name + "_layer"],
            cmd = [bin_path],
            entrypoint = ["bash"],
            workdir = bin_path + ".runfiles/_main",
            labels = labels,
            tags = tags,
        )
    else:
        # Go path — static-linked binary, no symlink store, bare tar suffices.
        tar(
            name = name + "_layer",
            srcs = [binary],
            tags = tags,
        )

        oci_image(
            name = name,
            base = base,
            tars = [":" + name + "_layer"],
            labels = labels,
            tags = tags,
        )

    oci_push(
        name = name + "_push",
        image = ":" + name,
        repository = HARBOR_REGISTRY + "/monok8s/" + name,
        tags = tags,
    )

    # rules_oci renamed `oci_tarball` to `oci_load`. The target still
    # produces a `.tar` filesystem-export under bazel-bin/ — that's what
    # `kind load image-archive` and rules_kind's `kind_cluster.images`
    # attr consume.
    oci_load(
        name = name + "_tarball",
        image = ":" + name,
        repo_tags = [HARBOR_REGISTRY + "/monok8s/" + name + ":latest"],
        tags = tags,
        # L4 e2e tests in other packages (e.g. //platform/monok8s-bootstrap/k8s_e2e)
        # consume the tarball as an entry in `kind_cluster.images`.
        visibility = ["//visibility:public"],
    )

def frontend_image(name, bundle):
    """Package a SolidJS esbuild bundle into a digest-pinned nginx image.

    NOTE: aspect_bazel_lib's `tar` macro removed `package_dir` in favor
    of mtree-based relocation. The bundle currently lands at its
    bazel-bin path inside the tar (e.g. `frontend/bundle/index.html`);
    pinning nginx's `root` to that path or relocating to
    `/usr/share/nginx/html` via an mtree_mutate rule is #32's
    responsibility once that PR wires the actual nginx config + first
    test fixtures. For now the layer builds cleanly; runtime serving
    is a #32 follow-up.
    """
    tar(
        name = name + "_layer",
        srcs = [bundle],
    )

    oci_image(
        name = name,
        base = "@nginx_distroless",
        tars = [":" + name + "_layer"],
    )

    oci_push(
        name = name + "_push",
        image = ":" + name,
        repository = HARBOR_REGISTRY + "/monok8s/" + name,
    )
