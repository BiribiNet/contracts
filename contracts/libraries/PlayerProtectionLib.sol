// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Wallet-local, per-vault voluntary limits. Amounts are gross stakes, never net losses.
library PlayerProtectionLib {
    struct Limits {
        uint256 dailyLimit;
        uint256 spent;
        uint64 spentDay;
        uint64 sessionStartedAt;
        uint32 sessionSeconds;
        uint64 excludedUntil;
        uint256 pendingDailyLimit;
        uint32 pendingSessionSeconds;
        uint64 changesAt;
    }

    error InvalidPlayerLimits();
    error PlayerSelfExcluded(uint64 until);
    error PlayerDailyLimitExceeded();
    error PlayerSessionExpired(uint64 resumeAt);

    event PlayerLimitsChanged(address indexed player, uint256 dailyLimit, uint32 sessionSeconds,
        uint256 pendingDailyLimit, uint32 pendingSessionSeconds, uint64 changesAt);
    event PlayerExcluded(address indexed player, uint64 until);
    event PlayerStakeRecorded(address indexed player, uint256 spent, uint64 spentDay, uint64 sessionStartedAt);

    function effective(Limits storage s) internal view returns (Limits memory p) {
        p = s;
        if (p.changesAt != 0 && block.timestamp >= p.changesAt) {
            p.dailyLimit = p.pendingDailyLimit;
            p.sessionSeconds = p.pendingSessionSeconds;
            p.pendingDailyLimit = 0;
            p.pendingSessionSeconds = 0;
            p.changesAt = 0;
        }
        if (p.spentDay != block.timestamp / 1 days) p.spent = 0;
    }

    function applyMatured(Limits storage s, address player) private {
        if (s.changesAt != 0 && block.timestamp >= s.changesAt) {
            s.dailyLimit = s.pendingDailyLimit;
            s.sessionSeconds = s.pendingSessionSeconds;
            s.pendingDailyLimit = 0;
            s.pendingSessionSeconds = 0;
            s.changesAt = 0;
            emitChanged(s, player);
        }
    }

    function emitChanged(Limits storage s, address player) private {
        emit PlayerLimitsChanged(player, s.dailyLimit, s.sessionSeconds,
            s.pendingDailyLimit, s.pendingSessionSeconds, s.changesAt);
    }

    function configure(Limits storage s, uint256 cap, uint32 duration) internal {
        if (cap == 0 || duration < 60 || duration > 1 days) revert InvalidPlayerLimits();
        applyMatured(s, msg.sender);
        if (s.dailyLimit == 0) {
            s.dailyLimit = cap;
            s.sessionSeconds = duration;
        } else {
            // Tightening either dimension is immediate; loosening waits a full day.
            if (cap < s.dailyLimit) s.dailyLimit = cap;
            if (duration < s.sessionSeconds) s.sessionSeconds = duration;
        }
        if (cap > s.dailyLimit || duration > s.sessionSeconds) {
            s.pendingDailyLimit = cap;
            s.pendingSessionSeconds = duration;
            s.changesAt = uint64(block.timestamp + 1 days);
        } else {
            s.pendingDailyLimit = 0;
            s.pendingSessionSeconds = 0;
            s.changesAt = 0;
        }
        // Never reset spend or session timestamps when changing limits.
        emitChanged(s, msg.sender);
    }

    function exclude(Limits storage s, uint32 duration) internal {
        if (duration < 1 days || duration > 365 days) revert InvalidPlayerLimits();
        uint64 until = uint64(block.timestamp + duration);
        if (until <= s.excludedUntil) revert InvalidPlayerLimits();
        s.excludedUntil = until;
        emit PlayerExcluded(msg.sender, until);
    }

    function consume(Limits storage s, address player, uint256 amount) internal {
        if (block.timestamp < s.excludedUntil) revert PlayerSelfExcluded(s.excludedUntil);
        applyMatured(s, player);
        uint64 day = uint64(block.timestamp / 1 days);
        if (s.spentDay != day) {
            s.spentDay = day;
            s.spent = 0;
        }
        // Rolling 24-hour sessions do not restart at midnight or after a reload.
        if (s.sessionStartedAt == 0 || block.timestamp >= uint256(s.sessionStartedAt) + 1 days) {
            s.sessionStartedAt = uint64(block.timestamp);
        }
        if (s.dailyLimit != 0) {
            if (s.spent > s.dailyLimit || amount > s.dailyLimit - s.spent) revert PlayerDailyLimitExceeded();
            if (block.timestamp >= uint256(s.sessionStartedAt) + s.sessionSeconds) {
                revert PlayerSessionExpired(s.sessionStartedAt + uint64(1 days));
            }
        }
        s.spent += amount;
        emit PlayerStakeRecorded(player, s.spent, s.spentDay, s.sessionStartedAt);
    }
}
