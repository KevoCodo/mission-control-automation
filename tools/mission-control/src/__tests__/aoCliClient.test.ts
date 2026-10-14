import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAoCliClient, parseAoReviewList } from '../aoCliClient.js';
import { defaultConfig } from '../config.js';

let tempDirectory: string;

beforeEach(async () => {
  tempDirectory = await mkdtemp(path.join(process.cwd(), '.tmp-mission-control-ao-cli-'));
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

describe('AO CLI native review lookup', () => {
  it('parses completed review list output for the exact PR and head without claiming reviewer independence', () => {
    const run = parseAoReviewList(
      JSON.stringify({
        reviews: [
          {
            prUrl: 'https://github.com/KevoCodo/ai-delivery-lab/pull/19',
            prNumber: 19,
            targetSha: 'head-9',
            status: 'completed',
            latestRun: {
              id: 'review-run-1',
              sessionId: 'review-session',
              harness: 'codex',
              prUrl: 'https://github.com/KevoCodo/ai-delivery-lab/pull/19',
              targetSha: 'head-9',
              status: 'completed',
              verdict: 'approved',
              body: 'Looks good.'
            }
          }
        ]
      }),
      19,
      'head-9'
    );

    expect(run).toMatchObject({
      runId: 'review-run-1',
      pullRequestNumber: 19,
      headSha: 'head-9',
      status: 'completed',
      verdict: 'approved',
      diagnosticCode: 'AO_REVIEW_REVIEWER_INDEPENDENCE_UNVERIFIED',
      source: 'ao-review-list',
      reviewer: {
        id: 'review-session',
        displayName: 'codex',
        type: 'unknown',
        independent: false,
        provenance: 'unsupported'
      }
    });
  });

  it('fails closed on unsupported review list JSON shapes', () => {
    const run = parseAoReviewList(JSON.stringify({ entries: [] }), 19, 'head-9');

    expect(run).toMatchObject({
      status: 'unavailable',
      diagnosticCode: 'AO_REVIEW_LIST_UNSUPPORTED_SHAPE'
    });
  });

  it('fails closed when the PR entry is missing or duplicated', () => {
    expect(parseAoReviewList(JSON.stringify({ reviews: [] }), 19, 'head-9')).toMatchObject({
      diagnosticCode: 'AO_REVIEW_LIST_PR_MISSING'
    });
    expect(
      parseAoReviewList(
        JSON.stringify({
          reviews: [
            { prNumber: 19, targetSha: 'head-9' },
            { prUrl: 'https://github.com/KevoCodo/ai-delivery-lab/pull/19', targetSha: 'head-9' }
          ]
        }),
        19,
        'head-9'
      )
    ).toMatchObject({ diagnosticCode: 'AO_REVIEW_LIST_PR_DUPLICATE' });
  });

  it('fails closed when review list or latest run targets a different SHA or PR', () => {
    expect(parseAoReviewList(JSON.stringify({ reviews: [{ prNumber: 19, targetSha: 'old-head' }] }), 19, 'head-9')).toMatchObject({
      status: 'unavailable',
      diagnosticCode: 'AO_REVIEW_LIST_SHA_MISMATCH'
    });
    expect(
      parseAoReviewList(
        JSON.stringify({
          reviews: [
            {
              prNumber: 19,
              prUrl: 'https://github.com/KevoCodo/ai-delivery-lab/pull/19',
              targetSha: 'head-9',
              latestRun: {
                id: 'review-run-1',
                prUrl: 'https://github.com/KevoCodo/ai-delivery-lab/pull/20',
                targetSha: 'head-9',
                status: 'completed'
              }
            }
          ]
        }),
        19,
        'head-9'
      )
    ).toMatchObject({ diagnosticCode: 'AO_REVIEW_RUN_PR_MISMATCH' });
  });

  it('reports missing latest run as not-started evidence instead of inventing approval', () => {
    const run = parseAoReviewList(JSON.stringify({ reviews: [{ prNumber: 19, targetSha: 'head-9', status: 'needs_review' }] }), 19, 'head-9');

    expect(run).toMatchObject({
      status: 'not-started',
      diagnosticCode: 'AO_REVIEW_RUN_MISSING'
    });
  });

  it.each([
    ['approved', 'approved'],
    ['changes_requested', 'changes-requested'],
    ['rejected', 'changes-requested'],
    ['mystery', 'unknown'],
    [undefined, 'unknown']
  ] as const)('preserves completed verdict %s without inferring independence', (rawVerdict, expected) => {
    const run = parseAoReviewList(JSON.stringify({ reviews: [{
      prNumber: 19, prUrl: 'https://github.com/KevoCodo/ai-delivery-lab/pull/19', targetSha: 'head-9',
      latestRun: {
        id: 'run-1', prUrl: 'https://github.com/KevoCodo/ai-delivery-lab/pull/19',
        targetSha: 'head-9', status: 'completed', verdict: rawVerdict
      }
    }] }), 19, 'head-9', defaultConfig.repository);
    expect(run).toMatchObject({ runId: 'run-1', headSha: 'head-9', verdict: expected });
    expect(run.reviewer?.independent).toBe(false);
  });

  it('rejects the wrong repository even when PR number and SHA match', () => {
    const run = parseAoReviewList(JSON.stringify({ reviews: [{
      prNumber: 19, prUrl: 'https://github.com/Other/repo/pull/19', targetSha: 'head-9'
    }] }), 19, 'head-9', defaultConfig.repository);
    expect(run).toMatchObject({ status: 'unavailable', diagnosticCode: 'AO_REVIEW_LIST_REPOSITORY_MISMATCH' });
  });

  it('keeps a running approval field and stale approved run from becoming current approval', () => {
    const review = (status: string, targetSha: string) => JSON.stringify({ reviews: [{
      prNumber: 19, prUrl: 'https://github.com/KevoCodo/ai-delivery-lab/pull/19', targetSha: 'head-9',
      latestRun: { id: 'run-1', prUrl: 'https://github.com/KevoCodo/ai-delivery-lab/pull/19', targetSha, status, verdict: 'approved' }
    }] });
    expect(parseAoReviewList(review('running', 'head-9'), 19, 'head-9', defaultConfig.repository)).toMatchObject({ status: 'running', verdict: 'approved' });
    expect(parseAoReviewList(review('completed', 'old-head'), 19, 'head-9', defaultConfig.repository)).toMatchObject({ status: 'unavailable', diagnosticCode: 'AO_REVIEW_RUN_SHA_MISMATCH' });
  });

  it('uses only review ls --json for concrete run lookup and never invokes review trigger', async () => {
    const calls: string[][] = [];
    const client = createAoCliClient({
      cwd: tempDirectory,
      async runCommand(args) {
        calls.push(args);
        return JSON.stringify({
          reviews: [
            {
              prNumber: 19,
              prUrl: 'https://github.com/KevoCodo/ai-delivery-lab/pull/19',
              targetSha: 'head-9',
              status: 'completed',
              latestRun: {
                id: 'review-run-1',
                prUrl: 'https://github.com/KevoCodo/ai-delivery-lab/pull/19',
                targetSha: 'head-9',
                status: 'completed',
                verdict: 'approved'
              }
            }
          ]
        });
      }
    });
    const run = await client.getNativeReviewRun!({
      repository: defaultConfig.repository,
      pullRequestNumber: 19,
      headSha: 'head-9'
    });

    expect(run.runId).toBe('review-run-1');
    expect(calls).toEqual([['review', 'ls', '--json']]);
    expect(calls.flat()).not.toContain('trigger');
  });
});
