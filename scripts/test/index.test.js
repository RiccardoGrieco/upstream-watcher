'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../index');

function mockResponse(status, jsonBody, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headers[name.toLowerCase()] ?? null,
    },
    json: async () => jsonBody,
    text: async () => JSON.stringify(jsonBody),
  };
}

function withMockFetch(handler, fn) {
  const originalFetch = global.fetch;
  global.fetch = handler;
  return fn().finally(() => {
    global.fetch = originalFetch;
  });
}

function tmpStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-watcher-'));
  return path.join(dir, 'state.json');
}

test('first run establishes baseline without reporting updates or notifying', async () => {
  const statePath = tmpStatePath();
  const calls = [];

  await withMockFetch(async (url) => {
    calls.push(url);
    if (url.includes('/commits/main')) {
      return mockResponse(200, { sha: 'abc123' });
    }
    if (url.includes('/pulls')) {
      return mockResponse(200, [{ number: 5, merged_at: '2024-01-01T00:00:00Z', title: 'PR', user: { login: 'a' }, html_url: 'u' }]);
    }
    if (url.includes('/issues')) {
      throw new Error('should not create issue on first run');
    }
    throw new Error(`unexpected url ${url}`);
  }, async () => {
    const result = await run({
      INPUT_UPSTREAM_REPO: 'octocat/Hello-World',
      INPUT_GITHUB_TOKEN: '',
      INPUT_STATE_PATH: statePath,
      GITHUB_REPOSITORY: 'me/private-copy',
    });

    assert.equal(result.isFirstRun, true);
    assert.equal(result.hasUpdates, false);
    assert.deepEqual(result.newCommits, []);
    assert.deepEqual(result.newMergedPrs, []);
  });

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.lastCommitSha, 'abc123');
  assert.equal(state.lastMergedPr.number, 5);
});

test('subsequent run reports new commits and merged PRs, and creates an issue', async () => {
  const statePath = tmpStatePath();
  fs.writeFileSync(
    statePath,
    JSON.stringify({ lastCommitSha: 'old-sha', lastMergedPr: { number: 1, mergedAt: '2023-01-01T00:00:00Z' } })
  );

  let issueCreated = null;

  const commitsBySha = {
    main: { sha: 'newsha2222222', commit: { message: 'second\nbody' }, author: { login: 'bob' }, html_url: 'https://example.com/2', parents: [{ sha: 'newsha1111111' }] },
    newsha1111111: { sha: 'newsha1111111', commit: { message: 'first' }, author: { login: 'alice' }, html_url: 'https://example.com/1', parents: [{ sha: 'old-sha' }] },
    'old-sha': { sha: 'old-sha', commit: { message: 'old' }, author: { login: 'carol' }, html_url: 'https://example.com/0', parents: [] },
  };

  await withMockFetch(async (url, options = {}) => {
    const commitMatch = url.match(/\/commits\/([^/?]+)$/);
    if (commitMatch && commitsBySha[commitMatch[1]]) {
      return mockResponse(200, commitsBySha[commitMatch[1]]);
    }
    if (url.includes('/pulls?')) {
      return mockResponse(200, [
        { number: 3, merged_at: '2024-02-01T00:00:00Z', title: 'New feature', user: { login: 'dave' }, html_url: 'https://example.com/pr/3' },
        { number: 1, merged_at: '2023-01-01T00:00:00Z', title: 'Old', user: { login: 'eve' }, html_url: 'https://example.com/pr/1' },
      ]);
    }
    if (url.includes('/issues?')) {
      return mockResponse(200, []);
    }
    if (url.endsWith('/issues') && options.method === 'POST') {
      issueCreated = JSON.parse(options.body);
      return mockResponse(201, { number: 42 });
    }
    throw new Error(`unexpected url ${url}`);
  }, async () => {
    const result = await run({
      INPUT_UPSTREAM_REPO: 'octocat/Hello-World',
      INPUT_GITHUB_TOKEN: '',
      INPUT_STATE_PATH: statePath,
      GITHUB_REPOSITORY: 'me/private-copy',
    });

    assert.equal(result.hasUpdates, true);
    assert.equal(result.newCommits.length, 2);
    assert.equal(result.newCommits[0].sha, 'newsha2222222');
    assert.equal(result.newMergedPrs.length, 1);
    assert.equal(result.newMergedPrs[0].number, 3);
  });

  assert.ok(issueCreated);
  assert.equal(issueCreated.title, 'Upstream updates: octocat/Hello-World');
  assert.match(issueCreated.body, /newsha2/);
  assert.match(issueCreated.body, /New feature/);

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.lastCommitSha, 'newsha2222222');
  assert.equal(state.lastMergedPr.number, 3);
});

