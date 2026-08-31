'use strict';

/**
 * Format the Markdown body for the tracking issue / comment.
 * @param {string} upstreamRepo
 * @param {Array} newCommits
 * @param {Array} newMergedPrs
 */
function formatIssueBody(upstreamRepo, newCommits, newMergedPrs) {
  const lines = [];
  lines.push(`Detected new activity on [\`${upstreamRepo}\`](https://github.com/${upstreamRepo}).`);
  lines.push('');

  if (newCommits.length > 0) {
    lines.push(`### New commits (${newCommits.length})`);
    lines.push('');
    for (const commit of newCommits) {
      const shortSha = commit.sha.substring(0, 7);
      const firstLine = (commit.message || '').split('\n')[0];
      lines.push(`- [\`${shortSha}\`](${commit.url}) ${firstLine} — ${commit.author}`);
    }
    lines.push('');
  }

  if (newMergedPrs.length > 0) {
    lines.push(`### Newly merged pull requests (${newMergedPrs.length})`);
    lines.push('');
    for (const pr of newMergedPrs) {
      lines.push(`- [#${pr.number}](${pr.url}) ${pr.title} — @${pr.author} (merged ${pr.merged_at})`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Format a plain-text/Slack Block Kit message summarizing the updates.
 */
function formatSlackMessage(upstreamRepo, newCommits, newMergedPrs) {
  const lines = [`*Upstream updates: ${upstreamRepo}*`];

  if (newCommits.length > 0) {
    lines.push('');
    lines.push(`*New commits (${newCommits.length})*`);
    for (const commit of newCommits) {
      const shortSha = commit.sha.substring(0, 7);
      const firstLine = (commit.message || '').split('\n')[0];
      lines.push(`• <${commit.url}|${shortSha}> ${firstLine} — ${commit.author}`);
    }
  }

  if (newMergedPrs.length > 0) {
    lines.push('');
    lines.push(`*Newly merged pull requests (${newMergedPrs.length})*`);
    for (const pr of newMergedPrs) {
      lines.push(`• <${pr.url}|#${pr.number}> ${pr.title} — @${pr.author} (merged ${pr.merged_at})`);
    }
  }

  const text = lines.join('\n');
  return {
    text,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
    ],
  };
}

/**
 * Create or update the GitHub issue notifying about upstream changes.
 */
async function notifyIssue({ client, repo, upstreamRepo, labels, newCommits, newMergedPrs }) {
  const title = `Upstream updates: ${upstreamRepo}`;
  const body = formatIssueBody(upstreamRepo, newCommits, newMergedPrs);
  const existing = await client.findOpenIssueByTitle(repo, title, labels);
  if (existing) {
    await client.commentOnIssue(repo, existing.number, body);
    return { action: 'commented', issueNumber: existing.number };
  }
  const created = await client.createIssue(repo, title, body, labels);
  return { action: 'created', issueNumber: created.number };
}

/**
 * Post a Slack webhook notification.
 */
async function notifySlack({ webhookUrl, upstreamRepo, newCommits, newMergedPrs }) {
  const message = formatSlackMessage(upstreamRepo, newCommits, newMergedPrs);
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Slack webhook request failed with status ${response.status}: ${body}`);
  }
}

module.exports = { formatIssueBody, formatSlackMessage, notifyIssue, notifySlack };
