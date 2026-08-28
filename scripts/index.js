'use strict';

const fs = require('fs');
const { createClient } = require('./lib/github');
const { readState, writeState } = require('./lib/state');
const { notifyIssue, notifySlack } = require('./lib/notify');

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return String(value).trim().toLowerCase() === 'true';
}

function mapCommit(commit) {
  return {
    sha: commit.sha,
    message: commit.commit && commit.commit.message ? commit.commit.message : '',
    author:
      (commit.author && commit.author.login) ||
      (commit.commit && commit.commit.author && commit.commit.author.name) ||
      'unknown',
    url: commit.html_url,
  };
}

function mapPullRequest(pr) {
  return {
    number: pr.number,
    title: pr.title,
    author: (pr.user && pr.user.login) || 'unknown',
    url: pr.html_url,
    merged_at: pr.merged_at,
  };
}

/**
 * Write a value to GITHUB_OUTPUT if available, otherwise print it.
 */
function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  const line = `${name}<<UPSTREAM_WATCHER_EOF\n${value}\nUPSTREAM_WATCHER_EOF\n`;
  if (outputPath) {
    fs.appendFileSync(outputPath, line);
  } else {
    // eslint-disable-next-line no-console
    console.log(`${name}=${value}`);
  }
}

async function run(env = process.env) {
  const upstreamRepo = env.INPUT_UPSTREAM_REPO;
  const branch = env.INPUT_BRANCH || 'main';
  const token = env.INPUT_GITHUB_TOKEN || '';
  const statePath = env.INPUT_STATE_PATH || '.github/upstream-watcher-state.json';
  const checkCommits = parseBoolean(env.INPUT_CHECK_COMMITS, true);
  const checkMergedPrs = parseBoolean(env.INPUT_CHECK_MERGED_PRS, true);
  const notifyMethod = (env.INPUT_NOTIFY_METHOD || 'issue').toLowerCase();
  const slackWebhookUrl = env.INPUT_SLACK_WEBHOOK_URL || '';
  const issueLabels = (env.INPUT_ISSUE_LABELS || 'upstream-update')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
  const consumerRepo = env.GITHUB_REPOSITORY;

  if (!upstreamRepo) {
    throw new Error('Input "upstream-repo" is required (format: owner/repo).');
  }
  if (notifyMethod === 'slack' && !slackWebhookUrl) {
    throw new Error('Input "slack-webhook-url" is required when notify-method is "slack".');
  }
  if (!['issue', 'slack', 'none'].includes(notifyMethod)) {
    throw new Error(`Invalid notify-method "${notifyMethod}". Must be one of: issue, slack, none.`);
  }

  const client = createClient(token);
  const previousState = readState(statePath) || {};
  const isFirstRun = !previousState.lastCommitSha && !previousState.lastMergedPr;

  let newCommits = [];
  let newMergedPrs = [];
  let nextLastCommitSha = previousState.lastCommitSha || null;
  let nextLastMergedPr = previousState.lastMergedPr || null;

  if (checkCommits) {
    if (isFirstRun || !previousState.lastCommitSha) {
      nextLastCommitSha = await client.getLatestCommitSha(upstreamRepo, branch);
    } else {
      const commits = await client.listCommitsSince(upstreamRepo, branch, previousState.lastCommitSha);
      newCommits = commits.map(mapCommit);
      if (commits.length > 0) {
        nextLastCommitSha = commits[0].sha;
      }
    }
  }

  if (checkMergedPrs) {
    if (isFirstRun || !previousState.lastMergedPr) {
      const latest = await client.getLatestMergedPullRequest(upstreamRepo);
      nextLastMergedPr = latest ? { number: latest.number, mergedAt: latest.merged_at } : null;
    } else {
      const pulls = await client.listMergedPullRequestsSince(upstreamRepo, previousState.lastMergedPr);
      newMergedPrs = pulls.map(mapPullRequest);
      if (pulls.length > 0) {
        nextLastMergedPr = { number: pulls[0].number, mergedAt: pulls[0].merged_at };
      }
    }
  }

  writeState(statePath, {
    lastCommitSha: nextLastCommitSha,
    lastMergedPr: nextLastMergedPr,
    updatedAt: new Date().toISOString(),
  });

  const hasUpdates = newCommits.length > 0 || newMergedPrs.length > 0;

  if (hasUpdates && notifyMethod !== 'none' && !isFirstRun) {
    if (notifyMethod === 'issue') {
      if (!consumerRepo) {
        throw new Error('GITHUB_REPOSITORY environment variable is required for notify-method "issue".');
      }
      await notifyIssue({
        client,
        repo: consumerRepo,
        upstreamRepo,
        labels: issueLabels,
        newCommits,
        newMergedPrs,
      });
    } else if (notifyMethod === 'slack') {
      await notifySlack({ webhookUrl: slackWebhookUrl, upstreamRepo, newCommits, newMergedPrs });
    }
  }

  setOutput('new-commits', JSON.stringify(newCommits));
  setOutput('new-merged-prs', JSON.stringify(newMergedPrs));
  setOutput('has-updates', hasUpdates ? 'true' : 'false');

  return { newCommits, newMergedPrs, hasUpdates, isFirstRun };
}

if (require.main === module) {
  run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`::error::${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run, mapCommit, mapPullRequest, parseBoolean };