test('merge commit collapses feature-branch commits via first-parent walk', async () => {
  const statePath = tmpStatePath();
  fs.writeFileSync(statePath, JSON.stringify({ lastCommitSha: 'old-sha', lastMergedPr: null }));

  // "old-sha" is main's tip before the merge; "feature-2"/"feature-1" only exist on
  // the merged-in branch and must not be walked, since parents[0] is the mainline.
  const commitsBySha = {
    main: {
      sha: 'merge-sha',
      commit: { message: 'Merge pull request #7 from me/feature-x' },
      author: { login: 'bob' },
      html_url: 'https://example.com/merge',
      parents: [{ sha: 'old-sha' }, { sha: 'feature-2' }],
    },
    'old-sha': { sha: 'old-sha', commit: { message: 'old' }, author: { login: 'carol' }, html_url: 'https://example.com/0', parents: [] },
  };

  await withMockFetch(async (url) => {
    const commitMatch = url.match(/\/commits\/([^/?]+)$/);
    if (commitMatch && commitsBySha[commitMatch[1]]) {
      return mockResponse(200, commitsBySha[commitMatch[1]]);
    }
    if (url.includes('/pulls?state=closed') && !url.includes('per_page=50&page')) {
      return mockResponse(200, []);
    }
    throw new Error(`unexpected url ${url}`);
  }, async () => {
    const result = await run({
      INPUT_UPSTREAM_REPO: 'octocat/Hello-World',
      INPUT_GITHUB_TOKEN: '',
      INPUT_STATE_PATH: statePath,
      INPUT_NOTIFY_METHOD: 'none',
      GITHUB_REPOSITORY: 'me/private-copy',
    });

    assert.equal(result.newCommits.length, 1);
    assert.equal(result.newCommits[0].sha, 'merge-sha');
  });
});

test('notify-method none skips notifications but still reports outputs', async () => {
  const statePath = tmpStatePath();
  fs.writeFileSync(statePath, JSON.stringify({ lastCommitSha: 'old-sha', lastMergedPr: null }));

  const commitsBySha = {
    main: { sha: 'new-sha', commit: { message: 'change' }, author: { login: 'bob' }, html_url: 'https://example.com/1', parents: [{ sha: 'old-sha' }] },
    'old-sha': { sha: 'old-sha', commit: { message: 'old' }, author: { login: 'carol' }, html_url: 'https://example.com/0', parents: [] },
  };

  await withMockFetch(async (url, options = {}) => {
    const commitMatch = url.match(/\/commits\/([^/?]+)$/);
    if (commitMatch && commitsBySha[commitMatch[1]]) {
      return mockResponse(200, commitsBySha[commitMatch[1]]);
    }
    if (url.includes('/pulls?state=closed') && !url.includes('per_page=50&page')) {
      return mockResponse(200, []);
    }
    if (options.method === 'POST') {
      throw new Error('should not notify when notify-method is none');
    }
    return mockResponse(200, []);
  }, async () => {
    const result = await run({
      INPUT_UPSTREAM_REPO: 'octocat/Hello-World',
      INPUT_GITHUB_TOKEN: '',
      INPUT_STATE_PATH: statePath,
      INPUT_NOTIFY_METHOD: 'none',
      GITHUB_REPOSITORY: 'me/private-copy',
    });

    assert.equal(result.hasUpdates, true);
    assert.equal(result.newCommits.length, 1);
  });
});

test('rate limit exhaustion produces a clear error', async () => {
  const statePath = tmpStatePath();

  await withMockFetch(async () => mockResponse(403, { message: 'rate limited' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' }), async () => {
    await assert.rejects(
      run({
        INPUT_UPSTREAM_REPO: 'octocat/Hello-World',
        INPUT_GITHUB_TOKEN: '',
        INPUT_STATE_PATH: statePath,
        GITHUB_REPOSITORY: 'me/private-copy',
      }),
      /rate limit/i
    );
  });
});

test('requires upstream-repo input', async () => {
  await assert.rejects(run({ INPUT_STATE_PATH: tmpStatePath() }), /upstream-repo/);
});

test('requires slack-webhook-url when notify-method is slack', async () => {
  await assert.rejects(
    run({
      INPUT_UPSTREAM_REPO: 'octocat/Hello-World',
      INPUT_STATE_PATH: tmpStatePath(),
      INPUT_NOTIFY_METHOD: 'slack',
    }),
    /slack-webhook-url/
  );
});
