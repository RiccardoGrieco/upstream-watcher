# upstream-watcher

A reusable GitHub Action + reusable workflow that lets you monitor a **public GitHub
repository you don't own or control** for new commits pushed to a branch and newly
merged pull requests — without needing to add any workflow to that upstream repo.

## Why?

GitHub doesn't allow you to create a *private fork* of a public repository. A common
workaround is to copy the public repo's content into your own private repository
instead of forking it. The downside: you lose the "fork" relationship, so you no
longer get any signal when the upstream project pushes new commits or merges pull
requests.

Since you don't own the upstream repo, you can't add a workflow *inside it* to notify
you (GitHub Actions can only react to events in the repository the workflow lives in).
The only reliable option is **polling the GitHub REST API from your own repository**
on a schedule — which is exactly what this action does.

## How it works

- A scheduled workflow (that you add to your own consumer repo) runs this action.
- The action reads the last-seen commit SHA / merged PR from a small JSON state file
  **in your repo's checkout** (it does not check out any repo itself).
- It queries the GitHub REST API for the upstream repo:
  - `GET /repos/{upstream-repo}/commits?sha={branch}` for new commits (paginated
    until the previously-seen SHA is reached).
  - `GET /repos/{upstream-repo}/pulls?state=closed&sort=updated&direction=desc` for
    newly merged pull requests (filtered to `merged_at != null`, stopping once
    previously-seen PRs are reached).
- On the **first run** (no state file yet), it records the current HEAD / latest
  merged PR as a baseline and does **not** send a notification — this avoids
  flooding you with the entire repo history.
- Depending on `notify-method`, it creates/updates a GitHub issue, posts to a Slack
  webhook, or simply exposes outputs for a custom step to consume.
- It's implemented as a small, tested Node.js script (`scripts/index.js`, using
  Node's built-in `fetch` and `node:test`) rather than inline shell/`jq`, for
  readability and testability, wired up via a composite `action.yml`.

Your workflow is responsible for committing the updated state file back to your repo
(see the example below), since the action itself only modifies files on disk.

## Usage

### Option A — composite action

Add a workflow like this to your **own** repository (the one you don't want to flood
with upstream history, but do want to be notified in):

```yaml
name: Watch upstream repository

on:
  schedule:
    - cron: "*/30 * * * *"
  workflow_dispatch:

permissions:
  contents: write
  issues: write

jobs:
  watch-upstream:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - id: watch
        uses: RiccardoGrieco/upstream-watcher@v1
        with:
          upstream-repo: "some-owner/some-public-repo"
          branch: main
          github-token: ${{ secrets.GITHUB_TOKEN }}
          notify-method: issue

      - name: Commit updated state file
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add .github/upstream-watcher-state.json
          git diff --cached --quiet || git commit -m "chore: update upstream-watcher state"
          git push
```

A ready-to-copy version of this workflow lives at
[`examples/watch-upstream.yml`](examples/watch-upstream.yml).

You can also commit the state file with
[`stefanzweifel/git-auto-commit-action`](https://github.com/stefanzweifel/git-auto-commit-action)
instead of the manual `git` steps above.

### Option B — reusable workflow

Instead of wiring the composite action + checkout + commit steps yourself, call the
bundled reusable workflow:

```yaml
name: Watch upstream repository

on:
  schedule:
    - cron: "*/30 * * * *"
  workflow_dispatch:

jobs:
  watch:
    uses: RiccardoGrieco/upstream-watcher/.github/workflows/reusable-watch.yml@main
    with:
      upstream-repo: "some-owner/some-public-repo"
      branch: main
      notify-method: issue
    secrets:
      slack-webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }} # only if notify-method is slack
```

The reusable workflow checks out your repo, runs the action, and commits the updated
state file back for you.

## Inputs

| Input                | Required | Default                                  | Description                                                                                     |
| --------------------- | -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `upstream-repo`       | Yes      | —                                          | `owner/repo` of the public repository to watch.                                                  |
| `branch`              | No       | `main`                                     | Branch to watch for new commits.                                                                  |
| `github-token`        | Yes      | —                                          | Token used for API calls. Works with unauthenticated public API too, but pass one for higher rate limits. |
| `state-path`          | No       | `.github/upstream-watcher-state.json`      | Path in the consumer repo used to persist last-seen commit SHA / merged PR.                       |
| `check-commits`       | No       | `true`                                     | Whether to check for new commits on the branch.                                                   |
| `check-merged-prs`    | No       | `true`                                     | Whether to check for newly merged pull requests.                                                  |
| `notify-method`       | No       | `issue`                                    | One of `issue`, `slack`, `none`.                                                                   |
| `slack-webhook-url`   | No       | —                                          | Required when `notify-method` is `slack`.                                                         |
| `issue-labels`        | No       | `upstream-update`                          | Comma-separated labels applied to the created/updated issue.                                      |

## Outputs

| Output           | Description                                                                          |
| ----------------- | ------------------------------------------------------------------------------------- |
| `new-commits`     | JSON array of new commit objects (`sha`, `message`, `author`, `url`) since last check. |
| `new-merged-prs`  | JSON array of newly merged PR objects (`number`, `title`, `author`, `url`, `merged_at`) since last check. |
| `has-updates`     | `"true"` or `"false"`.                                                                 |

## Notifications

- **`issue`** — looks for an open issue titled `Upstream updates: {upstream-repo}`
  carrying the configured `issue-labels`. If found, adds a comment; otherwise creates
  it. The body lists new commits (short SHA, first line of the message, author, link)
  and newly merged PRs (title, number, author, merge date, link) in Markdown.
- **`slack`** — posts a Slack Block Kit message with the same summary to
  `slack-webhook-url`.
- **`none`** — no built-in notification; use the action's outputs (`new-commits`,
  `new-merged-prs`, `has-updates`) in your own subsequent step (e.g. custom
  Slack/Discord/email integration).

## Permissions

The workflow that calls this action typically needs:

- `contents: write` — to commit the updated state file back to your repo.
- `issues: write` — only if using `notify-method: issue`.

## Rate limits & polling interval

Unauthenticated requests to the GitHub REST API are limited to 60 requests/hour per
IP; authenticated requests (passing `github-token`) get 5,000 requests/hour (or the
appropriate limit for your token type). Each run of this action makes a small,
constant number of requests (a page of commits, a page of pull requests, and
optionally an issue lookup/create/comment), so polling every 15–30 minutes is safe
and recommended. If the API responds with a rate-limit error, the action fails with a
clear error message including when the limit resets — consider passing a token with a
higher rate limit or increasing the interval between runs.

## Versioning

- `v1` — stable major version tag for the composite action (`uses:
  RiccardoGrieco/upstream-watcher@v1`).
- `main` — tracks the latest commit, used for the reusable workflow (`uses:
  RiccardoGrieco/upstream-watcher/.github/workflows/reusable-watch.yml@main`).

## Development

The action's logic lives in `scripts/` as plain Node.js (no build step, no external
dependencies), using the Node.js built-in test runner:

```bash
node --test scripts/test/*.js
```

## License

[MIT](LICENSE)
