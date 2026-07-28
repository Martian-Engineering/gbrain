# Nightly maintenance

The nightly maintenance root is a protected Minion job that performs
source-scoped maintenance, deterministic link repair, bounded semantic repair,
verification, and contradiction probing.

## Runtime contract

- Schedule: 10:00 UTC every day.
- Model: `openai:gpt-5.6-terra`.
- Reasoning effort: `high`.
- Shared model-spend cap: 1,500 cents per UTC day.
- Semantic repair concurrency: one child at a time.
- Initial page-mutation ceiling: 10.
- Root runtime ceiling: two hours.
- Repair retry limit: one retry.

The root and repair child names are protected. Remote MCP clients cannot submit
them. Each repair child is bound to one source and can write only one exact
page slug. It can use source-scoped page, search, query, resolution, schema,
and link-validation operations to investigate. It has no shell, delete,
rename, merge, credential, or provisioning operation.

## Autonomous semantic outcomes

The repair agent does not create review proposals. It returns one validated
decision with its candidate evidence, exact edit, rationale, confidence,
operations, and verification claims.

- `applied + replace_reference` means the agent found one canonical
  replacement at or above 0.90 confidence and wrote it immediately.
- `deferred + recover_source` means the cited provenance object appears
  unavailable or un-ingested, so the page was intentionally left unchanged.
- `deferred + leave_unresolved` means the evidence could not support a unique
  correction or a concrete recovery path.
- `failed + leave_unresolved` is reserved for an execution failure.

The 0.90 score is only one condition. An applied repair must also bind its
replacement to retained candidate evidence, change the diagnosed page, remove
the unresolved target, resolve the replacement, and pass frontmatter lint.
The server independently performs those checks. Any failure restores the
complete pre-write page snapshot.

Explicit page references are also re-extracted into the graph during the
deterministic repair phase. Residual graph-parity or other proposal-only
findings stay visible in the report but are not sent to an agent, because the
current agent contract cannot execute them.

The contradiction probe uses hybrid retrieval without the optional external
reranker. This keeps every provider used by the probe inside the same priced,
hard budget enforced by the nightly root.

Provider-specific Gmail or Granola re-ingestion is not available to these
agents yet. Such findings are retained as `recover_source`; they are not
silently repointed to related material.

## Install without enabling

Install both units and reload systemd:

```sh
sudo install -m 0644 ops/systemd/gbrain-nightly-maintenance.service /etc/systemd/system/
sudo install -m 0644 ops/systemd/gbrain-nightly-maintenance.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

Do not enable the timer until the controlled write-enabled run has been
inspected. The Minion supervisor must run with concurrency of at least two:
the root occupies one slot while it waits for one source-bound child in the
second slot.

## Controlled run

Submit the same contract used by the timer:

```sh
gbrain jobs nightly-maintenance --budget-cents 1500 --max-page-mutations 10
```

The command prints the root job ID. Inspect it with:

```sh
gbrain jobs get JOB_ID
```

Review the report, every changed slug and before/after hash, complete autonomous
outcomes, rolled-back receipts, remaining findings, and settled spend. Confirm
that `applied` receipts contain a validated replacement and that `deferred`
receipts have identical before/after hashes. If the result is acceptable:

```sh
sudo systemctl enable --now gbrain-nightly-maintenance.timer
systemctl list-timers gbrain-nightly-maintenance.timer
```

The timer's `Persistent=true` setting submits a missed run after a host outage.
The UTC-date idempotency key prevents duplicate roots for the same day.

## Disable and roll back

Disable only the new timer:

```sh
sudo systemctl disable --now gbrain-nightly-maintenance.timer
```

Restore the previous timer unit files from the deployment backup, reload
systemd, and re-enable them only when reverting the consolidated schedule.
Page-level verification failures are restored automatically from the prewrite
snapshot and reported as `failed_rolled_back`.
