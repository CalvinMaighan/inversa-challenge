/**
 * Decides when an async result may be spoken without stepping on the user.
 * Blocked while the user is speaking, while a user turn is still pending a
 * reply, or while any response audio is still queued or playing.
 *
 * Ported from deedee (originally qwen-audio-agent `AnnouncementWindow`).
 */
export type AnnouncementOrigin = "turn" | "announcement";

export class AnnouncementWindow {
  private userSpeaking = false;
  private activeTurnId = "";
  private turnPending = false;
  private readonly audioResponses = new Map<string, { turnId: string; origin: AnnouncementOrigin }>();
  private readonly playingResponses = new Set<string>();

  beginTurn(turnId: string): void {
    this.userSpeaking = true;
    this.activeTurnId = turnId;
    this.turnPending = true;
  }

  endSpeech(): void {
    this.userSpeaking = false;
  }

  /** A response finished without audio; a turn reply closes the pending window. */
  responseDone(input: {
    turnId: string;
    origin?: AnnouncementOrigin;
    hasAudio?: boolean;
    awaitsToolFollowUp?: boolean;
  }): void {
    if (
      (input.origin ?? "turn") === "announcement" ||
      input.turnId !== this.activeTurnId ||
      input.hasAudio ||
      input.awaitsToolFollowUp
    ) {
      return;
    }
    this.turnPending = false;
  }

  queueAudio(responseId: string, context: { turnId: string; origin: AnnouncementOrigin }): void {
    if (!responseId) return;
    this.audioResponses.set(responseId, context);
  }

  startPlayback(responseId: string): void {
    if (responseId) this.playingResponses.add(responseId);
  }

  finishPlayback(responseId: string, opts: { awaitsToolFollowUp?: boolean } = {}): void {
    const context = this.audioResponses.get(responseId);
    this.audioResponses.delete(responseId);
    this.playingResponses.delete(responseId);
    if (
      context &&
      context.origin !== "announcement" &&
      context.turnId &&
      context.turnId === this.activeTurnId &&
      !opts.awaitsToolFollowUp
    ) {
      this.turnPending = false;
    }
  }

  interrupt(): void {
    this.turnPending = false;
    this.audioResponses.clear();
    this.playingResponses.clear();
  }

  reset(): void {
    this.userSpeaking = false;
    this.activeTurnId = "";
    this.turnPending = false;
    this.audioResponses.clear();
    this.playingResponses.clear();
  }

  isBlocked(): boolean {
    return this.userSpeaking || this.turnPending || this.audioResponses.size > 0;
  }

  isPlaying(): boolean {
    return this.playingResponses.size > 0;
  }

  currentTurnId(): string {
    return this.activeTurnId;
  }
}
