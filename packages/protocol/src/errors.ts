/** Loopsy error codes organized by category */
export enum LoopsyErrorCode {
  // 1xxx - Authentication errors
  AUTH_MISSING_KEY = 1001,
  AUTH_INVALID_KEY = 1002,
  AUTH_EXPIRED_KEY = 1003,

  // 2xxx - Peer errors
  PEER_NOT_FOUND = 2001,
  PEER_OFFLINE = 2002,
  PEER_UNREACHABLE = 2003,
  PEER_HANDSHAKE_FAILED = 2004,
  PEER_VERSION_MISMATCH = 2005,

  // 3xxx - Execution errors
  EXEC_COMMAND_DENIED = 3001,
  EXEC_TIMEOUT = 3002,
  EXEC_MAX_CONCURRENT = 3003,
  EXEC_FAILED = 3004,
  EXEC_CANCELLED = 3005,
  EXEC_JOB_NOT_FOUND = 3006,

  // 4xxx - Transfer errors
  TRANSFER_PATH_DENIED = 4001,
  TRANSFER_FILE_NOT_FOUND = 4002,
  TRANSFER_TOO_LARGE = 4003,
  TRANSFER_CHECKSUM_MISMATCH = 4004,
  TRANSFER_FAILED = 4005,

  // 5xxx - Context errors
  CONTEXT_KEY_NOT_FOUND = 5001,
  CONTEXT_VALUE_TOO_LARGE = 5002,
  CONTEXT_MAX_ENTRIES = 5003,

  // 6xxx - AI Task errors
  AI_TASK_NOT_FOUND = 6001,
  AI_TASK_MAX_CONCURRENT = 6002,
  AI_TASK_FAILED = 6003,
  AI_TASK_ALREADY_COMPLETED = 6004,
  AI_TASK_NO_PENDING_APPROVAL = 6005,
  AI_TASK_CLAUDE_NOT_FOUND = 6006,
  AI_TASK_AGENT_NOT_FOUND = 6007,

  // 9xxx - Internal errors
  INTERNAL_ERROR = 9001,
  RATE_LIMITED = 9002,
  INVALID_REQUEST = 9003,
}

export class LoopsyError extends Error {
  constructor(
    public readonly code: LoopsyErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'LoopsyError';
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}
