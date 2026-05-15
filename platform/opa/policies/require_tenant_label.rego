# Rego policy: every Namespace must carry the `monok8s.io/tenant` label.
#
# This policy is the source of truth — both the inline ConstraintTemplate
# (under platform/opa/constraints/) and the L1 opa_test below evaluate
# against this same logic.
#
# Rego v1 syntax (OPA 1.x default). Gatekeeper's ConstraintTemplate
# embeds equivalent v0 syntax inline because Gatekeeper's policy engine
# still consumes v0; the two stay in sync via the smoke test.
package monok8s.require_tenant_label

import rego.v1

# Gatekeeper-shape violation rule. The `input` shape mirrors what
# Gatekeeper's audit + admission webhook passes to the rego: the
# AdmissionRequest's review.object is the resource being admitted.
violation contains {"msg": msg} if {
    not input.review.object.metadata.labels["monok8s.io/tenant"]
    msg := sprintf(
        "Namespace %q must carry the monok8s.io/tenant label",
        [input.review.object.metadata.name],
    )
}
