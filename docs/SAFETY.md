# Safety Rails & Approval System

## Approval Tiers

### Auto-Approve (no human confirmation needed)
- Budget changes < $50/day per campaign
- Bid adjustments < 20%
- Pause campaigns with ROAS < 0.2x target for 3+ days
- Pause campaigns with CPA > 3x target
- Pause campaigns with significant spend and zero conversions
- Resume campaigns paused for testing after test completes
- A/B test winner scaling within existing budget
- Creative rotation when performance is similar

### Requires Approval (WhatsApp confirmation)
- Budget changes > $50/day
- New campaign launches
- Budget > $500/day campaigns
- Audience changes affecting > 50% of spend
- Campaign deletions (converted to pause)
- Major strategic pivots
- Budget reallocation > $500 between campaigns

### Always Requires Approval
- Anything affecting > 20% of total client budget
- New client onboarding decisions
- Service termination recommendations
- Billing/invoicing changes
- Contract modifications
- Client communication beyond automated reports

## Blocked Actions (Never Executed)
- `delete_campaign` — Only pause is allowed
- `remove_payment` — Payment methods are never touched
- `change_access` — Account permissions are never modified
- `modify_contract` — Contracts are out of scope

## Spending Limits
- Hard daily limit per campaign (cannot exceed)
- Weekly spend caps per client
- Account-level monthly budgets
- Alert when approaching 80% of any limit

## Performance Thresholds
- Auto-pause if CPA > 3x target
- Auto-pause if ROAS < 0.2x target for 3+ days
- Alert if spend > $500 with zero conversions

## Error Handling
- API failures: retry 3x with exponential backoff, then alert human
- Invalid data: skip and log error, continue processing other clients
- Unexpected behavior: fail safe (pause, don't proceed)
- Budget exceeded: block further AI calls, alert owner

## Audit Trail
- Every action is logged to SQLite with timestamp, workflow, client, details
- Every approval decision is recorded (who approved, approval type)
- Rollback data stored for reversible actions
- Queryable via WhatsApp: "audit log" or "audit log for [client]"

## Implementation
- **Safety service:** `src/services/safety.js`
- **Cost tracker/audit:** `src/services/cost-tracker.js`
- All campaign mutations go through `safeExecute()` which validates, logs, and enforces approval
