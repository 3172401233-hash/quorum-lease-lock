import test from 'node:test';
import assert from 'node:assert/strict';
import { Voter, MonotonicClock } from '../src/index.js';
import { Cluster } from './helpers/cluster.js';

const base = {
  term: 1,
  candidateId: 'A',
  nonce: 'n1',
  leaseStartMs: 100,
  ttlMs: 1000,
};

test('同一请求重放返回幂等结果且不会延长租约', () => {
  let now = 100;
  const voter = new Voter('v1', {
    clock: new MonotonicClock(() => now),
    maxClockSkewMs: 50,
  });

  const first = voter.requestVote({ ...base });
  assert.equal(first.granted, true);
  const firstExpiry = voter.getActiveGrant().leaseStartMs + voter.getActiveGrant().ttlMs;

  now = 500;
  const replay = voter.requestVote({ ...base }); // 同 term + 同 nonce
  assert.equal(replay.granted, true);
  const grantAfterReplay = voter.getActiveGrant();
  assert.equal(
    grantAfterReplay.leaseStartMs + grantAfterReplay.ttlMs,
    firstExpiry,
    '重放不得延长租约'
  );
});

test('同 term 不同 nonce 的续期可以延长租约，旧 term 请求被拒绝', () => {
  let now = 100;
  const voter = new Voter('v1', {
    clock: new MonotonicClock(() => now),
    maxClockSkewMs: 50,
  });

  voter.requestVote({ ...base });
  now = 400;
  const renewed = voter.requestVote({ ...base, nonce: 'n2', leaseStartMs: 400 });
  assert.equal(renewed.granted, true);
  assert.equal(voter.getActiveGrant().leaseStartMs, 400);

  // 过期 term 永远拒绝。
  const stale = voter.requestVote({
    term: 1,
    candidateId: 'B',
    nonce: 'n3',
    leaseStartMs: 400,
    ttlMs: 1000,
  });
  assert.equal(stale.granted, false);
  assert.equal(stale.reason, 'not-grant-holder');
});

test('旧 term 的请求无法覆盖更高 term 的授予', () => {
  let now = 100;
  const voter = new Voter('v1', {
    clock: new MonotonicClock(() => now),
    maxClockSkewMs: 50,
  });

  voter.requestVote({ ...base });
  now = 1200; // 租约过期
  voter.requestVote({
    term: 2,
    candidateId: 'B',
    nonce: 'b1',
    leaseStartMs: 1200,
    ttlMs: 1000,
  });
  assert.equal(voter.currentTerm, 2);

  const replayedOld = voter.requestVote({ ...base, nonce: 'n-stale-fresh' });
  assert.equal(replayedOld.granted, false);
  assert.equal(replayedOld.reason, 'stale-term');
  assert.equal(voter.currentTerm, 2);
});

test('网络分区恢复后迟到的旧轮次响应被候选者忽略', () => {
  const cluster = new Cluster(5, ['A', 'B'], {
    ttlMs: 1000,
    safetyMarginMs: 100,
    maxClockSkewMs: 50,
  });

  cluster.partition([
    ['A', 'v1', 'v2'],
    ['B', 'v3', 'v4', 'v5'],
  ]);
  const term1 = cluster.elect('A');
  assert.equal(term1.acquired, false);

  cluster.heal();
  cluster.advance(960); // term1 授予全部过期
  const term2 = cluster.elect('A');
  assert.equal(term2.acquired, true);

  const lock = cluster.locks.get('A');
  // 迟到的 term1 响应（重放包）不应影响 term2 的 owner 状态。
  const votes = lock.handleVote({
    granted: true,
    term: 1,
    nodeId: 'v3',
    leaseStartMs: 0,
    ttlMs: 1000,
  });
  assert.equal(votes, 0);
  assert.equal(lock.isOwner(), true);
  assert.equal(lock.getFencingToken(), 2);
});
