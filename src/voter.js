import { MonotonicClock } from './clock.js';

/**
 * 集群中的一个投票节点（锁服务端）。
 *
 * 安全约束：
 * 1. term 全局单调递增，过期 term 的请求一律拒绝；
 * 2. 同一时刻最多为一个 term 授予有效租约，旧租约未过期不得授予新 term；
 * 3. (term, nonce) 做幂等去重，重放的请求得到同一结果且不会延长租约；
 * 4. 租约起始时间若来自未来（超过时钟偏差上限）则拒绝。
 */
export class Voter {
  constructor(nodeId, { clock = new MonotonicClock(), maxClockSkewMs = 0 } = {}) {
    this.nodeId = nodeId;
    this.clock = clock;
    this.maxClockSkewMs = maxClockSkewMs;
    this.currentTerm = 0;
    this.grant = null; // { term, candidateId, nonce, leaseStartMs, ttlMs }
    this.seenRequests = new Map(); // `${term}:${nonce}` => 首次响应
  }

  #grantActive(grant, nowMs) {
    return (
      grant !== null && grant.leaseStartMs + grant.ttlMs - this.maxClockSkewMs > nowMs
    );
  }

  /**
   * 处理 RequestVote / 租约续期请求。
   * 返回 { granted, term, nodeId, reason? }。
   */
  requestVote({ term, candidateId, nonce, leaseStartMs, ttlMs }) {
    if (!Number.isInteger(term) || term <= 0) {
      return { granted: false, term: this.currentTerm, nodeId: this.nodeId, reason: 'bad-term' };
    }
    if (!Number.isFinite(leaseStartMs) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      return { granted: false, term: this.currentTerm, nodeId: this.nodeId, reason: 'bad-lease' };
    }

    const nowMs = this.clock.now();

    // 防重放：同一个 (term, nonce) 永远返回首次的判定，不重复延长租约。
    const dedupeKey = `${term}:${nonce}`;
    if (this.seenRequests.has(dedupeKey)) {
      return this.seenRequests.get(dedupeKey);
    }

    const reject = (reason) => {
      const response = {
        granted: false,
        term: this.currentTerm,
        nodeId: this.nodeId,
        reason,
      };
      this.seenRequests.set(dedupeKey, response);
      return response;
    };

    if (term < this.currentTerm) {
      return reject('stale-term');
    }

    // 租约起点在未来超出偏差上限，说明发起方时钟异常。
    if (leaseStartMs - this.maxClockSkewMs > nowMs) {
      return reject('lease-start-in-future');
    }

    const renewal = term === this.currentTerm;
    if (renewal) {
      // 续期只允许原候选者，且必须仍持有有效租约。
      if (this.grant === null || this.grant.candidateId !== candidateId) {
        return reject('not-grant-holder');
      }
      if (!this.#grantActive(this.grant, nowMs)) {
        return reject('lease-expired');
      }
    } else {
      // 更高 term：旧租约仍有效则拒绝，保证任意时刻最多一个有效 owner。
      if (this.#grantActive(this.grant, nowMs)) {
        return reject('grant-active');
      }
      this.currentTerm = term;
      this.grant = null;
    }

    this.grant = { term, candidateId, nonce, leaseStartMs, ttlMs };
    const response = {
      granted: true,
      term,
      nodeId: this.nodeId,
      leaseStartMs,
      ttlMs,
    };
    this.seenRequests.set(dedupeKey, response);
    return response;
  }

  /**
   * 当前授予是否仍在有效期内（含时钟偏差安全余量）。
   */
  hasActiveGrant(nowMs = this.clock.now()) {
    return this.#grantActive(this.grant, nowMs);
  }

  /**
   * 供不变量检查使用的只读授予信息。
   */
  getActiveGrant(nowMs = this.clock.now()) {
    return this.#grantActive(this.grant, nowMs) ? { ...this.grant } : null;
  }
}

/**
 * 多数派阈值：N 个节点需要 floor(N/2)+1 票。
 */
export function quorumSize(nodeCount) {
  if (!Number.isInteger(nodeCount) || nodeCount <= 0) {
    throw new Error('nodeCount 必须是正整数');
  }
  return Math.floor(nodeCount / 2) + 1;
}
