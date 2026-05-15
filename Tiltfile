load('ext://helm_resource', 'helm_resource', 'helm_repo')
load('ext://namespace', 'namespace_create')

# ── Config ───────────────────────────────────────────────────────────────────

CLUSTER_NAME = 'monok8s-local'
REGISTRY     = 'harbor.monok8s.internal/monok8s'

allow_k8s_contexts('kind-' + CLUSTER_NAME)

# ── Namespaces ────────────────────────────────────────────────────────────────

namespace_create('monok8s-platform')
namespace_create('monok8s-prod')
namespace_create('temporal')
namespace_create('vault')
namespace_create('capsule-system')

# ── Helm repos ────────────────────────────────────────────────────────────────

helm_repo('hashicorp',        'https://helm.releases.hashicorp.com',          labels=['platform'])
helm_repo('temporal',         'https://go.temporal.io/helm-charts',           labels=['platform'])
helm_repo('cert-manager',     'https://charts.jetstack.io',                   labels=['platform'])
helm_repo('ext-secrets',      'https://charts.external-secrets.io',           labels=['platform'])
helm_repo('keda',             'https://kedacore.github.io/charts',            labels=['platform'])
helm_repo('capsule',          'https://projectcapsule.github.io/helm-charts', labels=['platform'])
helm_repo('grafana',          'https://grafana.github.io/helm-charts',        labels=['observability'])

# ── Platform services ─────────────────────────────────────────────────────────

helm_resource('cert-manager',
    'cert-manager/cert-manager',
    namespace='cert-manager',
    flags=['--set=installCRDs=true'],
    labels=['platform'],
)

helm_resource('vault',
    'hashicorp/vault',
    namespace='vault',
    flags=['--set=server.dev.enabled=true', '--set=server.dev.devRootToken=dev-root'],
    resource_deps=['cert-manager'],
    labels=['platform'],
)

helm_resource('external-secrets',
    'ext-secrets/external-secrets',
    namespace='external-secrets',
    resource_deps=['vault'],
    labels=['platform'],
)

helm_resource('temporal',
    'temporal/temporal',
    namespace='temporal',
    flags=['--set=server.replicaCount=1', '--set=cassandra.enabled=false',
           '--set=postgresql.enabled=true', '--set=elasticsearch.enabled=false'],
    labels=['platform'],
)

helm_resource('keda',
    'kedacore/keda',
    namespace='keda',
    labels=['platform'],
)

helm_resource('capsule',
    'capsule/capsule',
    namespace='capsule-system',
    labels=['platform'],
)

# ── Observability (opt-in: tilt up -- observability) ─────────────────────────

if config.tilt_subcommand == 'up' and 'observability' in config.args:
    helm_resource('loki',
        'grafana/loki-stack',
        namespace='observability',
        flags=['--set=grafana.enabled=true', '--set=prometheus.enabled=true'],
        labels=['observability'],
    )

# ── Image builds (Bazel → kind load) ─────────────────────────────────────────

def bazel_image(name, target, deps):
    tarball_target = target + '_tarball'
    custom_build(
        REGISTRY + '/' + name,
        'bazel build {tarball} && kind load image-archive $(bazel info bazel-bin)/{path}/tarball.tar --name {cluster}'.format(
            tarball = tarball_target,
            path    = target.lstrip('//').replace(':', '/'),
            cluster = CLUSTER_NAME,
        ),
        deps = deps,
    )

bazel_image('api',               '//apps/api:image',                    ['apps/api/src', 'packages'])
bazel_image('frontend',          '//frontend:image',                    ['frontend/src'])
bazel_image('onboarding-worker', '//apps/workers/onboarding:image',     ['apps/workers/onboarding'])
bazel_image('billing-worker',    '//apps/workers/billing:image',        ['apps/workers/billing'])

# ── K8s manifests ─────────────────────────────────────────────────────────────

k8s_yaml(kustomize('apps/api/k8s/overlays/local'))
k8s_yaml(kustomize('apps/workers/onboarding/k8s/overlays/local'))
k8s_yaml(kustomize('platform/keda'))
k8s_yaml(kustomize('platform/external-secrets'))
k8s_yaml(kustomize('platform/capsule/tenant-template'))
k8s_yaml(kustomize('infra/crossplane/xrds'))
k8s_yaml(kustomize('infra/crossplane/compositions'))

# ── Resource grouping ─────────────────────────────────────────────────────────

k8s_resource('api',               port_forwards='3000:3000', labels=['app'])
k8s_resource('frontend',          port_forwards='5173:80',   labels=['app'])
k8s_resource('onboarding-worker',                            labels=['workers'])
k8s_resource('billing-worker',                               labels=['workers'])

# ── Local tasks ───────────────────────────────────────────────────────────────

local_resource(
    'db-migrate',
    'atlas migrate apply --config packages/db/atlas.hcl --env staging',
    deps     = ['packages/db/migrations'],
    labels   = ['database'],
    resource_deps = ['temporal'],   # wait for postgres (via temporal dep chain)
)

local_resource(
    'bazel-test',
    'bazel test //...',
    auto_init    = False,
    trigger_mode = TRIGGER_MODE_MANUAL,
    labels       = ['test'],
)

local_resource(
    'spicedb-schema',
    'zed schema write packages/auth/schema.zed --endpoint localhost:50051 --token dev-preshared-key --insecure',
    deps   = ['packages/auth/schema.zed'],
    labels = ['platform'],
)
