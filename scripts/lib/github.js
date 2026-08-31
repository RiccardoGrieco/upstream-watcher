'use strict';

const API_ROOT = 'https://api.github.com';

class GitHubApiError extends Error {
  constructor(message, response) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = response ? response.status : undefined;
  }
}

/**
 * Create a small GitHub REST API client.
 * @param {string} token - GitHub token (may be empty for unauthenticated public access).
 */
function createClient(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'upstream-watcher-action',
  };
  if (token) {
    headers.Authorization = `token ${token}`;
  }

  async function request(path, options = {}) {
    const url = path.startsWith('http') ? path : `${API_ROOT}${path}`;
    const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });

    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (remaining === '0') {
        const resetHeader = response.headers.get('x-ratelimit-reset');
        const resetDate = resetHeader ? new Date(Number(resetHeader) * 1000).toISOString() : 'unknown';
        throw new GitHubApiError(
          `GitHub API rate limit exceeded. Limit resets at ${resetDate}. ` +
            'Consider passing a github-token with a higher rate limit or increasing the polling interval.',
          response
        );
      }
    }

    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch (e) {
        // ignore body read failures
      }
      throw new GitHubApiError(`GitHub API request to ${url} failed with status ${response.status}: ${body}`, response);
    }

    return response;
  }

  async function getJson(path) {
    const response = await request(path);
    return response.json();
  }

  async function getCommit(repo, shaOrRef) {
    return getJson(`/repos/${repo}/commits/${encodeURIComponent(shaOrRef)}`);
  }

  /**
   * Walk first-parent history from `branch` down to `untilSha`, mirroring `git log
   * --first-parent` so merge commits are reported without re-listing every commit
   * that was merged in from the other parent.
   * Returns commits newest-first, excluding `untilSha` itself.
   */
  async function listCommitsSince(repo, branch, untilSha, { maxCommits = 1000 } = {}) {
    const collected = [];
    let current = await getCommit(repo, branch);
    while (current) {
      if (untilSha && current.sha === untilSha) {
        break;
      }
      collected.push(current);
      if (collected.length >= maxCommits) {
        break;
      }
      const parentSha = current.parents && current.parents[0] && current.parents[0].sha;
      if (!parentSha) {
        break;
      }
      current = await getCommit(repo, parentSha);
    }
    return collected;
  }

  /**
   * Fetch merged pull requests newer than the previously seen one.
   * `since` is `{ number, mergedAt }` or null on first run.
   */
  async function listMergedPullRequestsSince(repo, since, { maxPages = 5, perPage = 50 } = {}) {
    const collected = [];
    let page = 1;
    while (page <= maxPages) {
      const pulls = await getJson(
        `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${perPage}&page=${page}`
      );
      if (!Array.isArray(pulls) || pulls.length === 0) {
        break;
      }
      let stop = false;
      for (const pr of pulls) {
        if (!pr.merged_at) {
          continue;
        }
        if (since && (pr.number === since.number || new Date(pr.merged_at) < new Date(since.mergedAt))) {
          stop = true;
          break;
        }
        collected.push(pr);
      }
      if (stop || pulls.length < perPage) {
        break;
      }
      page += 1;
    }
    return collected;
  }

  async function getLatestCommitSha(repo, branch) {
    const commit = await getCommit(repo, branch);
    return commit.sha;
  }

  async function getLatestMergedPullRequest(repo, { maxPages = 5, perPage = 50 } = {}) {
    let page = 1;
    while (page <= maxPages) {
      const pulls = await getJson(
        `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${perPage}&page=${page}`
      );
      if (!Array.isArray(pulls) || pulls.length === 0) {
        break;
      }
      const merged = pulls.find((pr) => pr.merged_at);
      if (merged) {
        return merged;
      }
      if (pulls.length < perPage) {
        break;
      }
      page += 1;
    }
    return null;
  }

  async function findOpenIssueByTitle(repo, title, labels) {
    const labelParam = labels && labels.length ? `&labels=${encodeURIComponent(labels.join(','))}` : '';
    const issues = await getJson(`/repos/${repo}/issues?state=open${labelParam}&per_page=100`);
    if (!Array.isArray(issues)) {
      return null;
    }
    return issues.find((issue) => !issue.pull_request && issue.title === title) || null;
  }

  async function createIssue(repo, title, body, labels) {
    const response = await request(`/repos/${repo}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, labels }),
    });
    return response.json();
  }

  async function commentOnIssue(repo, issueNumber, body) {
    const response = await request(`/repos/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    return response.json();
  }

  return {
    getJson,
    listCommitsSince,
    listMergedPullRequestsSince,
    getLatestCommitSha,
    getLatestMergedPullRequest,
    findOpenIssueByTitle,
    createIssue,
    commentOnIssue,
  };
}

module.exports = { createClient, GitHubApiError };
