---
paths:
  - "src/services/safety.js"
  - "src/workflows/**/*.js"
  - "src/commands/**/*.js"
---

# Safety & Approval Rules

- Small budget changes (under $50) can auto-approve
- Campaign launches ALWAYS require owner approval
- Auto-pause campaigns when: ROAS < 20% target for 3+ days, CPA > 3x target, $500+ spend with 0 conversions
- Never expose raw API errors to clients — always use friendly fallback messages
- Log all significant actions to audit_log table
- Respect daily AI budget limits (`MONTHLY_AI_BUDGET_CENTS`, `DAILY_COST_ALERT_THRESHOLD_CENTS`)
- Never delete client data without explicit owner confirmation
- Validate all tool inputs before executing ad platform operations
