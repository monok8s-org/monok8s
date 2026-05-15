# SSO federation (cloud identity → monok8s)

Zitadel supports upstream OIDC and SAML identity providers. Adding an enterprise
customer's cloud identity as an upstream IdP lets their users sign in to monok8s
using the same SSO session they use for the rest of their cloud console.

This is separate from SCIM (which pushes users and groups *out* from Zitadel to
cloud directories). Federation here flows *in*: cloud identity → Zitadel → monok8s.

---

## Supported upstream IdPs

| IdP | Protocol | Config file |
|---|---|---|
| Microsoft Entra ID | OIDC | `platform/zitadel/idp-federation/entra.yaml` |
| Google Workspace / Google | OIDC | `platform/zitadel/idp-federation/google.yaml` |
| AWS IAM Identity Center | OIDC | `platform/zitadel/idp-federation/aws-iam-ic.yaml` |

---

## How it works

1. User clicks "Sign in with Microsoft/Google/AWS" on the monok8s login page
2. Zitadel redirects to the upstream IdP's authorization endpoint
3. User authenticates with their cloud identity
4. Upstream IdP redirects back to Zitadel with an ID token
5. Zitadel maps the upstream identity to an existing monok8s user
   (or prompts to create one, if `is_creation_allowed: true`)
6. Zitadel issues its own JWT with monok8s claims
7. The API verifies Zitadel JWTs as normal — no changes to the auth flow

The key property: **Zitadel is still the identity source**. Cloud IdPs are
login shortcuts. SpiceDB still holds the authoritative role assignments.

---

## Account linking

By default, federation is configured with:
- `is_creation_allowed: false` — users must already have a monok8s account
- `is_linking_allowed: true` — existing accounts can link their cloud identity
- `is_auto_update: true` — profile (name, email) is synced from the cloud IdP on each login

This means the first step for enterprise SSO is:
1. The tenant admin invites users via monok8s (creates the account)
2. Users link their cloud identity on first SSO login
3. On subsequent logins they can use the cloud SSO button directly

If you want fully automated account creation (no invite required):
- Set `is_creation_allowed: true` in the IdP config
- Ensure SCIM is also configured to sync group memberships so new users get roles

---

## Microsoft Entra ID setup

### 1. Register the app in Entra

```bash
APP_ID=$(az ad app create \
  --display-name "monok8s-sso" \
  --sign-in-audience AzureADMultipleOrgs \
  --query appId -o tsv)

# Add the redirect URI
az ad app update --id $APP_ID \
  --web-redirect-uris "https://auth.monok8s.io/ui/login/login/externalidp/callback"

# Create a client secret (store the output — shown once)
az ad app credential reset --id $APP_ID --display-name monok8s-sso

# Grant API permissions
az ad app permission add --id $APP_ID \
  --api 00000003-0000-0000-c000-000000000000 \  # Microsoft Graph
  --api-permissions e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope  # User.Read
```

### 2. Store credentials in Vault

```bash
vault kv put secret/monok8s/idp/entra \
  client_id=<app_id> \
  client_secret=<secret_value>
```

### 3. Apply the Zitadel IDP config

```bash
kubectl apply -f platform/zitadel/idp-federation/entra.yaml
```

The ExternalSecret pulls credentials from Vault. The init container reads the
ConfigMap and creates the IDP via Zitadel's management API.

### 4. (Optional) Restrict to specific Entra tenants

By default the app uses `common` as the tenant in the OIDC issuer, allowing any
Entra tenant. To restrict to specific tenants, update the issuer in Vault:

```bash
vault kv patch secret/monok8s/idp/entra \
  issuer_url=https://login.microsoftonline.com/<tenant_id>/v2.0
```

Then restart the Zitadel pod to re-read the config.

---

## Google Workspace setup

### 1. Create an OAuth 2.0 client

In Google Cloud Console: **APIs & Services → Credentials → Create credentials → OAuth client ID**

- Application type: Web application
- Name: monok8s
- Authorized redirect URIs: `https://auth.monok8s.io/ui/login/login/externalidp/callback`

### 2. Store credentials in Vault

```bash
vault kv put secret/monok8s/idp/google \
  client_id=<client_id>.apps.googleusercontent.com \
  client_secret=<client_secret>
```

### 3. Apply the config

```bash
kubectl apply -f platform/zitadel/idp-federation/google.yaml
```

### 4. (Optional) Restrict to a specific Google Workspace domain

To prevent personal Google accounts from signing in, add domain restriction
in the Zitadel IDP claim mapping:

In Zitadel admin console: **Identity Providers → Google → Claim mapping**
- Add a claim check: `hd` must equal `<your-workspace-domain.com>`

---

## AWS IAM Identity Center setup

### 1. Create an external application in IAM Identity Center

In AWS console: **IAM Identity Center → Applications → Add application**

- Application type: OAuth 2.0
- Display name: monok8s
- Application URL: `https://auth.monok8s.io`
- Redirect URIs: `https://auth.monok8s.io/ui/login/login/externalidp/callback`
- Scopes: `openid profile email`

Note the OIDC issuer URL from the application configuration page.

### 2. Store credentials in Vault

```bash
vault kv put secret/monok8s/idp/aws-iam-ic \
  client_id=<client_id> \
  client_secret=<client_secret> \
  issuer_url=https://<instance-id>.awsapps.com/start
```

### 3. Apply the config

```bash
kubectl apply -f platform/zitadel/idp-federation/aws-iam-ic.yaml
```

---

## Verifying federation

After applying the config, test the SSO flow:

```bash
# Check the ExternalSecret synced credentials successfully
kubectl get externalsecret zitadel-idp-entra -n zitadel
kubectl get externalsecret zitadel-idp-google -n zitadel
kubectl get externalsecret zitadel-idp-aws-iam-ic -n zitadel

# Verify the IDP appears in Zitadel
# In Zitadel admin console: Identity Providers — all three should be listed and healthy

# Test the login flow:
# 1. Open https://auth.monok8s.io in an incognito window
# 2. Click "Sign in with Microsoft/Google/AWS SSO"
# 3. Authenticate with your cloud identity
# 4. Confirm you land in the monok8s UI with your account linked
```

---

## Account linking for existing users

Users with an existing monok8s account can link their cloud identity:

1. Log in to monok8s with their existing credentials
2. Navigate to **Profile → Linked Accounts**
3. Click **Link Microsoft/Google/AWS SSO account**
4. Authenticate with the cloud IdP
5. The identities are now linked — either method works for future logins

---

## Per-tenant IDP restriction

If you want to restrict a specific tenant to only allow sign-ins via a particular
upstream IdP (e.g. "only Entra ID for tenant Acme Corp"):

1. Create a Zitadel organization for the tenant
2. Set the organization's login policy to require the specific IDP
3. Map the tenant's Zitadel organization to their monok8s tenant ID

This is advanced configuration — contact support for guidance.
