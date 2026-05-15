# Cost allocation by tenant

Every cloud resource provisioned by Crossplane carries a standard tag set:

| Tag key | Value |
|---|---|
| `monok8s.io/managed` | `"true"` |
| `monok8s.io/resource-type` | e.g. `"tenant"` |
| `monok8s.io/resource-id` | UUID of the resource |
| `monok8s.io/tenant-id` | UUID of the owning tenant |

All three cloud billing systems support filtering and grouping by these tags,
so per-tenant cost reporting requires no additional tagging — only a saved filter
or export configuration.

---

## GCP — Billing export to BigQuery

1. Enable billing export: **Billing → Billing export → BigQuery export → Edit settings**
   - Project: your billing export project
   - Dataset: `monok8s_billing`
   - Table prefix: `gcp_billing_export`

2. Query per-tenant cost (last 30 days):
   ```sql
   SELECT
     labels.value                          AS tenant_id,
     SUM(cost)                             AS total_cost_usd,
     SUM(cost) / 30                        AS daily_avg_usd,
     service.description                   AS service,
     resource.name                         AS resource
   FROM `PROJECT.monok8s_billing.gcp_billing_export_*`
   CROSS JOIN UNNEST(labels) AS labels
   WHERE labels.key = 'monok8s.io/tenant-id'
     AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
                             AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
   GROUP BY 1, 3, 4
   ORDER BY total_cost_usd DESC
   ```

3. To see costs for a specific tenant:
   ```sql
   -- Replace <uuid> with the tenant ID
   SELECT service.description, SUM(cost) AS cost_usd
   FROM `PROJECT.monok8s_billing.gcp_billing_export_*`
   CROSS JOIN UNNEST(labels) AS labels
   WHERE labels.key = 'monok8s.io/tenant-id'
     AND labels.value = '<uuid>'
   GROUP BY 1 ORDER BY 2 DESC
   ```

4. Budget alerts per tenant: **Billing → Budgets & alerts → Create budget**
   - Filter by label `monok8s.io/tenant-id = <uuid>`
   - Alert threshold: e.g. $100/month
   - Notification: Pub/Sub topic `monok8s-billing-alerts` (routes to `ingestAlerts`)

---

## AWS — Cost Explorer and Cost and Usage Report

### Cost Explorer (ad hoc)

1. **AWS Console → Cost Explorer → Explore costs**
2. **Group by**: Tag → `monok8s.io/tenant-id`
3. **Filter**: Tag `monok8s.io/managed = true`
4. Save as a **Cost Explorer report** for recurring access.

AWS CLI equivalent:
```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -d '30 days ago' +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --group-by Type=TAG,Key="monok8s.io/tenant-id" \
  --filter '{
    "Tags": {
      "Key": "monok8s.io/managed",
      "Values": ["true"]
    }
  }'
```

### Cost and Usage Report (CUR) for programmatic access

1. **Billing → Cost and Usage Reports → Create report**
   - Report name: `monok8s-cur`
   - S3 bucket: `monok8s-pgbackups` (reuse existing) or a dedicated `monok8s-cur` bucket
   - Compression: Parquet
   - Time granularity: Hourly

2. Query with Athena after the CUR lands in S3:
   ```sql
   SELECT
     resource_tags_user_monok8s_io_tenant_id AS tenant_id,
     product_product_name                    AS service,
     SUM(line_item_unblended_cost)           AS cost_usd
   FROM monok8s_cur
   WHERE resource_tags_user_monok8s_io_managed = 'true'
     AND line_item_usage_start_date >= current_date - interval '30' day
   GROUP BY 1, 2
   ORDER BY cost_usd DESC
   ```
   *(AWS CUR converts tag keys to column names: `.` → `_`, `/` → `_`)*

### Budget alerts

```bash
aws budgets create-budget \
  --account-id <account_id> \
  --budget '{
    "BudgetName": "monok8s-tenant-<uuid>",
    "BudgetLimit": { "Amount": "100", "Unit": "USD" },
    "TimeUnit": "MONTHLY",
    "BudgetType": "COST",
    "CostFilters": {
      "TagKeyValue": ["monok8s.io/tenant-id$<uuid>"]
    }
  }' \
  --notifications-with-subscribers '[{
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80
    },
    "Subscribers": [{"SubscriptionType": "SNS", "Address": "arn:aws:sns:us-east-1:<account>:monok8s-billing-alerts"}]
  }]'
```

Route the SNS topic `monok8s-billing-alerts` to the API `ingestAlerts` endpoint
(same pattern as Model B alerts) with `tenant_id` extracted from the budget name.

---

## Azure — Cost Management

### Cost analysis (ad hoc)

1. **Azure Portal → Cost Management + Billing → Cost analysis**
2. **Group by**: Tag → `monok8s.io/tenant-id`
3. **Filter**: Tag `monok8s.io/managed = true`
4. **Save view** for reuse.

Azure CLI equivalent:
```bash
az costmanagement query \
  --type Usage \
  --timeframe MonthToDate \
  --dataset-aggregation '{"totalCost":{"name":"Cost","function":"Sum"}}' \
  --dataset-grouping '[{"type":"TagKey","name":"monok8s.io/tenant-id"}]' \
  --dataset-filter '{
    "and": [{
      "tags": {
        "name": "monok8s.io/managed",
        "operator": "In",
        "values": ["true"]
      }
    }]
  }'
```

### Export to Storage Account for programmatic access

1. **Cost Management → Exports → Add**
   - Export type: Daily export of month-to-date costs
   - Storage account: `monok8sprod` (existing)
   - Container: `cost-exports`
   - Directory: `monok8s-costs`

2. Process with Azure Data Factory or direct blob download:
   ```bash
   az storage blob download-batch \
     --source cost-exports/monok8s-costs \
     --destination ./cost-data \
     --account-name monok8sprod
   ```

### Budget alerts

```bash
az consumption budget create \
  --budget-name "monok8s-tenant-<uuid>" \
  --amount 100 \
  --time-grain Monthly \
  --category Cost \
  --resource-group monok8s-prod \
  --filter '{
    "tags": {
      "monok8s.io/tenant-id": ["<uuid>"]
    }
  }' \
  --notifications '{
    "actual_GreaterThan_80_Percent": {
      "enabled": true,
      "operator": "GreaterThan",
      "threshold": 80,
      "contactEmails": [],
      "contactRoles": [],
      "contactGroups": ["/subscriptions/<id>/resourceGroups/monok8s-prod/providers/microsoft.insights/actionGroups/monok8s-billing"]
    }
  }'
```

---

## Grafana dashboard

The tags are consistent across all three clouds, so a single Grafana dashboard
can show normalised per-tenant cost if you:

1. Export CUR/billing data to a common sink (BigQuery or a Postgres table)
2. Use the existing Grafana instance (already connected to Loki/Mimir)
3. Add a PostgreSQL data source pointing at the cost summary table

Alternatively, embed cloud-native cost dashboards via iframe in the monok8s
frontend (available in all three cloud portals as shareable links).

---

## Chargeback to tenants

If you want to surface cost data to tenant admins:

1. Add a `costs` tRPC router that queries the billing export sink
2. Gate it behind the `billing_manager` SpiceDB permission
3. Return the cost breakdown filtered to `monok8s.io/tenant-id = ctx.user.tenantId`

The `billing_manager` role is already defined in the SpiceDB schema and in all
three cloud compositions — no additional permission work is needed.
