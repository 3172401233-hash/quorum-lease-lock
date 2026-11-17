import { MonotonicClock } from './clock.js';
import { quorumSize } from './voter.js';
import { LeaseExpiredError, NotOwnerError } from './errors.js';

/**
 * 分布式租约锁的候选者/持有者。
 *
 * 生命周期：startElection -> 向 Voter 发 requestVote -> handleVote 收票 ->
 * 达到多数派后 tryAcquire 成为 owner -> renew 续租 -> stepDown/过期释放。
 *
 * fencing token 即当选 term（全局单调递增）。owner 每次下游写入都必须携带，
 * 下游资源（FencedResource）拒绝任何不大于已观测值的 token。
 */
export class LeaseLock {
  constructor(
    nodeId,
    nodeCount,
    {
      clock = new MonotonicClock(),
      ttlMs = 10_000,
      // 本地保守安全余量：本地判定的有效期比服务端租约提前 safetyMarginMs 结束，
      // 用于吸收时钟漂移、网络与调度抖动。
      safetyMarginMs = Math.floor(ttlMs / 10),
      // 可接受的节点间时钟漂移上限，同时下发给投票侧做未来时间校验。
      maxClockSkewMs = Math.floor(ttlMs / 20),
    } = {}
  ) {
    if (safetyMarginMs >= ttlMs) {
      throw new Error('safetyMarginMs 必须小于 ttlMs');
    }
    if (maxClockSkewMs > safetyMarginMs) {
      throw new Error('maxClockSkewMs 不应超过 safetyMarginMs');
    }
    this.nodeId = nodeId;
    this.nodeCount = nodeCount;
    this.quorum = quorumSize(nodeCount);
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.safetyMarginMs = safetyMarginMs;
    this.maxClockSkewMs = maxClockSkewMs;

    this.term = 0;
    this.election = null; // 进行中的选举状态
    this.owner = null; // { term, leaseStartMs, ttlMs }
  }

  /**
   * 发起新一届选举，返回需要广播给所有 Voter 的请求体。
   */
  startElection() {
    this.term += 1;
    this.election = {
      term: this.term,
      nonce: `${this.nodeId}-${this.term}-${this.clock.now()}`,
      leaseStartMs: this.clock.now(),
      grantedBy: new Set(),
      rejectedBy: new Set(),
    };
    return {
      term: this.election.term,
      candidateId: this.nodeId,
      nonce: this.election.nonce,
      leaseStartMs: this.election.leaseStartMs,
      ttlMs: this.ttlMs,
    };
  }

  /**
   * 处理一个 Voter 的响应。返回当前已获得的票数。
   */
  handleVote(response) {
    if (!this.election || response.term !== this.election.term) {
      // 过期轮次的响应（迟到的包、重放）直接忽略。
      return this.election ? this.election.grantedBy.size : 0;
    }
    if (response.granted) {
      this.election.grantedBy.add(response.nodeId);
    } else {
      this.election.rejectedBy.add(response.nodeId);
      // 对端见过更高 term，让位，避免无效竞选。
      if (typeof response.term === 'number' && response.term > this.term) {
        this.term = response.term;
        this.election = null;
        this.owner = null;
      }
    }
    return this.election ? this.election.grantedBy.size : 0;
  }

  /**
   * 收票达到多数派且租约仍然有效时成为 owner，返回 owner 状态；否则返回 null。
   */
  tryAcquire() {
    if (!this.election) {
      return null;
    }
    if (this.election.grantedBy.size < this.quorum) {
      return null;
    }
    const { term, leaseStartMs } = this.election;
    if (!this.#leaseLocallyValid(leaseStartMs, this.ttlMs, this.clock.now())) {
      // 收票耗时过长，本地视角租约已接近过期，放弃并要求重新选举。
      this.election = null;
      return null;
    }
    this.owner = { term, leaseStartMs, ttlMs: this.ttlMs };
    this.election = null;
    return { ...this.owner };
  }

  #leaseLocallyValid(leaseStartMs, ttlMs, nowMs = this.clock.now()) {
    // 本地有效期 = ttl - 安全余量，宁可早放弃也不冒险写入。
    return leaseStartMs + ttlMs - this.safetyMarginMs > nowMs;
  }

  /**
   * 当前是否自认为有效 owner（本地视角，已扣除安全余量）。
   */
  isOwner(nowMs = this.clock.now()) {
    return this.owner !== null && this.#leaseLocallyValid(
      this.owner.leaseStartMs,
      this.owner.ttlMs,
      nowMs
    );
  }

  /**
   * 返回 fencing token；非有效 owner 或租约过期时抛错。
   */
  getFencingToken() {
    if (!this.owner) {
      throw new NotOwnerError();
    }
    if (!this.isOwner()) {
      throw new LeaseExpiredError();
    }
    return this.owner.term;
  }

  /**
   * 构造续期请求（仅有效 owner 可调用）。
   */
  buildRenewalRequest() {
    if (!this.owner) {
      throw new NotOwnerError();
    }
    if (!this.isOwner()) {
      throw new LeaseExpiredError();
    }
    return {
      term: this.owner.term,
      candidateId: this.nodeId,
      nonce: `${this.nodeId}-${this.owner.term}-renew-${this.clock.now()}`,
      leaseStartMs: this.clock.now(),
      ttlMs: this.ttlMs,
    };
  }

  /**
   * 收集续期响应。达到多数派则延长本地租约，返回是否续期成功。
   * 续期失败不会立即剥夺 owner 身份——剩余租约期内仍受 fencing 保护，
   * 调用方应停止写下游并等待 stepDown/过期或重试。
   */
  handleRenewalResponses(responses) {
    if (!this.owner) {
      return false;
    }
    const term = this.owner.term;
    let granted = 0;
    let leaseStartMs = Infinity;
    let ttlMs = this.owner.ttlMs;
    for (const response of responses) {
      if (response.granted && response.term === term) {
        granted += 1;
        leaseStartMs = Math.min(leaseStartMs, response.leaseStartMs);
        ttlMs = response.ttlMs;
      } else if (typeof response.term === 'number' && response.term > this.term) {
        this.term = response.term;
        this.stepDown();
        return false;
      }
    }
    if (granted < this.quorum) {
      return false;
    }
    this.owner = { term, leaseStartMs, ttlMs };
    return true;
  }

  /**
   * 主动放弃 owner 身份。
   */
  stepDown() {
    this.owner = null;
    this.election = null;
  }

  /**
   * 带 fencing token 写下游资源；非 owner/过期/旧 token 都会被拒绝。
   */
  async writeDownstream(resource, payload) {
    const token = this.getFencingToken();
    return resource.write(token, payload, { writer: this.nodeId });
  }

  getState() {
    return {
      nodeId: this.nodeId,
      term: this.term,
      isOwner: this.isOwner(),
      fencingToken: this.owner ? this.owner.term : null,
      leaseStartMs: this.owner ? this.owner.leaseStartMs : null,
    };
  }
}
