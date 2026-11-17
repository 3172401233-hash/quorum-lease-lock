import assert from 'node:assert/strict';
import { Voter, LeaseLock, quorumSize } from '../../src/index.js';

/**
 * 虚拟单调时钟：localNow = 虚拟时间 * rate + offset。
 * rate 模拟时钟走速漂移，offset 模拟节点间固定偏差。
 */
export class VirtualClock {
  constructor(rate = 1, offset = 0) {
    this.rate = rate;
    this.offset = offset;
    this.virtualMs = 0;
  }

  now() {
    return this.virtualMs * this.rate + this.offset;
  }

  advance(ms) {
    this.virtualMs += ms;
  }
}

/**
 * 测试集群：N 个 Voter + 若干候选者，支持网络分区与统一推进时间。
 */
export class Cluster {
  constructor(
    nodeCount,
    candidateIds,
    {
      ttlMs = 1000,
      safetyMarginMs = 100,
      maxClockSkewMs = 50,
      clockRates = {},
      clockOffsets = {},
    } = {}
  ) {
    this.nodeCount = nodeCount;
    this.quorum = quorumSize(nodeCount);
    this.ttlMs = ttlMs;
    this.safetyMarginMs = safetyMarginMs;
    this.maxClockSkewMs = maxClockSkewMs;
    this.clocks = new Map();
    this.voters = new Map();
    this.locks = new Map();
    this.groups = null; // null 表示全网互通，否则为分组数组

    const allIds = [
      ...Array.from({ length: nodeCount }, (_, i) => `v${i + 1}`),
      ...candidateIds,
    ];
    for (const id of allIds) {
      this.clocks.set(
        id,
        new VirtualClock(clockRates[id] ?? 1, clockOffsets[id] ?? 0)
      );
    }
    for (let i = 0; i < nodeCount; i += 1) {
      const id = `v${i + 1}`;
      this.voters.set(
        id,
        new Voter(id, {
          clock: this.clocks.get(id),
          maxClockSkewMs,
        })
      );
    }
    for (const id of candidateIds) {
      this.locks.set(
        id,
        new LeaseLock(id, nodeCount, {
          clock: this.clocks.get(id),
          ttlMs,
          safetyMarginMs,
          maxClockSkewMs,
        })
      );
    }
  }
  advance(ms) {
    for (const clock of this.clocks.values()) {
      clock.advance(ms);
    }
  }

  /**
   * 按组分区：同组内互通，跨组隔离。
   */
  partition(groups) {
    this.groups = groups.map((group) => new Set(group));
  }

  heal() {
    this.groups = null;
  }

  connected(a, b) {
    if (!this.groups) return true;
    return this.groups.some((group) => group.has(a) && group.has(b));
  }

  send(candidateId, request) {
    const responses = [];
    for (const voter of this.voters.values()) {
      if (this.connected(candidateId, voter.nodeId)) {
        responses.push(voter.requestVote(request));
      }
    }
    return responses;
  }

  elect(candidateId) {
    const lock = this.locks.get(candidateId);
    const request = lock.startElection();
    const responses = this.send(candidateId, request);
    let votes = 0;
    for (const response of responses) {
      votes = lock.handleVote(response);
    }
    const owner = lock.tryAcquire();
    return { acquired: owner !== null, votes, owner, responses };
  }

  renew(candidateId) {
    const lock = this.locks.get(candidateId);
    if (!lock.isOwner()) {
      return { renewed: false, reason: 'not-owner', responses: [] };
    }
    const request = lock.buildRenewalRequest();
    const responses = this.send(candidateId, request);
    const renewed = lock.handleRenewalResponses(responses);
    return { renewed, responses };
  }

  /**
   * term -> 仍持有该 term 有效授予的 voter 数（按各 voter 本地时钟判定）。
   */
  activeTermCounts() {
    const counts = new Map();
    for (const voter of this.voters.values()) {
      const grant = voter.getActiveGrant();
      if (grant) {
        counts.set(grant.term, (counts.get(grant.term) ?? 0) + 1);
      }
    }
    return counts;
  }

  /**
   * 核心不变量：任意时刻达到多数派的有效 term 至多一个。
   */
  assertAtMostOneOwner() {
    const ownerTerms = [...this.activeTermCounts()].filter(
      ([, count]) => count >= this.quorum
    );
    assert.ok(
      ownerTerms.length <= 1,
      `检测到多个同时有效 owner: ${JSON.stringify(ownerTerms)}`
    );
    return ownerTerms;
  }
}

/**
 * 确定性伪随机数，便于随机测试可复现。
 */
export function mulberry32(seed) {
  let state = seed;
  return function random() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
