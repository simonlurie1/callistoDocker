import type { ConversionEvent } from "../domain/models";
import type { ConversionEventRepository, PostingCriteria } from "../repositories/ConversionEventRepository";
import type { LeadRepository } from "../repositories/LeadRepository";
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
  /** Leads found "converted" with no conversion_events row, for which the
   * missing pending event was created (see LeadRepository.findConvertedWithoutEvent).
   * Should normally be empty. */
  reconciledLeadIds: number[];
  /** Orphaned leads whose repair itself failed; retried next pass. */
  reconcileErrors: { leadId: number; error: unknown }[];
  /** Events that needed posting when the pass started. */
  found: number;
  /** Events this pass claimed and posted, with their recorded outcome. */
  posted: ConversionEvent[];
  /** Events another worker claimed first. */
  skipped: number;
  /** Claimed and posted, but this worker's claim went stale and was taken
   * over before the outcome could be recorded. The post to the tracker
   * still happened (harmless if duplicated — event_id is idempotent); only
   * this worker's bookkeeping of it was dropped, since the new owner
   * records its own outcome. */
  lostClaimEventIds: string[];
  /** Candidates that hit an error (DB or tracker) while being claimed or
   * posted. Left as-is; picked up again on a later pass. */
  errors: { eventId: string; error: unknown }[];
}

/**
 * Posts pending conversions to the tracker in periodic passes. Each event is
 * claimed (status in_process + processingStartedAt) before it is posted, so
 * any number of workers can run passes concurrently without posting the same
 * event twice. Reports what happened; logging it is the caller's job.
 */
export class ConversionBatchService {
  constructor(
    private readonly events: ConversionEventRepository,
    private readonly leads: LeadRepository,
    private readonly conversions: ConversionService,
    private readonly options: ConversionBatchOptions
  ) {}

  async runOnce(shouldStop: () => boolean = () => false): Promise<BatchResult> {
    const { reconciledLeadIds, reconcileErrors } = await this.reconcileOrphanedConversions();

    const due = await this.events.findDueForPosting(this.criteria(), this.options.batchSize);
    const posted: ConversionEvent[] = [];
    const lostClaimEventIds: string[] = [];
    const errors: BatchResult["errors"] = [];
    let skipped = 0;

    for (const candidate of due) {
      if (shouldStop()) break;
      try {
        // Criteria are recomputed per claim: posts within a pass are spaced
        // out by the tracker's rate limit, so `now` must be the actual claim time.
        const claimed = await this.events.claimForPosting(candidate.id, this.criteria());
        if (!claimed) {
          skipped++;
          continue;
        }
        const outcome = await this.conversions.attemptSend(claimed);
        if (outcome === null) {
          lostClaimEventIds.push(candidate.eventId);
          continue;
        }
        posted.push(outcome);
      } catch (error) {
        // A DB or tracker error on THIS candidate (e.g. the database drops
        // mid-pass) must not abort the rest of the pass. The event is left
        // exactly as it was — still pending/due-failed, or in_process and
        // recoverable once that claim goes stale — and is retried later.
        errors.push({ eventId: candidate.eventId, error });
      }
    }

    return { reconciledLeadIds, reconcileErrors, found: due.length, posted, skipped, lostClaimEventIds, errors };
  }

  /**
   * Self-healing step, run at the start of every pass: a lead can end up
   * "converted" with no conversion_events row if the process crashed
   * between updating its status and recording the event (two separate
   * writes, not one transaction). This creates the missing pending event so
   * the normal scan/claim/post above picks it up this same pass.
   */
  private async reconcileOrphanedConversions(): Promise<Pick<BatchResult, "reconciledLeadIds" | "reconcileErrors">> {
    const reconciledLeadIds: number[] = [];
    const reconcileErrors: BatchResult["reconcileErrors"] = [];
    for (const lead of await this.leads.findConvertedWithoutEvent()) {
      try {
        await this.conversions.recordConversion(lead);
        reconciledLeadIds.push(lead.id);
      } catch (error) {
        reconcileErrors.push({ leadId: lead.id, error });
      }
    }
    return { reconciledLeadIds, reconcileErrors };
  }

  private criteria(): PostingCriteria {
    const now = new Date();
    return { now, staleBefore: new Date(now.getTime() - this.options.staleAfterMs) };
  }
}
