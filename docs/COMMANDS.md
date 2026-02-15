# WhatsApp Commands Reference

The system accepts natural language commands via WhatsApp. No exact syntax required.

## Performance
- `stats for [client]` — 7-day performance summary for a client
- `how is [client] performing?` — Same as stats
- `show me all clients` — List all active clients with platforms

## Campaign Management
- `pause campaign [ID] on [platform]` — Pause a campaign (requires approval)
- `resume campaign [ID]` — Resume a paused campaign (requires approval)

## Tasks
- `overdue tasks` — List all overdue ClickUp tasks
- `what's due today?` — Tasks due today
- `daily standup` — Full standup report with capacity analysis

## Reports
- `morning briefing` — Trigger the morning intelligence briefing
- `weekly report for [client]` — Generate weekly report
- `monthly report for [client]` — Generate monthly report

## Budget & Costs
- `budget for [client]` — Client budget info and targets
- `budget overview` — All clients budget summary
- `AI cost report` — Monthly AI/API costs
- `cost report today` — Today's AI costs only

## Intelligence
- `competitor analysis for [client]` — Run competitor research
- `client info for [client]` — Full client profile from knowledge base
- `audit log` — Recent system actions

## Approvals

When the system requests approval for an action:
- `APPROVE [id]` — Approve and execute
- `DENY [id]` — Cancel the action
- `DETAILS [id]` — Get more info before deciding

## System
- `help` — Show all commands

## Status Indicators
- ✅ Success / On track
- ⚠️ Warning / Needs attention
- 🚨 Critical / Urgent
- ❌ Error / Failed
- 🟢 Health 8-10 | 🟡 Health 5-7 | 🔴 Health 1-4
