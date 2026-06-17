---
name: Bug report
about: Describe a failure mode you observed running the fleet
title: "[BUG] "
labels: bug
---

## what failed

<!-- one-line summary of the failure shape -->

## reproduction

<!-- steps, OR a description of the conditions under which it surfaced —
fleet of N, runtime in hours, anything anomalous about the host (low disk,
high CPU, etc) -->

## expected vs actual

<!-- what should have happened, what actually happened -->

## evidence

<!-- log lines, screenshots, snippets from /api/bots/:id/state, dashboard
status, watchdog output. Search by bot name / time window in
data/logs/dev-server.YYYY-MM-DD.log. -->

## environment

- OS:
- Node:
- mineflayer version:
- minecraft server flavour (paper/spigot/vanilla) and version:
- LLM provider + model:

## fleet shape

- bots running concurrently:
- runtime when bug surfaced:
- recent restarts:

## anything you tried

<!-- guards you considered, fixes you ruled out -->
