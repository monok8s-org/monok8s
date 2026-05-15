# Unit tests for require_tenant_label.rego — exercised by opa_test from
# rules_opa. Validates rejection logic for namespaces that lack the
# `monok8s.io/tenant` label, AND admission for namespaces that have it.
package monok8s.require_tenant_label

# A namespace WITHOUT the label triggers a violation (the body is the
# rejection message, AC#5's "Namespace without the label is rejected").
test_namespace_without_label_rejected if {
    v := violation with input as {
        "review": {
            "object": {
                "kind": "Namespace",
                "metadata": {
                    "name":   "missing-label",
                    "labels": {"some-other": "value"},
                },
            },
        },
    }
    count(v) == 1
    contains(v[_].msg, "must carry the monok8s.io/tenant label")
}

# A namespace WITH the label has no violation.
test_namespace_with_label_admitted if {
    v := violation with input as {
        "review": {
            "object": {
                "kind": "Namespace",
                "metadata": {
                    "name":   "tenant-acme",
                    "labels": {"monok8s.io/tenant": "acme"},
                },
            },
        },
    }
    count(v) == 0
}

# A namespace with no labels at all is also rejected.
test_namespace_with_no_labels_rejected if {
    v := violation with input as {
        "review": {
            "object": {
                "kind":     "Namespace",
                "metadata": {"name": "labelless"},
            },
        },
    }
    count(v) == 1
}

# A namespace with an EMPTY tenant label value passes — Rego's `not key`
# is undefined-vs-defined, not truthiness, and K8s admission treats empty
# string label values as legal. The Constraint at the cluster level
# additionally rejects empty values via Gatekeeper's match.scope but
# that's enforcement scope, not policy scope.
test_namespace_with_empty_label_admitted if {
    v := violation with input as {
        "review": {
            "object": {
                "kind": "Namespace",
                "metadata": {
                    "name":   "empty-tenant",
                    "labels": {"monok8s.io/tenant": ""},
                },
            },
        },
    }
    count(v) == 0
}
