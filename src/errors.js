export class LockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockError';
  }
}

export class NotOwnerError extends LockError {
  constructor(message = '当前节点不是锁的有效持有者') {
    super(message);
    this.name = 'NotOwnerError';
  }
}

export class LeaseExpiredError extends LockError {
  constructor(message = '租约已过期') {
    super(message);
    this.name = 'LeaseExpiredError';
  }
}

export class StaleFencingTokenError extends LockError {
  constructor(resource, seenToken, rejectedToken) {
    super(
      `资源 ${resource} 拒绝旧 fencing token ${rejectedToken}，已接受过 ${seenToken}`
    );
    this.name = 'StaleFencingTokenError';
    this.resource = resource;
    this.seenToken = seenToken;
    this.rejectedToken = rejectedToken;
  }
}
