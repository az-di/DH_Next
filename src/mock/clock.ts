/**
 * Wall-clock time plus an offset the /mock fast-forward controls push ahead.
 * Passed to the coordinator as `now`, the same injection the tests use for
 * their fake clock, so reminders and deadlines fire on simulated time.
 */
export class MockClock {
  private offsetMs = 0;

  now = (): Date => new Date(Date.now() + this.offsetMs);

  advance(ms: number) {
    this.offsetMs += ms;
  }

  reset() {
    this.offsetMs = 0;
  }
}
