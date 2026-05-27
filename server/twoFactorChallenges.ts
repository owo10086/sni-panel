import crypto from "crypto";

type TwoFactorChallenge = {
  userId: number;
  username: string;
  mobile: boolean;
  expiresAt: number;
  attempts: number;
};

const TWO_FACTOR_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS = 5;
const challenges = new Map<string, TwoFactorChallenge>();

function pruneExpired(now = Date.now()) {
  for (const [id, challenge] of challenges) {
    if (challenge.expiresAt <= now) challenges.delete(id);
  }
}

export function createTwoFactorChallenge(input: { userId: number; username: string; mobile?: boolean }) {
  pruneExpired();
  const challengeId = crypto.randomBytes(24).toString("hex");
  challenges.set(challengeId, {
    userId: input.userId,
    username: input.username,
    mobile: !!input.mobile,
    expiresAt: Date.now() + TWO_FACTOR_CHALLENGE_TTL_MS,
    attempts: 0,
  });
  return {
    challengeId,
    expiresInSeconds: Math.floor(TWO_FACTOR_CHALLENGE_TTL_MS / 1000),
  };
}

export function getTwoFactorChallenge(challengeId: string) {
  const challenge = challenges.get(challengeId);
  if (!challenge) return null;
  if (challenge.expiresAt <= Date.now()) {
    challenges.delete(challengeId);
    return null;
  }
  return challenge;
}

export function clearTwoFactorChallenge(challengeId: string) {
  challenges.delete(challengeId);
}

export function recordTwoFactorChallengeFailure(challengeId: string) {
  const challenge = getTwoFactorChallenge(challengeId);
  if (!challenge) return false;
  challenge.attempts += 1;
  if (challenge.attempts >= TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS) {
    challenges.delete(challengeId);
    return false;
  }
  return true;
}
