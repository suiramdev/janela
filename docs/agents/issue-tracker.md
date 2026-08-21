# Issue Tracker

Issues for this repository are tracked in **GitHub Issues** at `suiramdev/janela`.

## Creating issues

Use the `gh` CLI:

```bash
gh issue create --title "Title" --body "Description"
```

Or through the GitHub web UI.

## Reading issues

```bash
# List all open issues
gh issue list

# View a specific issue
gh issue view <number>
```

## PRs as a request surface

**Disabled by default.** External pull requests are not treated as incoming work items for triage.

To enable: change this flag to `true` and document the workflow you want agents to follow when triaging external PRs.
