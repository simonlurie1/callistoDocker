import type { ConversionEvent } from "../domain/models";
import type { ConversionEventRepository, PostingCriteria } from "../repositories/ConversionEventRepository";
import type { ConversionService } from "./conversionService";

export interface ConversionBatchOptions {
  /** Max events picked up per pass. */
  batchSize: number;
  /** How long an in_process claim may last before it's considered abandoned
   * (worker crashed mid-post) and the event is posted again. Must exceed the
   * longest possible post (rate-limit wait + tracker timeout). */
  staleAfterMs: number;
}

export interface BatchResult {
  /** Events that needed posting when the pass started. */
  found: number;
  /** Events this pass claimed and posted, with their recorded outcome. */
  posted: ConversionEvent[];
  /** Events another worker claimed first. */
  skipped: number;
}

/**
 * Posts pending conversions to the tracker in periodic passes. Each event is
 * claimed (status in_process + processingStartedAt) before it is posted, so
 * any number of workers can run passes concurrently without posting the same
 * event twice.
 */
export class ConversionBatchService {
  constructor(
    private readonly events: ConversionEventRepository,
    private readonly conversions: ConversionService,
    private readonly options: ConversionBatchOptions
  ) {}

  async runOnce(shouldStop: () => boolean = () => false): Promise<BatchResult> {
    const due = await this.events.findDueForPosting(this.criteria(), this.options.batchSize);
    const posted: ConversionEvent[] = [];
    let skipped = 0;

    for (const candidate of due) {
      if (shouldStop()) break;
      // Criteria are recomputed per claim: posts within a pass are spaced out
      // by the tracker's rate limit, so `now` must be the actual claim time.
      const claimed = await this.events.claimForPosting(candidate.id, this.criteria());
      if (!claimed) {
        skipped++;
        continue;
      }
      // If this throws (e.g. the database is unreachable), the event stays
      // in_process and is picked up again once the claim goes stale.
      posted.push(await this.conversions.attemptSend(claimed));
    }

    return { found: due.length, posted, skipped };
  }

  private criteria(): PostingCriteria {
    const now = new Date();
    return { now, staleBefore: new Date(now.getTime() - this.options.staleAfterMs) };
  }
}
